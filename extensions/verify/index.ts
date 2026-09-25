import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, type VerifyConfig } from "./config";
import { allSkippedForMissingTools, verify, formatReport, toolchainStatus } from "./engine";
import { OPERATING_PROCEDURE } from "./procedure";
import { resetGateClaim, tryClaimGate, registerGateReset } from "../shared/gate-orchestrator";
import { extractEditPath, isEditTool } from "../shared/edit-tools";
import { classifyVerifyFailure, formatClassifiedFailure } from "../shared/failure-classify";
import { detectStacks, formatStackDoctorLines } from "../shared/stack-detect";
import { withGateWorkingMessage } from "../shared/working-status";

/** Custom session-entry type used to persist verify state across /resume + reload. */
const STATE_TYPE = "foundation-verify-state";

interface PersistedState {
  changedFiles?: string[];
  fixAttempts?: number;
}

export default function (pi: ExtensionAPI) {
  registerGateReset(pi);

  // Per-session state.
  const changedFiles = new Set<string>();
  let fixAttempts = 0;
  let configCache: VerifyConfig | null = null;

  function cfg(ctx: ExtensionContext): VerifyConfig {
    if (!configCache) configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  // Persist in-flight state to the session (a custom entry — NOT sent to the LLM)
  // so /resume and reload keep guarding edits that never reached their gate.
  function persist() {
    pi.appendEntry<PersistedState>(STATE_TYPE, { changedFiles: [...changedFiles], fixAttempts });
  }

  // 0) Warn at startup if the toolchain for an enabled language is missing,
  //    so the verifier is never silently a no-op.
  pi.on("session_start", async (_event, ctx) => {
    // Restore verify state from the latest persisted entry on this branch, so a
    // turn interrupted before its gate is still tracked after /resume or reload.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) {
        const data = entry.data as PersistedState | undefined;
        changedFiles.clear();
        for (const f of data?.changedFiles ?? []) changedFiles.add(f);
        fixAttempts = data?.fixAttempts ?? 0;
      }
    }

    if (!ctx.hasUI) return;
    const status = await toolchainStatus(ctx.cwd, cfg(ctx));
    const missing = status.filter((s) => !s.ok);
    if (missing.length === 0) return;
    const lines = missing.map((s) => `  - ${s.name}: ${s.hint}`);
    ctx.ui.notify(
      `Foundation verifier: missing toolchain — these checks will be SKIPPED:\n${lines.join("\n")}\nRun /doctor for details.`,
      "warning",
    );
  });

  // 1) Inject the operating procedure and reset per-task state at the start of each prompt.
  pi.on("before_agent_start", async (event, ctx) => {
    resetGateClaim();
    configCache = null;
    fixAttempts = 0;
    // With the gate active, the gate clears changedFiles when checks pass, so we
    // keep them across prompts (an interrupted task stays tracked). Without a
    // gate nothing would ever clear them, so reset per prompt.
    if (!cfg(ctx).blocking) {
      changedFiles.clear();
      persist();
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${OPERATING_PROCEDURE}`,
    };
  });

  // 2) Auto-verify (lint only) after each edit, returned inline as the edit's result.
  pi.on("tool_result", async (event, ctx) => {
    if (!isEditTool(event.toolName)) return;
    const p = extractEditPath(event.input);
    if (p && !changedFiles.has(p)) {
      changedFiles.add(p);
      persist();
    }
    if (event.isError) return; // the edit itself failed; nothing to add

    const config = cfg(ctx);
    if (!config.verifyOnEdit || !p) return;

    const result = await verify(ctx.cwd, [p], config, ["lint"], ctx.signal);
    if (!result.failed) return;

    // Not isError: the edit DID apply. Flagging the edit as failed makes small models
    // redo the same edit (old text no longer matches → a real error → confusion).
    const report = formatReport(result);
    const note =
      `\n\n[foundation verifier] The edit to ${p} was applied. Lint now reports problems in that file — ` +
      `fix them next (do not repeat the edit you just made):\n${report}`;
    return {
      content: [...event.content, { type: "text", text: note }],
    };
  });

  // 3) Hard gate: do not let the agent settle idle while full verification fails.
  pi.on("agent_end", async (_event, ctx) => {
    const config = cfg(ctx);
    if (!config.blocking || changedFiles.size === 0) return;

    await withGateWorkingMessage(ctx, "Verifying (lint/tests) — inference idle", async () => {
      const result = await verify(ctx.cwd, [...changedFiles], config, undefined, ctx.signal);
      if (ctx.signal?.aborted) return; // user cancelled the turn — leave state intact

      if (!result.failed) {
        // Checks pass → these files are confirmed; stop tracking them.
        changedFiles.clear();
        fixAttempts = 0;
        persist();
        return;
      }

      if (fixAttempts >= config.maxFixAttempts) {
        ctx.ui.notify(
          `Verification still failing after ${config.maxFixAttempts} attempts — stopping the fix loop. Run /verify to see details.`,
          "error",
        );
        // Give up cleanly so the failure doesn't re-fire on every later turn.
        changedFiles.clear();
        fixAttempts = 0;
        persist();
        return;
      }

      if (!tryClaimGate("verify")) return;

      fixAttempts += 1;
      persist();
      const report = formatReport(result);
      const classified = classifyVerifyFailure(report);
      const message = formatClassifiedFailure(
        classified,
        `Verification failed (attempt ${fixAttempts}/${config.maxFixAttempts}). ` +
          `You must fix these before finishing — do not stop while checks fail.`,
      );
      // Re-trigger a fix turn. sendUserMessage always triggers a turn; deliverAs
      // "followUp" delivers it once the agent has settled (the agent_end moment).
      pi.sendUserMessage(message, { deliverAs: "followUp" });
    });
  });

  // 4) Explicit verify tool the model can call on demand.
  pi.registerTool({
    name: "verify",
    label: "Verify",
    description:
      "Run lint and tests on the project (or on the files changed so far) and return the results. " +
      "Use this to confirm your work actually passes before concluding.",
    promptSnippet: "Run lint + tests to confirm changes pass",
    promptGuidelines: ["Call verify before telling the user a task is complete."],
    parameters: Type.Object({
      scope: Type.Optional(
        Type.String({
          description: "'changed' (default) verifies files changed this task; 'project' verifies everything.",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const files = params.scope === "project" ? [] : [...changedFiles];
      const result = await verify(ctx.cwd, files, config, undefined, signal);
      const report = formatReport(result);
      const allSkipped = files.length > 0 && allSkippedForMissingTools(result);
      return {
        content: [{ type: "text", text: report }],
        details: { failed: result.failed, ran: result.ran, allSkipped },
        isError: result.failed || allSkipped,
      };
    },
  });

  // 5) User command: /verify — run it and, if failing, kick a fix turn.
  pi.registerCommand("verify", {
    description: "Run the foundation verifier (lint + tests) on changed files",
    handler: async (args, ctx) => {
      const config = cfg(ctx);
      const files = args.trim() === "project" ? [] : [...changedFiles];
      const result = await verify(ctx.cwd, files, config);
      const report = formatReport(result);
      if (result.failed) {
        ctx.ui.notify("Verification failed — sending failures to the agent to fix.", "error");
        pi.sendUserMessage(`Verification failed. Fix these:\n\n${report}`);
      } else {
        ctx.ui.notify(result.ran ? "Verification passed." : "No applicable checks.", "info");
      }
    },
  });

  // 6) User command: /doctor — check the client toolchain for enabled languages.
  pi.registerCommand("doctor", {
    description: "Check that the verifier's toolchain is installed on this client",
    handler: async (_args, ctx) => {
      const status = await toolchainStatus(ctx.cwd, cfg(ctx));
      const lines = status.map((s) => `${s.ok ? "[ok]" : "[missing]"} ${s.name}${s.ok ? "" : ` — ${s.hint}`}`);
      const stackLines = formatStackDoctorLines(detectStacks(ctx.cwd));
      ctx.ui.notify(
        `${stackLines.join("\n")}\n\nToolchain:\n${lines.join("\n")}`,
        status.every((s) => s.ok) ? "info" : "warning",
      );
    },
  });
}
