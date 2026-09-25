import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, persistEnabled, type AntiLoopConfig } from "./config";
import {
  extractAssistantText,
  extractAssistantThinking,
  extractStopInfo,
  findGhostToolCall,
  ghostToolSteer,
  HARD_STOP_MSG,
  hasStuckPhrase,
  isOutputTruncated,
  isThinkingLoop,
  REPEAT_STEER,
  STUCK_STEER,
  stuckPhraseRepeatCount,
  THINKING_LOOP_STEER,
  toolFingerprint,
  TRUNCATION_STEER,
} from "./detect";
import { ANTI_LOOP_PROCEDURE } from "./procedure";
import {
  isEditTool,
  lastRecoveryUsesUserHelp,
  shouldNotifyApproachChurn,
  USER_HELP_PROCEDURE,
  USER_HELP_PROMPT,
  USER_HELP_STEER,
  type RecoveryKind,
} from "./user-help";

export default function (pi: ExtensionAPI) {
  let configCache: AntiLoopConfig | null = null;
  let lastFingerprint: string | null = null;
  let identicalStreak = 0;
  let recoveries = 0;
  let hardStopped = false;
  let steeredThisTurn = false;
  let thinkingLoopFired = false;
  /** Bumped on hard stop so deferred followUps from earlier recoveries are dropped. */
  let recoveryEpoch = 0;

  const uniqueFingerprints = new Set<string>();
  let editCount = 0;
  let churnNotifiedThisTurn = false;

  /** Consume on before_agent_start to enter user-help for that turn. */
  let pendingUserHelp = false;
  /** Inject USER_HELP_PROCEDURE while true. */
  let userHelpActive = false;
  let userHelpSawEdit = false;
  let userHelpAnnounced = false;

  function cfg(ctx: ExtensionContext): AntiLoopConfig {
    if (!configCache) configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  /** Reset per-turn counters. Does not clear hardStopped or user-help. */
  function resetTurnCounters() {
    lastFingerprint = null;
    identicalStreak = 0;
    recoveries = 0;
    steeredThisTurn = false;
    thinkingLoopFired = false;
    uniqueFingerprints.clear();
    editCount = 0;
    churnNotifiedThisTurn = false;
  }

  function clearHardStop() {
    hardStopped = false;
    resetTurnCounters();
  }

  function clearUserHelp() {
    pendingUserHelp = false;
    userHelpActive = false;
    userHelpSawEdit = false;
    userHelpAnnounced = false;
  }

  function armUserHelp() {
    pendingUserHelp = true;
  }

  function userHelpEnabled(ctx: ExtensionContext): boolean {
    const config = cfg(ctx);
    return config.enabled && config.userHelp;
  }

  /**
   * Actually stop the agent. Blocking tools alone is not enough — the model
   * ignores the error and keeps calling. Do not send followUp (that continues the loop).
   */
  function activateHardStop(ctx: ExtensionContext, notifyMsg: string) {
    hardStopped = true;
    steeredThisTurn = true;
    recoveryEpoch += 1; // drop any deferred recovery followUps
    if (ctx.hasUI) {
      ctx.ui.notify(notifyMsg, "error");
    }
    pi.appendEntry("anti-loop-hard-stop", {
      message: HARD_STOP_MSG,
      at: Date.now(),
    });
    // TUI abort clears steer/followUp queues into the editor.
    ctx.abort();
  }

  function tryRecover(
    ctx: ExtensionContext,
    config: AntiLoopConfig,
    message: string,
    kind?: RecoveryKind,
  ): boolean {
    if (hardStopped) return false;
    if (recoveries >= config.maxRecoveries) {
      activateHardStop(ctx, "Anti-loop: hard stop. Next prompt is user-help (/stuck off to skip).");
      return true;
    }
    recoveries += 1;
    steeredThisTurn = true;
    const epoch = recoveryEpoch;
    if (ctx.hasUI) {
      ctx.ui.notify(`Anti-loop: recovery ${recoveries}/${config.maxRecoveries}`, "warning");
    }
    let text = message;
    if (
      config.userHelp &&
      lastRecoveryUsesUserHelp(kind, recoveries, config.maxRecoveries)
    ) {
      text = USER_HELP_STEER;
      armUserHelp();
    }
    text = `${text}\n\n(recovery ${recoveries}/${config.maxRecoveries})`;
    // Defer past any concurrent ctx.abort() queue-clear (thinking-loop / hard-stop).
    // Otherwise followUp can be cleared then re-queued and leave Working with no LLM call.
    queueMicrotask(() => {
      if (hardStopped || epoch !== recoveryEpoch) return;
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    });
    return true;
  }

  async function applyStuckCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const config = cfg(ctx);
    if (!config.enabled) {
      ctx.ui.notify("Anti-loop is off. /anti-loop on first.", "warning");
      return;
    }
    if (!config.userHelp) {
      ctx.ui.notify("User-help is disabled in anti-loop.config.json.", "warning");
      return;
    }
    const trimmed = args.trim();
    const lower = trimmed.toLowerCase();
    if (lower === "off") {
      clearUserHelp();
      ctx.ui.notify("User-help off.", "info");
      return;
    }
    if (lower === "status") {
      ctx.ui.notify(userHelpStatusLine(), "info");
      return;
    }

    armUserHelp();
    const text = !trimmed || lower === "on" ? USER_HELP_PROMPT : trimmed;
    ctx.ui.notify("Anti-loop: user-help — ask what you cannot observe.", "info");
    if (ctx.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      ctx.abort();
      queueMicrotask(() => {
        pi.sendUserMessage(text, { deliverAs: "followUp" });
      });
    }
  }

  function userHelpStatusLine(): string {
    if (userHelpActive) return "User-help: ON (active — ask or apply, no new investigation). /stuck off to leave.";
    if (pendingUserHelp) return "User-help: armed for the next turn.";
    return "User-help: idle. /stuck to enter, or type while it is spinning.";
  }

  // Swallow extension-queued follow-ups while hard-stopped so recoveries cannot restart the loop.
  // Real user/rpc input lifts the hard stop (and auto-arms user-help).
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      if (hardStopped) return { action: "handled" as const };
      return;
    }

    if (hardStopped) {
      clearHardStop();
      if (userHelpEnabled(ctx)) armUserHelp();
      return;
    }

    if (!userHelpEnabled(ctx)) return;

    if (userHelpActive && userHelpSawEdit) {
      clearUserHelp();
      return;
    }

    if (userHelpActive) {
      if (!ctx.isIdle()) ctx.abort();
      return;
    }

    // User jumped in while the agent was still working.
    if (!ctx.isIdle()) {
      armUserHelp();
      ctx.abort();
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    configCache = null;
    resetTurnCounters();
    if (hardStopped) {
      // Cannot cancel the run from here; input-swallow is the real gate.
      // Still abort in case a stray stream is attached.
      ctx.abort();
      return;
    }
    const config = cfg(ctx);
    if (!config.enabled) {
      clearUserHelp();
      return;
    }

    // Leave after the model applied the user's fact, so verify/scenario follow-ups are not trapped.
    if (userHelpActive && userHelpSawEdit) {
      clearUserHelp();
    }

    if (pendingUserHelp && config.userHelp) {
      userHelpActive = true;
      pendingUserHelp = false;
      userHelpSawEdit = false;
      if (!userHelpAnnounced && ctx.hasUI) {
        userHelpAnnounced = true;
        ctx.ui.notify("Anti-loop: user-help — ask what you cannot observe, or apply what they typed.", "info");
      }
    }

    let systemPrompt = `${event.systemPrompt}\n\n${ANTI_LOOP_PROCEDURE}`;
    if (userHelpActive && config.userHelp) {
      systemPrompt += `\n\n${USER_HELP_PROCEDURE}`;
    }
    return { systemPrompt };
  });

  pi.on("agent_start", async () => {
    resetTurnCounters();
  });

  function recoverThinkingLoop(ctx: ExtensionContext, config: AntiLoopConfig): boolean {
    if (hardStopped || thinkingLoopFired) return false;
    thinkingLoopFired = true;
    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage("Anti-loop: aborting thinking loop…");
    }
    // Abort first — otherwise the model keeps generating the cycle and burns the GPU.
    // tryRecover's deferred followUp runs after TUI clears queues.
    ctx.abort();
    return tryRecover(ctx, config, THINKING_LOOP_STEER, "thinking");
  }

  pi.on("tool_call", async (event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled) return;

    if (hardStopped) {
      ctx.abort();
      return {
        block: true,
        reason: "ANTI-LOOP hard stop is active. Wait for the user or start a new prompt.",
      };
    }

    const input = "input" in event ? event.input : undefined;
    const fp = toolFingerprint(event.toolName, input);

    uniqueFingerprints.add(fp);
    if (isEditTool(event.toolName)) {
      editCount += 1;
      if (userHelpActive) userHelpSawEdit = true;
    }

    if (
      shouldNotifyApproachChurn({
        uniqueFingerprints: uniqueFingerprints.size,
        editCount,
        threshold: config.churnNotifyAfterUniqueTools,
        alreadyNotified: churnNotifiedThisTurn,
        userHelpActive,
      })
    ) {
      churnNotifiedThisTurn = true;
      if (ctx.hasUI) {
        ctx.ui.notify("Anti-loop: many different approaches, no edits. Type what you see, or /stuck.", "warning");
      }
    }

    if (fp === lastFingerprint) {
      identicalStreak += 1;
    } else {
      lastFingerprint = fp;
      identicalStreak = 1;
    }

    if (identicalStreak < config.maxIdenticalToolCalls) return;

    // Block the repeat; count as a recovery and steer once.
    if (!steeredThisTurn || recoveries < config.maxRecoveries) {
      tryRecover(ctx, config, REPEAT_STEER, "repeat");
    } else {
      activateHardStop(ctx, "Anti-loop: hard stop (repeated tool calls). Next prompt is user-help.");
    }

    if (hardStopped) {
      return {
        block: true,
        reason: "ANTI-LOOP hard stop is active. Wait for the user or start a new prompt.",
      };
    }

    return {
      block: true,
      reason:
        `ANTI-LOOP: blocked repeated \`${event.toolName}\` (${identicalStreak}× identical). ` +
        `Do something different — see the follow-up message.`,
    };
  });

  // Catch reasoning thrash mid-stream before it burns the full output budget.
  pi.on("message_update", async (event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || !config.detectThinkingLoops || hardStopped || thinkingLoopFired) {
      return;
    }
    const thinking = extractAssistantThinking(event.message);
    if (!isThinkingLoop(thinking, config.thinkingLoopMinRepeats)) return;
    if (ctx.hasUI) {
      ctx.ui.notify("Anti-loop: thinking loop detected — aborting stream.", "warning");
    }
    recoverThinkingLoop(ctx, config);
  });

  pi.on("message_end", async (event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || hardStopped) return;

    const stop = extractStopInfo(event.message);
    if (config.recoverOnTruncation && isOutputTruncated(stop)) {
      tryRecover(ctx, config, TRUNCATION_STEER, "truncation");
      return;
    }

    if (config.recoverGhostToolCalls) {
      const ghost = findGhostToolCall(event.message);
      if (ghost) {
        tryRecover(ctx, config, ghostToolSteer(ghost.toolName), "ghost");
        return;
      }
    }

    if (config.detectThinkingLoops) {
      const thinking = extractAssistantThinking(event.message);
      if (isThinkingLoop(thinking, config.thinkingLoopMinRepeats)) {
        recoverThinkingLoop(ctx, config);
        return;
      }
    }

    if (!config.detectStuckPhrases) return;
    const blob = [extractAssistantThinking(event.message), extractAssistantText(event.message)]
      .filter(Boolean)
      .join("\n");
    if (!blob) return;

    const repeats = stuckPhraseRepeatCount(blob);
    if (repeats >= 2 || (hasStuckPhrase(blob) && identicalStreak >= 2)) {
      tryRecover(ctx, config, STUCK_STEER, "stuck");
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || hardStopped || steeredThisTurn) return;

    const messages = event.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const stop = extractStopInfo(messages[i]);
      if (config.recoverOnTruncation && isOutputTruncated(stop)) {
        tryRecover(ctx, config, TRUNCATION_STEER, "truncation");
        return;
      }
      if (config.recoverGhostToolCalls) {
        const ghost = findGhostToolCall(messages[i]);
        if (ghost) {
          tryRecover(ctx, config, ghostToolSteer(ghost.toolName), "ghost");
          return;
        }
      }
      if (stop.stopReason === "stop" || stop.stopReason === "toolUse") return;
    }
  });

  pi.registerCommand("stuck", {
    description: "User-help — stop spinning and ask what you cannot observe. off | status | [note]",
    handler: async (args, ctx) => {
      await applyStuckCommand(args, ctx);
    },
  });

  pi.registerCommand("anti-loop", {
    description: "Thrash/truncation guard — on | off | status | reset | stuck [project]",
    handler: async (args, ctx) => {
      const raw = args.trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() ?? "status";

      if (sub === "stuck") {
        await applyStuckCommand(parts.slice(1).join(" "), ctx);
        return;
      }

      const scope = parts[1]?.toLowerCase() === "project" ? "project" : "user";

      if (sub === "on") {
        const file = persistEnabled(ctx.cwd, true, scope);
        configCache = null;
        clearHardStop();
        ctx.ui.notify(`Anti-loop enabled (saved to ${file}).`, "info");
        return;
      }
      if (sub === "off") {
        const file = persistEnabled(ctx.cwd, false, scope);
        configCache = null;
        clearHardStop();
        clearUserHelp();
        ctx.ui.notify(`Anti-loop disabled (saved to ${file}).`, "info");
        return;
      }
      if (sub === "reset") {
        clearHardStop();
        clearUserHelp();
        ctx.ui.notify("Anti-loop turn counters reset.", "info");
        return;
      }

      const fresh = cfg(ctx);
      ctx.ui.notify(
        `Anti-loop: ${fresh.enabled ? "ON" : "OFF"} · identical≥${fresh.maxIdenticalToolCalls} · ` +
          `maxRecoveries=${fresh.maxRecoveries} · trunc=${fresh.recoverOnTruncation ? "on" : "off"} · ` +
          `stuckPhrases=${fresh.detectStuckPhrases ? "on" : "off"} · ` +
          `thinkingLoops=${fresh.detectThinkingLoops ? `on(≥${fresh.thinkingLoopMinRepeats})` : "off"} · ` +
          `ghostTools=${fresh.recoverGhostToolCalls ? "on" : "off"} · ` +
          `userHelp=${fresh.userHelp ? "on" : "off"}` +
          (userHelpActive ? " · USER-HELP" : "") +
          (hardStopped ? " · HARD STOPPED (next prompt = user-help)" : ""),
        "info",
      );
    },
  });
}
