import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import {
  isScenarioLevel,
  loadConfig,
  persistMaxSpecsBeforeAudit,
  persistQaShotEnabled,
  persistQaShotMode,
  persistScenarioLevel,
  type ScenariosConfig,
} from "./config";
import { formatStandardNote, pickStandard } from "./select";
import {
  ensureScenariosDir,
  ensurePlaywrightProjectDeps,
  ensureWebScaffold,
  formatDefinitions,
  formatReport,
  formatScenarioProgress,
  runScenarios,
  type ScenarioProgress,
  toolchainStatus,
  validateDefinitions,
} from "./engine";
import {
  discoverScenariosFromDisk,
  formatDiscoveredSummary,
  mergeScenarioLists,
  resolveEffectiveScenarios,
  specPathKey,
  splitVanishedScenarios,
} from "./discover";
import {
  applyCanonicalDeletions,
  auditScenarios,
  deleteScratchFiles,
  deleteSpecFiles,
  formatCompactTidyHint,
  formatTidyReport,
  setCanonicalPick,
} from "./housekeeping";
import { formatSpecPatternWarnings, scanSpecPatterns } from "./spec-audit";
import {
  alreadyReviewed,
  buildPendingReview,
  buildReviewPrompt,
  markReviewed,
  reviewReason,
  validateProposal,
  type PendingReview,
} from "./review";
import { collectPreflightWarnings } from "./preflight";
import { buildScenariosProcedure } from "./procedure";
import type { ScenarioDefinition } from "./types";
import {
  capturePageScreenshot,
  captureQaShot,
  loadVisionImages,
} from "./vision";
import { presentVisionToSession } from "../shared/vision-relay";
import { scaffoldScenario } from "./scaffold";
import { resetGateClaim, tryClaimGate, isGateClaimed, registerGateReset } from "../shared/gate-orchestrator";
import { extractEditPath, isCodePath, isEditTool } from "../shared/edit-tools";
import { classifyScenarioFailure, formatClassifiedFailure } from "../shared/failure-classify";
import { detectStacks, formatStackDoctorLines, shouldInjectWebProcedure } from "../shared/stack-detect";
import { withGateWorkingMessage } from "../shared/working-status";
import { syncOwnedTools } from "../shared/tool-activation";
import { attemptNotes, giveUpNote, RepeatTracker } from "../shared/gate-messages";

const TOOLS = [
  "scaffold_scenario",
  "define_scenarios",
  "run_scenarios",
  "capture_page_screenshot",
  "confirm_visual_qa",
  "scenarios_housekeep",
  "list_scenarios",
  "propose_scenario_cleanup",
];
const WEB_FILE = /\.(html?|js|mjs|cjs|jsx|ts|tsx|css|vue|svelte)$/i;

function isWebFile(filePath: string): boolean {
  return WEB_FILE.test(filePath.replace(/\\/g, "/"));
}

const STATE_TYPE = "foundation-scenarios-state";
/** Upper bound for a spec cap set by the model or /scenarios cap. */
const MAX_SPEC_CAP = 200;

interface PersistedState {
  changedFiles?: string[];
  fixAttempts?: number;
  qaFixAttempts?: number;
  scenarios?: ScenarioDefinition[];
  visualQaConfirmed?: boolean;
  lastRunById?: Record<string, "pass" | "fail" | "skip">;
  specsCreatedThisSession?: string[];
  /** Spec paths (specPathKey) seen on disk — a registered one that disappears was renamed or deleted. */
  seenSpecFiles?: string[];
}

const ScenarioSchema = Type.Object({
  id: Type.String({ description: "Short stable id (e.g. save-countdown-state)." }),
  title: Type.String({ description: "One-line name of the user-visible flow." }),
  steps: Type.String({
    description:
      "Given/when/then in plain language — mirror the user's repro steps in order (which screen, button, tab); assert on the screen they complained about, not a proxy elsewhere.",
  }),
  testFile: Type.String({
    description: "Relative path to the runnable test you will create (e.g. .pi/scenarios/save-state.spec.ts).",
  }),
  kind: Type.Union([Type.Literal("web"), Type.Literal("api"), Type.Literal("script")], {
    description: "web = Playwright, api = pytest, script = configured script runner (default: python).",
  }),
});

export default function (pi: ExtensionAPI) {
  registerGateReset(pi);
  const changedFiles = new Set<string>();
  let fixAttempts = 0;
  let qaFixAttempts = 0;
  const repeats = new RepeatTracker();
  let visualQaConfirmed = false;
  let scenarios: ScenarioDefinition[] = [];
  let lastRunById: Record<string, "pass" | "fail" | "skip"> = {};
  let specsCreatedThisSession: string[] = [];
  const seenSpecFiles = new Set<string>();
  /** Scenarios dropped by the last reconcile, reported once with the next run. */
  let vanishedNote = "";
  /** Model housekeeping review: due after a green gate, sent once the run settles. */
  let reviewDue: { protectedFiles: string[] } | null = null;
  /** The review the model is answering (propose_scenario_cleanup is active only then). */
  let activeReview: PendingReview | null = null;
  /** Set right before the review prompt is sent, consumed by its before_agent_start. */
  let reviewPromptArmed = false;
  /** The review prompt's run is in progress; its agent_end closes the review. */
  let reviewRunning = false;
  let configCache: ScenariosConfig | null = null;

  function cfg(ctx: ExtensionContext): ScenariosConfig {
    if (!configCache) configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  function shouldRunQaGate(config: ScenariosConfig): boolean {
    if (!config.qaShot.enabled) return false;
    if (config.qaShot.mode === "off") return false;
    if (visualQaConfirmed) return false;
    if (config.qaShot.gateOnWebChanges && !hasWebChanges()) return false;
    return true;
  }

  function qaMode(config: ScenariosConfig): "model" | "human" | "off" {
    if (!config.qaShot.enabled || config.qaShot.mode === "off") return "off";
    return config.qaShot.mode === "human" ? "human" : "model";
  }

  function hasWebChanges(): boolean {
    return [...changedFiles].some(isWebFile);
  }

  /** The model's last reply may claim success; its next turn must know the gate gave up. */
  function leaveGiveUpNote(attempts: number, evidence: string) {
    pi.sendMessage(
      { customType: "foundation-gate", content: giveUpNote("scenarios", attempts, evidence), display: true },
      { deliverAs: "nextTurn" },
    );
    repeats.reset();
  }

  function persist() {
    pi.appendEntry<PersistedState>(STATE_TYPE, {
      changedFiles: [...changedFiles],
      fixAttempts,
      qaFixAttempts,
      scenarios,
      visualQaConfirmed,
      lastRunById,
      specsCreatedThisSession,
      seenSpecFiles: [...seenSpecFiles],
    });
  }

  function recordRunResults(result: Awaited<ReturnType<typeof runScenarios>>, ran: ScenarioDefinition[]) {
    for (const c of result.checks) {
      lastRunById[c.scenarioId] = c.status;
    }
    persist();
  }

  function isScenarioSpecPath(p: string): boolean {
    const n = p.replace(/\\/g, "/").toLowerCase();
    return n.includes("/.pi/scenarios/") && (n.endsWith(".spec.ts") || n.endsWith(".test.py"));
  }

  /**
   * Model-facing tools for this project and config. Housekeeping and listing stay
   * on /scenarios for the user; the screenshot tool only exists for web UIs, and
   * confirm_visual_qa only when the model is the one approving QA shots.
   */
  function syncTools(ctx: ExtensionContext) {
    const config = cfg(ctx);
    if (!config.enabled) {
      syncOwnedTools(pi, TOOLS, []);
      return;
    }
    const wanted = ["scaffold_scenario", "define_scenarios", "run_scenarios"];
    if (shouldInjectWebProcedure(ctx.cwd, changedFiles)) wanted.push("capture_page_screenshot");
    if (qaMode(config) === "model") wanted.push("confirm_visual_qa");
    if (activeReview) wanted.push("propose_scenario_cleanup");
    syncOwnedTools(pi, TOOLS, wanted);
  }

  pi.on("input", async (_event, ctx) => {
    configCache = null;
    // Any prompt other than the review prompt itself ends a pending review.
    if (reviewPromptArmed) {
      reviewPromptArmed = false;
      reviewRunning = true;
    } else if (activeReview && !reviewRunning) {
      activeReview = null;
    }
    syncTools(ctx);
  });

  /**
   * Start a model review of the spec list: the model answers with
   * propose_scenario_cleanup, the user confirms, the extension deletes.
   * Returns a message when there is nothing to review.
   */
  function startReview(ctx: ExtensionContext, protectedFiles: string[]): string | null {
    const config = cfg(ctx);
    const discovered = discoverScenariosFromDisk(ctx.cwd, config);
    const audit = auditScenarios(ctx.cwd, config, discovered, lastRunById);
    const review = buildPendingReview(ctx.cwd, discovered, audit, lastRunById, protectedFiles);
    if (review.candidates.length === 0) return "No specs to review.";
    markReviewed(ctx.cwd, config, discovered);
    activeReview = review;
    reviewPromptArmed = true;
    const cap = { current: config.housekeeping.maxSpecsBeforeAudit, total: discovered.length };
    pi.sendUserMessage(buildReviewPrompt(review, reviewReason(audit), cap), { deliverAs: "followUp" });
    return null;
  }

  // During a review the user decides what goes; the model only proposes.
  pi.on("tool_call", async (event, ctx) => {
    if (!reviewRunning) return;
    const input = ("input" in event ? event.input : undefined) as Record<string, unknown> | undefined;
    const editPath = isEditTool(event.toolName) ? extractEditPath(input) : null;
    const command = typeof input?.command === "string" ? input.command : "";
    const touchesSpecs =
      (editPath !== null && isScenarioSpecPath(path.resolve(ctx.cwd, editPath))) ||
      (/\.pi[\\/]+scenarios/i.test(command) && /\b(rm|del|mv|move|rename|unlink|Remove-Item|Move-Item)\b/i.test(command));
    if (!touchesSpecs) return;
    return {
      block: true,
      reason: "Scenario review: do not change spec files yourself — list them in propose_scenario_cleanup and the user decides.",
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!reviewDue || activeReview) return;
    const due = reviewDue;
    reviewDue = null;
    if (!ctx.hasUI) return;
    startReview(ctx, due.protectedFiles);
  });

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) {
        const data = entry.data as PersistedState | undefined;
        changedFiles.clear();
        for (const f of data?.changedFiles ?? []) changedFiles.add(f);
        fixAttempts = data?.fixAttempts ?? 0;
        qaFixAttempts = data?.qaFixAttempts ?? 0;
        scenarios = data?.scenarios ?? [];
        visualQaConfirmed = data?.visualQaConfirmed ?? false;
        lastRunById = data?.lastRunById ?? {};
        specsCreatedThisSession = data?.specsCreatedThisSession ?? [];
        seenSpecFiles.clear();
        for (const f of data?.seenSpecFiles ?? []) seenSpecFiles.add(f);
      }
    }

    syncTools(ctx);
    const config = cfg(ctx);
    if (!config.enabled || !ctx.hasUI) return;

    const status = await toolchainStatus(ctx.cwd, config);
    const missing = status.filter((s) => !s.ok);
    if (missing.length === 0) return;
    const lines = missing.map((s) => `  - ${s.name}: ${s.hint}`);
    ctx.ui.notify(
      `Foundation scenarios: missing toolchain — some runners will be SKIPPED:\n${lines.join("\n")}\nRun /scenarios doctor for details.`,
      "warning",
    );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    resetGateClaim();
    configCache = null;
    fixAttempts = 0;
    qaFixAttempts = 0;
    repeats.reset();
    const config = cfg(ctx);
    if (!config.enabled) return;

    if (!config.blocking) {
      changedFiles.clear();
      scenarios = [];
      visualQaConfirmed = false;
      specsCreatedThisSession = [];
      persist();
    }

    const detection = detectStacks(ctx.cwd);
    const includeWeb = shouldInjectWebProcedure(ctx.cwd, changedFiles);
    const includeFlutter = detection.stacks.includes("flutter");
    const procedure = buildScenariosProcedure({
      includeWeb,
      includeFlutter,
      stackSummary: detection.summary,
      level: config.level,
    });

    return {
      systemPrompt: `${event.systemPrompt}\n\n${procedure}`,
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || !isEditTool(event.toolName)) return;

    const p = extractEditPath(event.input);
    if (p && !changedFiles.has(p)) {
      changedFiles.add(p);
      if (isWebFile(p)) {
        visualQaConfirmed = false;
      }
      if (isScenarioSpecPath(p) && !specsCreatedThisSession.includes(p)) {
        specsCreatedThisSession.push(p);
      }
      if (isScenarioSpecPath(p)) seenSpecFiles.add(specPathKey(ctx.cwd, p));
      persist();
    }
  });

  async function sendVisionFollowUp(
    ctx: ExtensionContext,
    intro: string,
    screenshotPaths: string[],
    config: ScenariosConfig,
  ): Promise<void> {
    if (screenshotPaths.length === 0) {
      pi.sendUserMessage(intro, { deliverAs: "followUp" });
      return;
    }
    const { images, paths } = await loadVisionImages(screenshotPaths, config);
    if (images.length === 0) {
      pi.sendUserMessage(`${intro}\n\n(screenshots found on disk but could not be loaded)`, {
        deliverAs: "followUp",
      });
      return;
    }
    const content = await presentVisionToSession(ctx, intro, images, paths);
    pi.sendUserMessage(content, { deliverAs: "followUp" });
  }

  /**
   * Reconcile the registry with the disk: a registered spec that existed and is now
   * gone was renamed or deleted, so stop scheduling it (instead of failing it as
   * "missing — create it" on every gate run, which loops a model that moved it).
   */
  function reconcileRegistry(ctx: ExtensionContext) {
    const { kept, vanished } = splitVanishedScenarios(ctx.cwd, scenarios, seenSpecFiles);
    for (const s of kept) {
      if (fs.existsSync(path.resolve(ctx.cwd, s.testFile))) seenSpecFiles.add(specPathKey(ctx.cwd, s.testFile));
    }
    if (vanished.length === 0) return;
    scenarios = kept;
    for (const s of vanished) {
      delete lastRunById[s.id];
      seenSpecFiles.delete(specPathKey(ctx.cwd, s.testFile));
    }
    vanishedNote =
      `Dropped ${vanished.length} registered scenario(s) whose spec file was renamed or deleted:\n` +
      vanished.map((s) => `  - ${s.id}: ${s.testFile}`).join("\n") +
      `\nSpecs on disk are still auto-discovered; call define_scenarios to re-register under new names.\n\n`;
    persist();
  }

  function effectiveScenarios(ctx: ExtensionContext): ScenarioDefinition[] {
    reconcileRegistry(ctx);
    return resolveEffectiveScenarios(ctx.cwd, scenarios, cfg(ctx));
  }

  /**
   * The specs a run covers at this level: all of them for thorough (or when asked for all);
   * for standard, this task's specs, the smoke specs and the ones the changed code belongs to.
   * `note` says what ran and how to run the rest (empty for a full run).
   */
  function specsForLevel(
    ctx: ExtensionContext,
    toRun: ScenarioDefinition[],
    all = false,
  ): { run: ScenarioDefinition[]; note: string } {
    if (all || cfg(ctx).level !== "standard") return { run: toRun, note: "" };
    const focus = [...scenarios.map((s) => s.testFile), ...specsCreatedThisSession];
    const pick = pickStandard(ctx.cwd, toRun, changedFiles, focus);
    return { run: pick.run, note: formatStandardNote(pick) };
  }

  /** Thorough reviews passing specs' screenshots too; standard looks only when something fails. */
  function passShotsWanted(config: ScenariosConfig): boolean {
    return config.visionOnPass && config.level !== "standard";
  }

  /** Prefix a run report with the reconcile note (once). */
  function withVanishedNote(report: string): string {
    const note = vanishedNote;
    vanishedNote = "";
    return `${note}${report}`;
  }

  /**
   * Show "Scenario 3/10: id" while a run is in progress: in the working indicator
   * (visible while the agent streams) and the footer status (visible when idle,
   * e.g. /scenarios run). Call done() when the run ends.
   */
  function runProgress(ctx: ExtensionContext, label: string) {
    return {
      update(p: ScenarioProgress) {
        if (!ctx.hasUI) return;
        const text = formatScenarioProgress(p);
        ctx.ui.setWorkingMessage(`${label} — ${text}`);
        ctx.ui.setStatus("scenarios", text);
      },
      done() {
        if (!ctx.hasUI) return;
        ctx.ui.setWorkingMessage();
        ctx.ui.setStatus("scenarios", undefined);
      },
    };
  }

  async function buildRunScenariosResponse(
    ctx: ExtensionContext,
    report: string,
    result: Awaited<ReturnType<typeof runScenarios>>,
    config: ScenariosConfig,
    introSuffix: string,
  ) {
    const failureShots = result.failed && config.visionOnFailure ? (result.screenshots ?? []) : [];
    const passShots = !result.failed && passShotsWanted(config) ? (result.outputScreenshots ?? []) : [];
    const shots = [...failureShots, ...passShots];
    if (shots.length === 0) {
      return {
        content: [{ type: "text" as const, text: report }],
        details: { failed: result.failed, ran: result.ran },
        isError: result.failed,
      };
    }
    const { images, paths } = await loadVisionImages(shots, config);
    const label = result.failed
      ? "Review failure screenshot(s) for layout/overlap issues."
      : "Review attached screenshot(s) against the scenario steps. If the image shows the WRONG screen/tab/state (e.g. Timer instead of History), the spec passed with weak assertions — fix clicks/coords/asserts and re-run. Canvas visible or assertClean() alone is not proof.";
    const intro = `${report}\n\n${label}${introSuffix}`;
    const content = await presentVisionToSession(ctx, intro, images, paths);
    return {
      content,
      details: { failed: result.failed, ran: result.ran, screenshots: paths },
      isError: result.failed,
    };
  }

  pi.on("agent_end", async (_event, ctx) => {
    if (reviewRunning) {
      // The review turn is over, answered or not.
      reviewRunning = false;
      activeReview = null;
      syncTools(ctx);
    }
    const config = cfg(ctx);
    if (!config.enabled || !config.blocking) return;
    if (config.gateOnCodeChanges && ![...changedFiles].some(isCodePath)) {
      // Docs/notes/assets only — nothing behavioural to prove. Forget them so they
      // do not make a later unrelated turn look like a code change.
      if (changedFiles.size > 0) {
        changedFiles.clear();
        persist();
      }
      return;
    }
    if (isGateClaimed()) return;

    await withGateWorkingMessage(ctx, "Acceptance gates (scenarios/QA) — inference idle", async (status) => {
      const toRun = effectiveScenarios(ctx);

      if (config.requireDefined && toRun.length === 0) {
        if (fixAttempts >= config.maxFixAttempts) {
          ctx.ui.notify(
            `No acceptance scenarios defined after ${config.maxFixAttempts} attempts — stopping the fix loop.`,
            "error",
          );
          leaveGiveUpNote(fixAttempts, "no acceptance scenarios were defined or written for the code change");
          changedFiles.clear();
          fixAttempts = 0;
          persist();
          return;
        }
        if (!tryClaimGate("scenarios")) return;
        fixAttempts += 1;
        persist();
        const last = attemptNotes(fixAttempts, config.maxFixAttempts, false);
        pi.sendUserMessage(
          `You changed code but no acceptance scenarios are defined (attempt ${fixAttempts}/${config.maxFixAttempts}). ` +
            `Call define_scenarios (or optional scaffold_scenario) with each user-visible flow, write the test files under ${config.scenariosDir}, ` +
            `then call run_scenarios before finishing.` +
            (last ? `\n${last}` : ""),
          { deliverAs: "followUp" },
        );
        return;
      }

      const { run: picked, note: levelNote } = specsForLevel(ctx, toRun);
      if (picked.length > 0) {
        const result = await runScenarios(ctx.cwd, picked, config, ctx.signal, undefined, (p) =>
          status.step(formatScenarioProgress(p)),
        );
        if (ctx.signal?.aborted) return;

        if (result.failed) {
          const report = withVanishedNote(formatReport(result, picked)) + (levelNote ? `\n\n${levelNote}` : "");
          const classified = classifyScenarioFailure({
            report,
            preflightWarnings: result.preflightWarnings,
            weakSpecBlocking: Boolean(result.weakSpecWarnings?.some((w) => w.blocking)),
            missingFiles: result.missingFiles,
          });
          if (fixAttempts >= config.maxFixAttempts) {
            ctx.ui.notify(
              `Scenarios still failing after ${config.maxFixAttempts} attempts — stopping the fix loop. Run /scenarios run`,
              "error",
            );
            leaveGiveUpNote(fixAttempts, classified.evidence);
            changedFiles.clear();
            scenarios = [];
            fixAttempts = 0;
            qaFixAttempts = 0;
            visualQaConfirmed = false;
            persist();
            return;
          }

          if (!tryClaimGate("scenarios")) return;
          fixAttempts += 1;
          persist();
          const notes = attemptNotes(fixAttempts, config.maxFixAttempts, repeats.repeated(report));
          const intro = formatClassifiedFailure(
            classified,
            `Acceptance scenarios failed (attempt ${fixAttempts}/${config.maxFixAttempts}). ` +
              `Fix the app or tests — do not finish while scenarios fail.` +
              (notes ? `\n${notes}` : ""),
            { screens: config.visionOnFailure ? result.screenshots : undefined },
          );
          const shots = config.visionOnFailure ? (result.screenshots ?? []) : [];
          await sendVisionFollowUp(ctx, intro, shots, config);
          return;
        }
        recordRunResults(result, picked);
      }
      if (levelNote && ctx.hasUI) ctx.ui.notify(levelNote, "info");

      if (shouldRunQaGate(config)) {
        if (qaFixAttempts >= config.maxFixAttempts) {
          ctx.ui.notify(
            `Visual QA not confirmed after ${config.maxFixAttempts} attempts — stopping the fix loop. Run /scenarios qa on and try again.`,
            "error",
          );
          changedFiles.clear();
          scenarios = [];
          fixAttempts = 0;
          qaFixAttempts = 0;
          visualQaConfirmed = false;
          persist();
          return;
        }

        status.step("capturing visual QA screenshot");
        const capture = await captureQaShot(ctx.cwd, config, ctx.signal);
        if (ctx.signal?.aborted) return;

        if (!capture.ok) {
          if (!tryClaimGate("qa")) return;
          qaFixAttempts += 1;
          persist();
          pi.sendUserMessage(
            `Visual QA shot failed (attempt ${qaFixAttempts}/${config.maxFixAttempts}). ` +
              `Ensure .pi/playwright.config.ts webServer/baseURL is correct:\n\n${capture.error ?? "unknown error"}`,
            { deliverAs: "followUp" },
          );
          return;
        }

        const mode = qaMode(config);
        qaFixAttempts += 1;
        persist();
        const intro =
          mode === "human"
            ? `Visual QA (human mode, attempt ${qaFixAttempts}/${config.maxFixAttempts}): review the screenshot. ` +
              `Approve with /scenarios qa approve when layout looks correct (model confirm_visual_qa is ignored in human mode).`
            : `Visual QA (attempt ${qaFixAttempts}/${config.maxFixAttempts}): review the screenshot before finishing. ` +
              `Tests may pass while layout still looks wrong. Call confirm_visual_qa when done.`;

        if (config.qaShot.blocking) {
          if (!tryClaimGate("qa")) return;
          await sendVisionFollowUp(ctx, intro, [path.join(ctx.cwd, capture.outputPath)], config);
          return;
        }

        const { images, paths } = await loadVisionImages([path.join(ctx.cwd, capture.outputPath)], config);
        if (images.length > 0) {
          ctx.ui.notify(`${intro}\n(saved ${capture.outputPath})`, "info");
          const content = await presentVisionToSession(ctx, intro, images, paths);
          pi.sendUserMessage(content, { deliverAs: "followUp" });
        }
      }

      // Gate passed, task done: scratch specs (__*.spec.ts) were throwaway probes.
      if (config.housekeeping.enabled && config.housekeeping.autoDeleteScratch) {
        const { deleted } = deleteScratchFiles(ctx.cwd, discoverScenariosFromDisk(ctx.cwd, config));
        if (deleted.length > 0 && ctx.hasUI) {
          ctx.ui.notify(`Deleted scratch spec(s) after a passing gate:\n${deleted.map((f) => `  - ${f}`).join("\n")}`, "info");
        }
      }

      // Model review replaces the tidy hint: queued here, sent once every gate has settled.
      let reviewQueued = false;
      if (config.housekeeping.enabled && config.housekeeping.modelReview && ctx.hasUI) {
        const discovered = discoverScenariosFromDisk(ctx.cwd, config);
        const audit = auditScenarios(ctx.cwd, config, discovered, lastRunById);
        if (reviewReason(audit) && !alreadyReviewed(ctx.cwd, config, discovered)) {
          reviewDue = { protectedFiles: [...scenarios.map((s) => s.testFile), ...specsCreatedThisSession] };
          reviewQueued = true;
        }
      }

      if (config.housekeeping.enabled && config.housekeeping.auditOnAgentEnd && ctx.hasUI && !reviewQueued) {
        const discovered = discoverScenariosFromDisk(ctx.cwd, config);
        const audit = auditScenarios(ctx.cwd, config, discovered, lastRunById);
        const hint = formatCompactTidyHint(audit);
        const created =
          specsCreatedThisSession.length > 0
            ? `\nNew spec(s) this session: ${specsCreatedThisSession.join(", ")}`
            : "";
        if (hint || created) {
          ctx.ui.notify(`${hint || "Scenario housekeeping"}${created}\nRun /scenarios tidy for the menu.`, "info");
        }
      }

      changedFiles.clear();
      scenarios = [];
      fixAttempts = 0;
      qaFixAttempts = 0;
      visualQaConfirmed = false;
      specsCreatedThisSession = [];
      seenSpecFiles.clear();
      vanishedNote = "";
      persist();
    });
  });

  pi.registerTool({
    name: "scaffold_scenario",
    label: "Scaffold Scenario",
    description:
      "[Optional] Write a thin starter acceptance test from a template (symptom-repro, visual-before-after, or api). " +
      "Does not overwrite existing files. Freeform specs are fine when you write good tests yourself — use this when stuck or starting fresh.",
    promptSnippet: "Optional starter spec from template (not required)",
    promptGuidelines: [
      "Optional help only — writing your own .pi/scenarios/*.spec.ts is preferred when you can.",
      "Use when you need a starting file quickly; then adapt clicks/asserts for this app.",
      "Still call define_scenarios and run_scenarios after scaffolding.",
    ],
    parameters: Type.Object({
      template: Type.Union(
        [Type.Literal("symptom-repro"), Type.Literal("visual-before-after"), Type.Literal("api")],
        { description: "Thin pattern to start from." },
      ),
      id: Type.String({ description: "Short stable id (e.g. history-empty)." }),
      title: Type.String({ description: "One-line name of the flow." }),
      steps: Type.String({ description: "Given/when/then in plain language (user repro order)." }),
      testFile: Type.Optional(Type.String({ description: "Relative test path (default from id)." })),
      screenName: Type.Optional(Type.String({ description: "Screen/tab/level the user named." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const result = await scaffoldScenario(ctx.cwd, config, {
        template: params.template,
        id: params.id,
        title: params.title,
        steps: params.steps,
        testFile: params.testFile,
        screenName: params.screenName,
      });
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.message }],
          details: { ok: false },
          isError: true,
        };
      }
      scenarios = mergeScenarioLists(scenarios, [result.scenario]);
      persist();
      const extra =
        result.scaffolded.length > 0 ? `\nAlso created: ${result.scaffolded.join(", ")}` : "";
      const deps =
        result.pwInstallNote && result.pwInstallNote.startsWith("installed")
          ? `\n${result.pwInstallNote}`
          : result.pwInstallNote
            ? `\nWarning: ${result.pwInstallNote}`
            : "";
      return {
        content: [
          {
            type: "text",
            text: `${result.message}${extra}${deps}\n\nRegistered:\n${formatDefinitions([result.scenario])}`,
          },
        ],
        details: { ok: true, created: result.created, testFile: result.testFile },
      };
    },
  });

  pi.registerTool({
    name: "define_scenarios",
    label: "Define Scenarios",
    description:
      "[Lane A — Playwright] Register acceptance scenarios and test files that PROVE user flows. " +
      "All UI clicks/taps belong in Playwright specs — not browser_* tools.",
    promptSnippet: "Declare acceptance flows before implementing (Workflow A)",
    promptGuidelines: [
      "Call define_scenarios early for any UI or API behaviour to prove.",
      "Steps must follow the user's repro path in order — open the screen/tab/level they named; no proxy checks on other views.",
      "Web/canvas/game flows: kind web → write .pi/scenarios/*.spec.ts with clicks/keys + attachConsoleCapture + screenshot + assert on the reported screen.",
      "Do not use browser_* tools to prove the same flows.",
    ],
    parameters: Type.Object({
      taskSummary: Type.Optional(Type.String({ description: "Brief summary of the feature being built." })),
      scenarios: Type.Array(ScenarioSchema, { minItems: 1 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      ensureScenariosDir(ctx.cwd, config);

      const { valid, errors } = validateDefinitions(ctx.cwd, params.scenarios as ScenarioDefinition[]);
      if (errors.length > 0) {
        return {
          content: [{ type: "text", text: `Invalid scenarios:\n${errors.join("\n")}` }],
          details: { ok: false },
        };
      }

      const scaffolded = ensureWebScaffold(ctx.cwd, config, valid);
      const pwInstallNote = await ensurePlaywrightProjectDeps(ctx.cwd);
      scenarios = valid;
      persist();

      const summary = params.taskSummary ? `Task: ${params.taskSummary}\n\n` : "";
      const scaffoldNote =
        scaffolded.length > 0
          ? `\nCreated ${scaffolded.join(", ")} — edit webServer/baseURL for this app.` +
            (scaffolded.some((s) => s.includes("canvas-interaction"))
              ? "\nCanvas scroll: import scrollAndCapture / scrollCanvasWheel from ./helpers/canvas-interaction.ts in THIS repo (not pi-client templates). Never window.scrollBy or page.evaluate."
              : "") +
            "\n\n"
          : "";
      const depsNote = pwInstallNote
        ? pwInstallNote.startsWith("installed")
          ? `\n${pwInstallNote} (for import { test } from "@playwright/test" in spec files).\n\n`
          : `\nWarning: ${pwInstallNote}\n\n`
        : "";
      const text =
        `${summary}Registered ${scenarios.length} acceptance scenario(s):\n\n` +
        `${formatDefinitions(scenarios)}\n\n` +
        scaffoldNote +
        depsNote +
        `Create each testFile, implement the feature, then call run_scenarios (Workflow A). ` +
        `When run_scenarios passes, do not re-prove with browser_* tools.`;

      return {
        content: [{ type: "text", text }],
        details: { ok: true, count: scenarios.length },
      };
    },
  });

  pi.registerTool({
    name: "run_scenarios",
    label: "Run Scenarios",
    description:
      "[Lane A — Playwright] Run acceptance tests (Playwright for web, pytest for api). " +
      "This is the ONLY proof that UI flows work. Uses Playwright's browser — not live CDP Chrome.",
    promptSnippet: "Run Playwright/pytest scenarios (Workflow A proof)",
    promptGuidelines: [
      "Call run_scenarios before claiming a behavioural task is complete.",
      "Bug fixes: spec must reach the screen/state the user named and assert the symptom is gone — not a shortcut on another screen.",
      "Web specs: prove user flows via interaction — do not inject app state (evaluate, localStorage, globals) to skip clicks the steps describe.",
      "If run_scenarios passes, the flow is proven — do not browser_screenshot or shell-click to re-verify.",
      "For layout/size bugs: one spec with before/after screenshots in the same test, then run_scenarios — do not code-read in a loop.",
      "Load visual-ui-debug skill when the user reports overlap, wrong size, wrong screen content, or visual regressions.",
    ],
    parameters: Type.Object({
      ids: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Run only these scenario ids. Omit to run the level's selection (thorough: every spec; standard: this task's, smoke and affected specs).",
        }),
      ),
      all: Type.Optional(
        Type.Boolean({
          description: "Standard level: run every spec, not only the affected ones — do this before calling a milestone done.",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = cfg(ctx);
      const toRun = effectiveScenarios(ctx);
      if (toRun.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "No scenarios defined or discovered. Call define_scenarios, add .pi/scenarios/*.spec.ts files, " +
                "or run /scenarios sync.",
            },
          ],
          details: { failed: true },
        };
      }

      const filterIds = params.ids?.length ? new Set(params.ids) : undefined;
      const unknown = params.ids?.filter((id) => !toRun.some((s) => s.id === id)) ?? [];
      if (unknown.length > 0) {
        return {
          content: [{ type: "text", text: `Unknown scenario id(s): ${unknown.join(", ")}` }],
          details: { failed: true },
        };
      }

      // Named ids run as asked; otherwise the level decides (standard: affected specs only).
      const { run: picked, note: levelNote } = filterIds
        ? { run: toRun, note: "" }
        : specsForLevel(ctx, toRun, params.all === true);
      const progress = runProgress(ctx, "Running scenarios");
      let result: Awaited<ReturnType<typeof runScenarios>>;
      try {
        result = await runScenarios(
          ctx.cwd,
          picked,
          config,
          signal,
          filterIds ? new Set([...filterIds]) : undefined,
          (p) => {
            progress.update(p);
            onUpdate?.({ content: [{ type: "text", text: `${formatScenarioProgress(p)}…` }], details: { progress: p } });
          },
        );
      } finally {
        progress.done();
      }
      const report = withVanishedNote(formatReport(result, picked)) + (levelNote ? `\n\n${levelNote}` : "");
      recordRunResults(result, picked);
      if (result.failed) {
        const classified = classifyScenarioFailure({
          report,
          preflightWarnings: result.preflightWarnings,
          weakSpecBlocking: Boolean(result.weakSpecWarnings?.some((w) => w.blocking)),
          missingFiles: result.missingFiles,
        });
        const classifiedText = formatClassifiedFailure(classified, "run_scenarios failed.", {
          screens: config.visionOnFailure ? result.screenshots : undefined,
        });
        return buildRunScenariosResponse(ctx, classifiedText, result, config, "");
      }
      return buildRunScenariosResponse(ctx, report, result, config, "");
    },
  });

  pi.registerTool({
    name: "capture_page_screenshot",
    label: "Capture Page Screenshot",
    description:
      "[Lane A — Playwright] Viewport screenshot via Playwright (.pi/playwright.config.ts). " +
      "Single frame only — cannot scroll. For below-the-fold canvas content, scroll in a spec via helpers/canvas-interaction. " +
      "Use for layout review in the SAME browser as scenarios — not after run_scenarios to re-prove clicks.",
    promptSnippet: "Playwright screenshot for layout (Lane A)",
    promptGuidelines: [
      "Use for visual layout checks when a full scenario is not needed.",
      "Requires .pi/playwright.config.ts webServer/baseURL — fix config if capture fails with connection refused.",
      "Blank/white result means canvas not ready or stale build — rebuild Flutter web if Dart changed; do not claim done.",
      "Do not use after run_scenarios passed to confirm the same interaction — use screenshot in the spec instead.",
      "If capture fails but live Chrome shows the app, browser_screenshot (Lane B) is OK for a cosmetic peek only.",
    ],
    parameters: Type.Object({
      urlPath: Type.Optional(
        Type.String({ description: "Path on the app baseURL (default / or qaShot.urlPath)." }),
      ),
      label: Type.Optional(Type.String({ description: "Short label for this capture (shown in the message)." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const urlPath = params.urlPath ?? config.qaShot.urlPath;
      const outputRel = ".pi/capture.jpg";
      const capture = await capturePageScreenshot(ctx.cwd, config, urlPath, outputRel, signal);
      if (!capture.ok) {
        return {
          content: [{ type: "text", text: `Screenshot capture failed:\n${capture.error ?? "unknown error"}` }],
          details: { ok: false },
          isError: true,
        };
      }
      const abs = path.join(ctx.cwd, capture.outputPath);
      const { images, paths } = await loadVisionImages([abs], config);
      const label = params.label ? ` (${params.label})` : "";
      const intro = `Page screenshot${label} at ${urlPath}:`;
      const content = await presentVisionToSession(ctx, intro, images, paths);
      return {
        content,
        details: { ok: true, path: capture.outputPath },
      };
    },
  });

  pi.registerTool({
    name: "confirm_visual_qa",
    label: "Confirm Visual QA",
    description:
      "After reviewing a QA screenshot, confirm whether the UI looks correct. " +
      "Required when qaShot mode is model. In human mode, the user must run /scenarios qa approve instead.",
    parameters: Type.Object({
      approved: Type.Boolean({ description: "True only if the screenshot matches the design intent." }),
      notes: Type.Optional(Type.String({ description: "What you checked or what still looks wrong." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      if (qaMode(config) === "human") {
        return {
          content: [
            {
              type: "text",
              text:
                "Visual QA is in human mode — the user must approve with /scenarios qa approve. " +
                "Your confirm_visual_qa call was ignored.",
            },
          ],
          details: { approved: false, mode: "human" },
          isError: true,
        };
      }
      if (!params.approved) {
        visualQaConfirmed = false;
        persist();
        const notes = params.notes ? `\nNotes: ${params.notes}` : "";
        return {
          content: [
            {
              type: "text",
              text: `Visual QA not approved.${notes}\nFix layout/CSS issues, then finish again for a new QA shot.`,
            },
          ],
          details: { approved: false },
        };
      }
      visualQaConfirmed = true;
      persist();
      const notes = params.notes ? `\nNotes: ${params.notes}` : "";
      return {
        content: [{ type: "text", text: `Visual QA approved.${notes} You may finish if scenarios also pass.` }],
        details: { approved: true },
      };
    },
  });

  pi.registerTool({
    name: "propose_scenario_cleanup",
    label: "Propose Scenario Cleanup",
    description:
      "Answer a scenario housekeeping review: list spec files to remove, each with a one-line reason. " +
      "The user confirms each removal and the extension deletes them — never delete spec files yourself.",
    promptSnippet: "Propose specs to scrap or a higher spec cap (user confirms)",
    parameters: Type.Object({
      remove: Type.Array(
        Type.Object({
          file: Type.String({ description: "Spec path exactly as listed in the review." }),
          reason: Type.String({ description: "One line: why it is no longer worth keeping." }),
        }),
        { description: "Specs to remove. Empty when every spec is still worth keeping." },
      ),
      cap: Type.Optional(
        Type.Object(
          {
            value: Type.Integer({ description: "New spec count before tidy hints/reviews fire." }),
            reason: Type.String({ description: "One line: why this project needs that many specs." }),
          },
          {
            description:
              "Propose a higher spec cap when the specs are all worth keeping and the project's breadth needs more than the current cap.",
          },
        ),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const review = activeReview;
      if (!review) {
        return {
          content: [{ type: "text", text: "No scenario review is pending — nothing to propose." }],
          details: { ok: false },
          isError: true,
        };
      }
      const config = cfg(ctx);
      const { valid, rejected } = validateProposal(ctx.cwd, review, params.remove);
      const notes: string[] = rejected.length ? [`Not allowed: ${rejected.join("; ")}`] : [];
      activeReview = null;
      syncTools(ctx);

      let chosen: typeof valid = [];
      if (ctx.hasUI && valid.length > 0) {
        const list = valid.map((r) => `  - ${r.file} — ${r.reason}`).join("\n");
        if (valid.length === 1) {
          if (await ctx.ui.confirm("Scenario cleanup", `The model suggests removing:\n${list}\n\nDelete it?`)) chosen = valid;
        } else {
          const all = `Delete all ${valid.length}`;
          const oneByOne = "Choose one by one";
          const pick = await ctx.ui.select(`Scenario cleanup — the model suggests removing:\n${list}`, [
            all,
            oneByOne,
            "Keep all",
          ]);
          if (pick === all) chosen = valid;
          else if (pick === oneByOne) {
            for (const r of valid) {
              if (await ctx.ui.confirm("Remove this spec?", `${r.file}\n${r.reason}`)) chosen.push(r);
            }
          }
        }
      }

      const deleted = deleteSpecFiles(
        ctx.cwd,
        config,
        chosen.map((r) => r.file),
      );
      if (deleted.length > 0) {
        const gone = new Set(deleted.map((f) => specPathKey(ctx.cwd, f)));
        for (const s of scenarios) if (gone.has(specPathKey(ctx.cwd, s.testFile))) delete lastRunById[s.id];
        scenarios = scenarios.filter((s) => !gone.has(specPathKey(ctx.cwd, s.testFile)));
        for (const k of gone) seenSpecFiles.delete(k);
        markReviewed(ctx.cwd, config, discoverScenariosFromDisk(ctx.cwd, config));
        persist();
      }
      const kept = valid.filter((r) => !deleted.includes(r.file)).map((r) => r.file);
      const parts: string[] = [];
      if (valid.length === 0) parts.push("Nothing proposed for removal — all specs kept.");
      else if (deleted.length) parts.push(`User approved — deleted: ${deleted.join(", ")}.${kept.length ? ` Kept: ${kept.join(", ")}.` : ""}`);
      else parts.push("User kept every spec.");

      let capSet: number | undefined;
      if (params.cap) {
        const current = config.housekeeping.maxSpecsBeforeAudit;
        const value = params.cap.value;
        if (!Number.isInteger(value) || value <= current || value > MAX_SPEC_CAP) {
          notes.push(`Cap ${value} not offered — it must be a whole number above the current ${current} and at most ${MAX_SPEC_CAP}.`);
        } else if (
          ctx.hasUI &&
          (await ctx.ui.confirm(
            "Scenario cap",
            `The model suggests raising the spec cap from ${current} to ${value}:\n${params.cap.reason}\n\nSave it to this project's scenarios config?`,
          ))
        ) {
          persistMaxSpecsBeforeAudit(ctx.cwd, value);
          configCache = null;
          capSet = value;
          parts.push(`User raised the spec cap to ${value}.`);
        } else {
          parts.push(`User kept the spec cap at ${current}.`);
        }
      }

      const text = [...parts, ...notes, "Review done — reply in one line and stop. Do not touch spec files."].join("\n");
      return { content: [{ type: "text", text }], details: { ok: true, deleted, kept, capSet } };
    },
  });

  pi.registerTool({
    name: "scenarios_housekeep",
    label: "Scenarios Housekeep",
    description:
      "Audit .pi/scenarios/ for scratch files, duplicate groups, and failed last runs. " +
      "Does not delete files — user runs /scenarios tidy, pick, and tidy apply/scratch yes.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const discovered = discoverScenariosFromDisk(ctx.cwd, config);
      const audit = auditScenarios(ctx.cwd, config, discovered, lastRunById);
      const toRun = effectiveScenarios(ctx);
      const specWarns = formatSpecPatternWarnings(scanSpecPatterns(ctx.cwd, config));
      const text =
        `${formatTidyReport(audit)}${specWarns.length ? `\n\n${specWarns.join("\n")}` : ""}\n\nAuto-run list (${toRun.length} spec(s) after scratch/canonical filter):\n` +
        `${formatDefinitions(toRun)}`;
      return {
        content: [{ type: "text", text }],
        details: { total: audit.total, autoRun: toRun.length },
      };
    },
  });

  pi.registerTool({
    name: "list_scenarios",
    label: "List Scenarios",
    description: "Show acceptance scenarios registered for the current task.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const toRun = effectiveScenarios(ctx);
      const discovered = discoverScenariosFromDisk(ctx.cwd, config);
      let text = formatDefinitions(scenarios);
      if (config.autoDiscoverScenarios && discovered.length > 0) {
        text += `\n\nEffective run list (${toRun.length}):\n${formatDefinitions(toRun)}`;
        if (discovered.length > scenarios.length) {
          text += `\n\n${formatDiscoveredSummary(discovered, scenarios)}`;
        }
      }
      return {
        content: [{ type: "text", text }],
        details: { count: toRun.length, registered: scenarios.length, discovered: discovered.length },
      };
    },
  });

  pi.registerCommand("scenarios", {
    description:
      "Acceptance scenarios — list | run | run-all | sync | level | tidy | review | cap | pick | clear | doctor | qa on|off|status|model|human|approve [project]",
    handler: async (args, ctx) => {
      const config = cfg(ctx);
      if (!config.enabled) {
        ctx.ui.notify("Scenarios extension is disabled in config.", "warning");
        return;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() ?? "list";

      if (sub === "list") {
        const toRun = effectiveScenarios(ctx);
        let msg = `Registered (${scenarios.length}):\n${formatDefinitions(scenarios)}`;
        if (config.autoDiscoverScenarios) {
          const discovered = discoverScenariosFromDisk(ctx.cwd, config);
          msg += `\n\n${formatDiscoveredSummary(discovered, scenarios)}`;
          if (toRun.length !== scenarios.length) {
            msg += `\n\nEffective run list (${toRun.length}):\n${formatDefinitions(toRun)}`;
          }
        }
        ctx.ui.notify(msg, "info");
        return;
      }

      if (sub === "cap") {
        const current = config.housekeeping.maxSpecsBeforeAudit;
        const total = discoverScenariosFromDisk(ctx.cwd, config).length;
        if (!parts[1]) {
          ctx.ui.notify(
            `Spec cap: ${current} (${total} spec(s) on disk). Tidy hints and model reviews start above it.\n/scenarios cap <n> — set it for this project.`,
            "info",
          );
          return;
        }
        const value = Number(parts[1]);
        if (!Number.isInteger(value) || value < 1 || value > MAX_SPEC_CAP) {
          ctx.ui.notify(`Use a whole number from 1 to ${MAX_SPEC_CAP}.`, "warning");
          return;
        }
        const file = persistMaxSpecsBeforeAudit(ctx.cwd, value);
        configCache = null;
        ctx.ui.notify(`Spec cap set to ${value} for this project (${total} on disk) — saved to ${file}.`, "info");
        return;
      }

      if (sub === "level") {
        const wanted = parts[1]?.toLowerCase();
        if (!wanted) {
          ctx.ui.notify(
            `Scenario level: ${config.level}.\n` +
              "  thorough — every spec on every code change, pass screenshots reviewed, edge cases asked for (default)\n" +
              "  standard — this task's, smoke and affected specs; screenshots on failure; full run before a milestone\n" +
              "/scenarios level thorough|standard [user] — saved for this project, or for every project with user.",
            "info",
          );
          return;
        }
        if (!isScenarioLevel(wanted)) {
          ctx.ui.notify("Use /scenarios level thorough or /scenarios level standard (add user to save it for every project).", "warning");
          return;
        }
        const file = persistScenarioLevel(ctx.cwd, wanted, parts[2]?.toLowerCase() === "user" ? "user" : "project");
        configCache = null;
        ctx.ui.notify(`Scenario level: ${wanted} (saved to ${file}).`, "info");
        return;
      }

      if (sub === "review") {
        if (!ctx.isIdle()) {
          ctx.ui.notify("Wait until the agent is idle, then /scenarios review.", "warning");
          return;
        }
        const nothing = startReview(ctx, [...scenarios.map((s) => s.testFile), ...specsCreatedThisSession]);
        if (nothing) ctx.ui.notify(nothing, "info");
        return;
      }

      if (sub === "clear") {
        scenarios = [];
        fixAttempts = 0;
        qaFixAttempts = 0;
        visualQaConfirmed = false;
        persist();
        ctx.ui.notify("Cleared registered scenarios.", "info");
        return;
      }

      if (sub === "qa") {
        const action = parts[1]?.toLowerCase();
        const scope = parts[2]?.toLowerCase() === "project" || parts[3]?.toLowerCase() === "project" ? "project" : "user";
        if (action === "on") {
          const file = persistQaShotEnabled(ctx.cwd, true, scope);
          configCache = null;
          visualQaConfirmed = false;
          persist();
          syncTools(ctx);
          ctx.ui.notify(`Visual QA shot enabled (saved to ${file}). Mode: ${cfg(ctx).qaShot.mode}`, "info");
          return;
        }
        if (action === "off") {
          const file = persistQaShotMode(ctx.cwd, "off", scope);
          configCache = null;
          persist();
          syncTools(ctx);
          ctx.ui.notify(`Visual QA shot disabled / mode off (saved to ${file}).`, "info");
          return;
        }
        if (action === "model" || action === "human") {
          const file = persistQaShotMode(ctx.cwd, action, scope);
          configCache = null;
          visualQaConfirmed = false;
          persist();
          syncTools(ctx);
          ctx.ui.notify(`Visual QA mode: ${action} (saved to ${file}).`, "info");
          return;
        }
        if (action === "approve") {
          visualQaConfirmed = true;
          persist();
          ctx.ui.notify("Visual QA approved by user. Agent may finish if other gates pass.", "info");
          return;
        }
        const fresh = cfg(ctx);
        ctx.ui.notify(
          `Visual QA: enabled=${fresh.qaShot.enabled ? "yes" : "no"}, mode=${fresh.qaShot.mode}, ` +
            `blocking=${fresh.qaShot.blocking ? "yes" : "no"} (from scenarios.config.json layers)\n` +
            `Commands: /scenarios qa on|off|model|human|approve|status [project]`,
          "info",
        );
        return;
      }

      if (sub === "doctor") {
        const status = await toolchainStatus(ctx.cwd, config);
        const lines = status.map((s) => `${s.ok ? "[ok]" : "[missing]"} ${s.name}${s.ok ? "" : ` — ${s.hint}`}`);
        lines.unshift(...formatStackDoctorLines(detectStacks(ctx.cwd)), "");
        const discovered = discoverScenariosFromDisk(ctx.cwd, config);
        if (config.autoDiscoverScenarios && discovered.length > 0) {
          lines.push("", formatDiscoveredSummary(discovered, scenarios));
        }
        const preflight = collectPreflightWarnings(ctx.cwd, config);
        if (preflight.length > 0) {
          lines.push("", ...preflight);
        }
        ctx.ui.notify(
          lines.length ? `Scenario toolchain:\n${lines.join("\n")}` : "Scenarios extension enabled (no probes configured).",
          status.every((s) => s.ok) && preflight.length === 0 ? "info" : "warning",
        );
        return;
      }

      if (sub === "tidy" || sub === "audit") {
        const action = parts[1]?.toLowerCase();
        const confirm = parts[2]?.toLowerCase() === "yes" || parts[1]?.toLowerCase() === "yes";
        const discovered = discoverScenariosFromDisk(ctx.cwd, config);

        if (action === "scratch" || (sub === "tidy" && parts[1]?.toLowerCase() === "scratch")) {
          if (!confirm && parts[parts.length - 1]?.toLowerCase() !== "yes") {
            const audit = auditScenarios(ctx.cwd, config, discovered, lastRunById);
            ctx.ui.notify(
              `Scratch files (${audit.scratch.length}):\n${audit.scratch.map((s) => `  - ${s.testFile}`).join("\n") || "  (none)"}\n\n/scenarios tidy scratch yes — delete these`,
              "warning",
            );
            return;
          }
          const result = deleteScratchFiles(ctx.cwd, discovered);
          ctx.ui.notify(
            result.deleted.length
              ? `Deleted scratch:\n${result.deleted.map((f) => `  - ${f}`).join("\n")}`
              : "No scratch files to delete.",
            result.deleted.length ? "info" : "warning",
          );
          return;
        }

        if (action === "apply") {
          if (!confirm && parts[2]?.toLowerCase() !== "yes") {
            ctx.ui.notify(
              "Deletes non-canonical specs in groups where you ran /scenarios pick <group> <n>.\n/scenarios tidy apply yes",
              "warning",
            );
            return;
          }
          const result = applyCanonicalDeletions(ctx.cwd, config, discovered);
          let msg = result.deleted.length
            ? `Deleted:\n${result.deleted.map((f) => `  - ${f}`).join("\n")}`
            : "Nothing deleted.";
          if (result.skipped.length) {
            msg += `\n\nSkipped:\n${result.skipped.map((s) => `  - ${s}`).join("\n")}`;
          }
          ctx.ui.notify(msg, result.deleted.length ? "info" : "warning");
          return;
        }

        const audit = auditScenarios(ctx.cwd, config, discovered, lastRunById);
        const specWarns = formatSpecPatternWarnings(scanSpecPatterns(ctx.cwd, config));
        const report = specWarns.length
          ? `${formatTidyReport(audit)}\n\n${specWarns.join("\n")}`
          : formatTidyReport(audit);
        ctx.ui.notify(report, audit.total > audit.maxRecommended || specWarns.length ? "warning" : "info");
        return;
      }

      if (sub === "pick") {
        const group = parts[1];
        const n = Number(parts[2]);
        if (!group || Number.isNaN(n)) {
          ctx.ui.notify("Usage: /scenarios pick <group> <number>\nRun /scenarios tidy to see groups and numbers.", "warning");
          return;
        }
        const discovered = discoverScenariosFromDisk(ctx.cwd, config);
        const result = setCanonicalPick(ctx.cwd, config, group, n, discovered);
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
        return;
      }

      if (sub === "sync") {
        const discovered = discoverScenariosFromDisk(ctx.cwd, config);
        if (discovered.length === 0) {
          ctx.ui.notify(`No discoverable spec files under ${config.scenariosDir}.`, "warning");
          return;
        }
        scenarios = mergeScenarioLists(scenarios, discovered);
        persist();
        ctx.ui.notify(
          `Synced ${discovered.length} file(s) from disk — ${scenarios.length} scenario(s) registered this session.\n\n${formatDefinitions(scenarios)}`,
          "info",
        );
        return;
      }

      if (sub === "run-all") {
        const discovered = discoverScenariosFromDisk(ctx.cwd, config);
        scenarios = mergeScenarioLists(scenarios, discovered);
        persist();
        const toRun = effectiveScenarios(ctx);
        if (toRun.length === 0) {
          ctx.ui.notify("No scenarios on disk or registered.", "warning");
          return;
        }
        const progress = runProgress(ctx, "Running scenarios");
        let result: Awaited<ReturnType<typeof runScenarios>>;
        try {
          result = await runScenarios(ctx.cwd, toRun, config, undefined, undefined, progress.update);
        } finally {
          progress.done();
        }
        recordRunResults(result, toRun);
        const report = withVanishedNote(formatReport(result, toRun));
        if (result.failed) {
          ctx.ui.notify("Scenarios failed — sending failures to the agent to fix.", "error");
          const failureShots = config.visionOnFailure ? (result.screenshots ?? []) : [];
          await sendVisionFollowUp(ctx, `Acceptance scenarios failed. Fix these:\n\n${report}`, failureShots, config);
        } else {
          const passShots = passShotsWanted(config) ? (result.outputScreenshots ?? []) : [];
          if (passShots.length > 0) {
            await sendVisionFollowUp(ctx, `All scenarios passed.\n\n${report}`, passShots, config);
          } else {
            ctx.ui.notify(result.ran ? `All scenarios passed.\n\n${report}` : "No scenario checks ran.", "info");
          }
        }
        return;
      }

      if (sub === "run") {
        const toRun = effectiveScenarios(ctx);
        if (toRun.length === 0) {
          ctx.ui.notify("No scenarios defined or discovered. Try /scenarios sync.", "warning");
          return;
        }
        const progress = runProgress(ctx, "Running scenarios");
        let result: Awaited<ReturnType<typeof runScenarios>>;
        try {
          result = await runScenarios(ctx.cwd, toRun, config, undefined, undefined, progress.update);
        } finally {
          progress.done();
        }
        recordRunResults(result, toRun);
        const report = withVanishedNote(formatReport(result, toRun));
        if (result.failed) {
          ctx.ui.notify("Scenarios failed — sending failures to the agent to fix.", "error");
          const shots = config.visionOnFailure ? (result.screenshots ?? []) : [];
          await sendVisionFollowUp(ctx, `Acceptance scenarios failed. Fix these:\n\n${report}`, shots, config);
        } else {
          ctx.ui.notify(result.ran ? "All scenarios passed." : "No scenario checks ran.", "info");
        }
        return;
      }

      ctx.ui.notify(
        "Usage: /scenarios list | run | run-all | sync | level [thorough|standard] [user] | tidy | review | cap | pick <group> <n> | clear | doctor | qa on|off|model|human|approve|status [project]",
        "info",
      );
    },
  });
}
