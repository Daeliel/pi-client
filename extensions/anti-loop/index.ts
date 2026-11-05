import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, persistEnabled, type AntiLoopConfig } from "./config";
import {
  CONTEXT_FULL_RESUME,
  extractAssistantText,
  extractAssistantThinking,
  extractStopInfo,
  findGhostToolCall,
  ghostToolSteer,
  HARD_STOP_MSG,
  hasStuckPhrase,
  isContextFull,
  isOutputTruncated,
  isThinkingLoop,
  REPEAT_STEER,
  RUNAWAY_STEER,
  STUCK_STEER,
  stuckPhraseRepeatCount,
  THINKING_LOOP_STEER,
  resultSignature,
  toolFingerprint,
  TRUNCATION_STEER,
} from "./detect";
import { ANTI_LOOP_PROCEDURE } from "./procedure";
import { CHECK_EVERY, cutRunaway, runawayKind } from "./runaway";
import {
  isEditTool,
  lastRecoveryUsesUserHelp,
  isFruitlessResult,
  shouldNotifyApproachChurn,
  USER_HELP_PROCEDURE,
  USER_HELP_PROMPT,
  USER_HELP_STEER,
  withUserHelpNote,
  type RecoveryKind,
} from "./user-help";

export default function (pi: ExtensionAPI) {
  let configCache: AntiLoopConfig | null = null;
  /**
   * How often each exact tool call ran since the last successful edit. Counting
   * (not just consecutive streaks) catches A,B,A,B,A re-read cycles; an edit is
   * progress, so it clears the window.
   */
  const callsSinceEdit = new Map<string, number>();
  /** The last result of each call: the same call bringing back something new is progress, not a loop. */
  const lastResult = new Map<string, string>();
  /** Highest repeat count of any call since the last edit (for stuck-phrase checks). */
  let maxRepeatSinceEdit = 0;
  let recoveries = 0;
  let hardStopped = false;
  let steeredThisTurn = false;
  let thinkingLoopFired = false;
  /** Characters of the streaming reply already checked for a runaway. */
  let runawayCheckedAt = 0;
  /** Replies already cleaned for the context, by their text (null: nothing ran away). */
  const cleaned = new Map<string, string | null>();
  let cleanedNotified = false;
  /** Bumped on hard stop so deferred followUps from earlier recoveries are dropped. */
  let recoveryEpoch = 0;

  const uniqueFingerprints = new Set<string>();
  /** Calls this turn that found nothing (error, no match, empty output). */
  let fruitlessCalls = 0;
  let editCount = 0;
  let churnNotifiedThisTurn = false;

  /** Consume on before_agent_start to enter user-help for that turn. */
  let pendingUserHelp = false;
  /** Inject USER_HELP_PROCEDURE while true. */
  let userHelpActive = false;
  let userHelpSawEdit = false;
  let userHelpAnnounced = false;

  function toolNames(): string[] {
    return pi.getAllTools().map((t) => t.name);
  }

  function cfg(ctx: ExtensionContext): AntiLoopConfig {
    if (!configCache) configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  /** Reset per-turn counters. Does not clear hardStopped or user-help. */
  function resetTurnCounters() {
    callsSinceEdit.clear();
    lastResult.clear();
    maxRepeatSinceEdit = 0;
    recoveries = 0;
    steeredThisTurn = false;
    thinkingLoopFired = false;
    runawayCheckedAt = 0;
    uniqueFingerprints.clear();
    fruitlessCalls = 0;
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

  /** Thrash signals from this run: a recovery already fired, or many different calls with no edit. */
  function runLooksStuck(): boolean {
    return recoveries > 0 || churnNotifiedThisTurn;
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

  /**
   * A message to send once an aborted run has settled. Pi 1.x ends an aborted run without
   * delivering what was queued during it (older Pi delivered it), so a steer or followUp
   * sent next to ctx.abort() sat unsent until the user typed again. Sent as a fresh prompt,
   * so before_agent_start runs and user-help reaches the system prompt.
   */
  let afterAbort: { text: string; epoch: number } | null = null;

  function abortThenSend(ctx: ExtensionContext, text: string) {
    afterAbort = { text, epoch: recoveryEpoch };
    ctx.abort();
  }

  /**
   * No room left for a reply (see isContextFull). Make room once — compact, then pick up the
   * task — instead of steering a model that had nothing to answer with; tell the user plainly
   * when even that does not help. Not counted as a recovery: nothing went wrong with the model.
   */
  let contextFullTried = false;
  let compactWhenSettled = false;

  function handleContextFull(ctx: ExtensionContext, message: unknown) {
    steeredThisTurn = true;
    const u = (message as { usage?: { input?: number; cacheRead?: number; cacheWrite?: number } }).usage ?? {};
    const used = Math.round(((u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)) / 1000);
    const window = Math.round((ctx.model?.contextWindow ?? 0) / 1000);
    if (contextFullTried) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Anti-loop: still no room for a reply (~${used}K of ${window}K tokens) after making room. Start a fresh session (/new) with a short hand-over, or use a model with a larger window.`, "error");
      }
      return;
    }
    contextFullTried = true;
    compactWhenSettled = true;
    if (ctx.hasUI) ctx.ui.notify(`Anti-loop: no room left for a reply (~${used}K of ${window}K tokens) — compacting, then continuing.`, "warning");
  }

  pi.on("agent_settled", async (_event, ctx) => {
    if (!compactWhenSettled) return;
    compactWhenSettled = false;
    ctx.compact({
      onComplete: () => pi.sendUserMessage(CONTEXT_FULL_RESUME),
      onError: (error) => {
        if (ctx.hasUI) {
          ctx.ui.notify(`Anti-loop: could not make room (${error.message.slice(0, 160)}). Start a fresh session (/new) with a short hand-over, or use a model with a larger window.`, "error");
        }
      },
    });
  });

  pi.on("agent_settled", async () => {
    const next = afterAbort;
    afterAbort = null;
    if (!next || hardStopped || next.epoch !== recoveryEpoch) return;
    pi.sendUserMessage(next.text);
  });

  function tryRecover(
    ctx: ExtensionContext,
    config: AntiLoopConfig,
    message: string,
    kind?: RecoveryKind,
    aborted = false,
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
    if (aborted) {
      // The run is being aborted: a followUp would be left in the queue (see afterAbort).
      afterAbort = { text, epoch };
      return true;
    }
    // Defer past any concurrent ctx.abort() queue-clear (hard stop).
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
      abortThenSend(ctx, text);
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

    // User-help is waiting for the user: their message stops whatever the model is doing and
    // becomes the next prompt. Aborting alone would drop it (Pi 1.x leaves a message queued
    // during an aborted run unsent), so it is re-sent once the run settles. A message with
    // images goes through Pi's own queue: it cannot be re-sent as text.
    if (userHelpActive) {
      if (ctx.isIdle() || event.images?.length) return;
      abortThenSend(ctx, event.text);
      return { action: "handled" as const };
    }

    // User typed while the agent was working. Ordinary steering ("also make it blue")
    // goes through untouched. Only when this run is visibly thrashing does it become
    // user-help: stop the stream and send the user's message, with the user-help note on
    // it, as a fresh prompt once the aborted run settles.
    if (!ctx.isIdle() && runLooksStuck()) {
      armUserHelp();
      abortThenSend(ctx, withUserHelpNote(event.text));
      return { action: "handled" as const };
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
    // The recovery steer goes out once the aborted run has settled.
    ctx.abort();
    return tryRecover(ctx, config, THINKING_LOOP_STEER, "thinking", true);
  }

  /** Stop a runaway reply now; the steer goes out once the aborted run has settled. */
  function recoverRunaway(ctx: ExtensionContext, config: AntiLoopConfig): boolean {
    if (hardStopped || thinkingLoopFired) return false;
    thinkingLoopFired = true;
    if (ctx.hasUI) {
      ctx.ui.notify("Anti-loop: the reply is repeating itself — stopping it.", "warning");
      ctx.ui.setWorkingMessage("Anti-loop: stopping a runaway reply…");
    }
    ctx.abort();
    return tryRecover(ctx, config, RUNAWAY_STEER, "runaway", true);
  }

  /** What the model wrote, thinking and text alike — whatever tags it uses. */
  function replyOf(message: unknown): string {
    return [extractAssistantThinking(message), extractAssistantText(message)].filter(Boolean).join("\n");
  }

  /** `text` without its runaway part, remembered so history is not re-checked every request. */
  function cleanedText(text: string): string | null {
    if (text.length < 800) return null;
    if (!cleaned.has(text)) {
      if (cleaned.size > 2000) cleaned.clear();
      cleaned.set(text, cutRunaway(text));
    }
    return cleaned.get(text) ?? null;
  }

  // A runaway reply left in the conversation is copied by the model on the next turn:
  // what it sees has the repeated part cut (the session file keeps it as it was).
  pi.on("context", async (event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || !config.detectRunaway) return;
    let changed = 0;
    const messages = event.messages.map((msg) => {
      const m = msg as { role?: string; content?: unknown };
      if (m.role !== "assistant" || !Array.isArray(m.content)) return msg;
      let touched = false;
      const content = m.content.map((block) => {
        const b = block as { type?: string; text?: string; thinking?: string };
        if (b?.type === "text" && typeof b.text === "string") {
          const cut = cleanedText(b.text);
          if (cut !== null) {
            touched = true;
            return { ...b, text: cut };
          }
        } else if (b?.type === "thinking" && typeof b.thinking === "string") {
          const cut = cleanedText(b.thinking);
          if (cut !== null) {
            touched = true;
            return { ...b, thinking: cut };
          }
        }
        return block;
      });
      if (!touched) return msg;
      changed += 1;
      return { ...m, content } as typeof msg;
    });
    if (changed === 0) return;
    if (!cleanedNotified && ctx.hasUI) {
      cleanedNotified = true;
      ctx.ui.notify(`Anti-loop: removed repeated output from ${changed} earlier repl${changed === 1 ? "y" : "ies"} before sending.`, "info");
    }
    return { messages };
  });

  /** One "looks stuck" notice per turn; it also marks the run as stuck for user-help. */
  function maybeNotifyChurn(ctx: ExtensionContext, config: AntiLoopConfig) {
    if (
      !shouldNotifyApproachChurn({
        uniqueFingerprints: uniqueFingerprints.size,
        fruitlessCalls,
        editCount,
        threshold: config.churnNotifyAfterUniqueTools,
        fruitlessThreshold: config.churnNotifyAfterFruitless,
        alreadyNotified: churnNotifiedThisTurn,
        userHelpActive,
      })
    ) {
      return;
    }
    churnNotifiedThisTurn = true;
    if (ctx.hasUI) {
      const why = fruitlessCalls >= config.churnNotifyAfterFruitless && config.churnNotifyAfterFruitless > 0
        ? `${fruitlessCalls} calls found nothing`
        : `${uniqueFingerprints.size} calls`;
      ctx.ui.notify(`Anti-loop: ${why} and no edits yet. Type what you see, or /stuck.`, "warning");
    }
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

    maybeNotifyChurn(ctx, config);

    const seen = (callsSinceEdit.get(fp) ?? 0) + 1;
    callsSinceEdit.set(fp, seen);
    maxRepeatSinceEdit = Math.max(maxRepeatSinceEdit, seen);

    if (seen < config.maxIdenticalToolCalls) return;

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
        `ANTI-LOOP: blocked repeated \`${event.toolName}\` (${seen}× the same call with the same result, no edit in between). ` +
        `Do something different — see the follow-up message.`,
    };
  });

  // A successful edit is progress: the model is no longer thrashing, so the repeat
  // window and the recovery budget start over. The edit's own fingerprint keeps its
  // count, so writing the same content again and again is still caught.
  pi.on("tool_result", async (event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || hardStopped) return;
    if (!isEditTool(event.toolName)) {
      // A loop is the same call coming back with the same result. A screenshot taken again,
      // or a flaky test run, brings back something new: that call's count starts over.
      const fp = toolFingerprint(event.toolName, "input" in event ? event.input : undefined);
      const sig = resultSignature(event.content, Boolean(event.isError));
      const prev = lastResult.get(fp);
      lastResult.set(fp, sig);
      if (prev !== undefined && prev !== sig) callsSinceEdit.set(fp, 1);
      // Exploring finds things; thrashing keeps coming back empty or failing.
      if (isFruitlessResult(Boolean(event.isError), event.content)) {
        fruitlessCalls += 1;
        maybeNotifyChurn(ctx, config);
      }
      return;
    }
    if (event.isError) return;
    const fp = toolFingerprint(event.toolName, "input" in event ? event.input : undefined);
    const own = callsSinceEdit.get(fp) ?? 0;
    callsSinceEdit.clear();
    lastResult.clear();
    if (own > 0) callsSinceEdit.set(fp, own);
    maxRepeatSinceEdit = own;
    recoveries = 0;
  });

  // Catch reasoning thrash mid-stream before it burns the full output budget.
  pi.on("message_update", async (event, ctx) => {
    const config = cfg(ctx);
    if (config.enabled && config.detectRunaway && !hardStopped && !thinkingLoopFired) {
      const reply = replyOf(event.message);
      if (reply.length < runawayCheckedAt) runawayCheckedAt = 0; // a new reply began
      if (reply.length - runawayCheckedAt >= CHECK_EVERY) {
        runawayCheckedAt = reply.length;
        if (runawayKind(reply)) {
          recoverRunaway(ctx, config);
          return;
        }
      }
    }
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
    runawayCheckedAt = 0;
    if (isContextFull(event.message, ctx.model?.contextWindow ?? 0)) {
      handleContextFull(ctx, event.message);
      return;
    }
    if ((event.message as { role?: string }).role === "assistant") contextFullTried = false;
    // A reply that ran away must not be told to "continue from where you stopped".
    if (config.detectRunaway && !thinkingLoopFired && runawayKind(replyOf(event.message))) {
      tryRecover(ctx, config, RUNAWAY_STEER, "runaway");
      return;
    }
    if (config.recoverOnTruncation && isOutputTruncated(stop)) {
      tryRecover(ctx, config, TRUNCATION_STEER, "truncation");
      return;
    }

    if (config.recoverGhostToolCalls) {
      const ghost = findGhostToolCall(event.message, toolNames());
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
    if (repeats >= 2 || (hasStuckPhrase(blob) && maxRepeatSinceEdit >= 2)) {
      tryRecover(ctx, config, STUCK_STEER, "stuck");
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || hardStopped || steeredThisTurn) return;

    const messages = event.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const stop = extractStopInfo(messages[i]);
      if (isContextFull(messages[i], ctx.model?.contextWindow ?? 0)) {
        handleContextFull(ctx, messages[i]);
        return;
      }
      if (config.recoverOnTruncation && isOutputTruncated(stop)) {
        const ranAway = config.detectRunaway && runawayKind(replyOf(messages[i]));
        tryRecover(ctx, config, ranAway ? RUNAWAY_STEER : TRUNCATION_STEER, ranAway ? "runaway" : "truncation");
        return;
      }
      if (config.recoverGhostToolCalls) {
        const ghost = findGhostToolCall(messages[i], toolNames());
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
          `runaway=${fresh.detectRunaway ? "on" : "off"} · ` +
          `ghostTools=${fresh.recoverGhostToolCalls ? "on" : "off"} · ` +
          `userHelp=${fresh.userHelp ? "on" : "off"}` +
          (userHelpActive ? " · USER-HELP" : "") +
          (hardStopped ? " · HARD STOPPED (next prompt = user-help)" : ""),
        "info",
      );
    },
  });
}
