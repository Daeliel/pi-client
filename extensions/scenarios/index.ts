import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import {
  isResultBar,
  isScenarioLevel,
  loadConfig,
  persistResultBar,
  persistScenariosSetting,
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
import { findJourneySpecs, formatSpecPatternWarnings, scanSpecPatterns } from "./spec-audit";
import { autopilotRunning, markFromSpecResults } from "../plan/marks";
import { loadConfig as loadPlanConfig } from "../plan/config";
import { ChangeMeter, describeLimits, formatHowToCheck, formatSize, isLightLevel, overLimit, type LightLevel } from "./light";
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
import { registerSkipHandler, skipAwareSignal, skipMark, skippedSince } from "../shared/gate-skip";
import { buildSpecFromRecording, PlaySession, validateActions, type PlayAction, type StepResult } from "./play";
import { syncOwnedTools } from "../shared/tool-activation";
import { attemptNotes, giveUpNote, RepeatTracker } from "../shared/gate-messages";
import { playtestOn } from "../shared/playtest";

const TOOLS = [
  "scaffold_scenario",
  "define_scenarios",
  "run_scenarios",
  "capture_page_screenshot",
  "play",
  "play_save_spec",
  "confirm_visual_qa",
  "set_result_bar",
  "scenarios_housekeep",
  "list_scenarios",
  "propose_scenario_cleanup",
  "light_change",
  "ask_user_to_verify",
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
  /** Each code file as it was before this change set, to measure a light change. */
  const meter = new ChangeMeter();
  /** The model said this change is light; the gate checks the size at the end. */
  let lightClaim: { why: string; howToCheck: string[] } | null = null;
  /** Identical failures in a row, from the gate and run_scenarios alike. */
  const askTracker = new RepeatTracker();
  /** Set once the same failure repeated askUserAfter times: the model may ask the user to look. */
  let askOffer: { specs: string[] } | null = null;

  function clearChanges() {
    changedFiles.clear();
    meter.clear();
    lightClaim = null;
    askTracker.reset();
    askOffer = null;
  }
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
  function hasJourneySpec(cwd: string, config: ScenariosConfig): boolean {
    return findJourneySpecs(cwd, config).length > 0;
  }

  /** Play mode session (one at a time; ends with the run). */
  let play: PlaySession | null = null;

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

  // /skip: QA is asked before scenarios (gate-skip lane order), while the changed files
  // that arm it are still known.
  registerSkipHandler("qa", () => {
    if (!configCache || !shouldRunQaGate(configCache)) return null;
    visualQaConfirmed = true;
    qaFixAttempts = 0;
    persist();
    return "pending screenshot review";
  });
  registerSkipHandler("scenarios", () => {
    if (changedFiles.size === 0) return null;
    const what = `${changedFiles.size} changed file(s)`;
    clearChanges();
    fixAttempts = 0;
    repeats.reset();
    persist();
    return what;
  });

  function recordRunResults(result: Awaited<ReturnType<typeof runScenarios>>, ran: ScenarioDefinition[], ctx?: ExtensionContext) {
    for (const c of result.checks) {
      lastRunById[c.scenarioId] = c.status;
    }
    persist();
    // A plan's boxes follow evidence in every mode: a passing spec ticks its item.
    if (ctx) {
      const changed = markFromSpecResults(ctx.cwd, result.checks);
      if (changed.length && ctx.hasUI) ctx.ui.notify(`Plan: ${changed.join(", ")}.`, "info");
    }
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
    if (shouldInjectWebProcedure(ctx.cwd, changedFiles)) wanted.push("capture_page_screenshot", "play", "play_save_spec");
    if (qaMode(config) === "model") wanted.push("confirm_visual_qa");
    if (config.bar === "unset") wanted.push("set_result_bar");
    if (activeReview) wanted.push("propose_scenario_cleanup");
    if (config.light !== "off" && !autopilotRunning(ctx.cwd, loadPlanConfig(ctx.cwd).blueprintPath)) wanted.push("light_change");
    if (askOffer && ctx.hasUI) wanted.push("ask_user_to_verify");
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

  // Remember each file before its first edit, so a light change can be measured.
  pi.on("tool_call", async (event, ctx) => {
    if (!isEditTool(event.toolName)) return;
    const p = extractEditPath("input" in event ? event.input : undefined);
    if (p) meter.snapshot(ctx.cwd, p);
  });

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

  // Play sessions end when the run does: a browser and dev server are not left behind.
  pi.on("session_shutdown", async () => {
    play?.stop();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    play?.stop();
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
        clearChanges();
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
    askTracker.reset();
    askOffer = null;
    if (playtestOn()) return; // playtest mode: the user is the check
    const config = cfg(ctx);
    if (!config.enabled) return;

    if (!config.blocking) {
      clearChanges();
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
      bar: config.bar,
      light: config.light,
    });

    return {
      systemPrompt: `${event.systemPrompt}\n\n${procedure}`,
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (playtestOn()) return; // playtest mode: the user is the check
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
    if (playtestOn()) return; // playtest mode: the user is the check
    const config = cfg(ctx);
    if (!config.enabled || !config.blocking) return;
    if (config.gateOnCodeChanges && ![...changedFiles].some(isCodePath)) {
      // Docs/notes/assets only — nothing behavioural to prove. Forget them so they
      // do not make a later unrelated turn look like a code change.
      if (changedFiles.size > 0) {
        clearChanges();
        persist();
      }
      return;
    }
    if (isGateClaimed()) return;

    if (lightClaim) {
      const size = meter.measure();
      const over = meter.covers(ctx.cwd, changedFiles) ? overLimit(config.light, size) : "the change could not be measured";
      if (!over) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Light change (${formatSize(size)}) — specs not run.\n${formatHowToCheck(lightClaim.howToCheck)}`, "info");
        }
        clearChanges();
        fixAttempts = 0;
        qaFixAttempts = 0;
        persist();
        return;
      }
      if (ctx.hasUI) ctx.ui.notify(`The change grew past a ${config.light} light change (${over}) — running the specs.`, "warning");
      lightClaim = null;
    }

    await withGateWorkingMessage(ctx, "Acceptance gates (scenarios/QA) — inference idle · /skip to move on", async (status) => {
      const mark = skipMark();
      const toRun = effectiveScenarios(ctx);

      if (config.requireDefined && toRun.length === 0) {
        if (fixAttempts >= config.maxFixAttempts) {
          ctx.ui.notify(
            `No acceptance scenarios defined after ${config.maxFixAttempts} attempts — stopping the fix loop.`,
            "error",
          );
          leaveGiveUpNote(fixAttempts, "no acceptance scenarios were defined or written for the code change");
          clearChanges();
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
        const result = await runScenarios(ctx.cwd, picked, config, skipAwareSignal("scenarios", ctx.signal), undefined, (p) =>
          status.step(formatScenarioProgress(p)),
        );
        if (skippedSince(mark, "scenarios")) return;
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
            clearChanges();
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
          ) + askUserOffer(ctx, config, report, result);
          const shots = config.visionOnFailure ? (result.screenshots ?? []) : [];
          await sendVisionFollowUp(ctx, intro, shots, config);
          return;
        }
        recordRunResults(result, picked, ctx);
      }
      if (levelNote && ctx.hasUI) ctx.ui.notify(levelNote, "info");

      // Product bar: green specs are not enough — the main flow must be proven end to end
      // through real input, or "everything passes" can mean "nobody can use it".
      if (config.bar === "product" && !hasJourneySpec(ctx.cwd, config)) {
        if (fixAttempts < config.maxFixAttempts && tryClaimGate("scenarios")) {
          fixAttempts += 1;
          persist();
          pi.sendUserMessage(
            `Result bar is **product**, and no @journey spec exists (attempt ${fixAttempts}/${config.maxFixAttempts}). ` +
              `Write one under ${config.scenariosDir}: the main thing a user comes to do, start to finish, every step through real input ` +
              `(clicks, keys, typing — no app functions for the user's actions; hooks only to set conditions, each declared as // @hooks: name — why). ` +
              `Title ends with @journey. Then run_scenarios. If a step cannot be done through the UI, that is the bug to fix.`,
            { deliverAs: "followUp" },
          );
          return;
        }
      }

      if (shouldRunQaGate(config)) {
        if (qaFixAttempts >= config.maxFixAttempts) {
          ctx.ui.notify(
            `Visual QA not confirmed after ${config.maxFixAttempts} attempts — stopping the fix loop. Run /scenarios qa on and try again.`,
            "error",
          );
          clearChanges();
          scenarios = [];
          fixAttempts = 0;
          qaFixAttempts = 0;
          visualQaConfirmed = false;
          persist();
          return;
        }

        status.step("capturing visual QA screenshot");
        const capture = await captureQaShot(ctx.cwd, config, skipAwareSignal("qa", ctx.signal));
        if (skippedSince(mark, "qa")) return;
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

      clearChanges();
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

  /** After askUserAfter identical failures, offer ask_user_to_verify (the text to append, or ""). */
  function askUserOffer(
    ctx: ExtensionContext,
    config: ScenariosConfig,
    report: string,
    result: Awaited<ReturnType<typeof runScenarios>>,
  ): string {
    askTracker.repeated(report);
    if (!ctx.hasUI || config.askUserAfter <= 0 || askTracker.streak < config.askUserAfter) return "";
    askOffer = { specs: result.checks.filter((c) => c.status === "fail").map((c) => c.scenarioId) };
    syncTools(ctx);
    return (
      `\n\nThe same failure came ${askTracker.streak} times in a row. If what fails is something a person can judge at a glance — ` +
      `a colour, how it looks, how it feels — call ask_user_to_verify: say what to look at and where. ` +
      `If they say it is right, the check counts as passed (verified by user). Do not use it for logic, data, numbers or errors.`
    );
  }

  pi.registerTool({
    name: "light_change",
    label: "Light Change",
    description:
      "Say this change is small and low-risk (a colour, a label, a spacing tweak, one condition) so the scenario specs are not run for it. " +
      "Lint, typecheck and unit tests still run. The extension measures the change; if it is bigger than this project allows, the specs run as usual.",
    promptSnippet: "Mark a small, low-risk change so the specs are not run for it",
    parameters: Type.Object({
      why: Type.String({ description: "Why this is small and low-risk, in one sentence." }),
      howToCheck: Type.Array(Type.String(), {
        description: "1-4 steps a person can follow to see the change works (where to go, what to look at, what they should see).",
        minItems: 1,
        maxItems: 4,
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: {}, isError });
      if (config.light === "off") return text("Light changes are off for this project — the specs run for every code change.", true);
      const size = meter.measure();
      const over = size.files > 0 ? overLimit(config.light, size) : null;
      if (over) {
        return text(
          `Not a light change: ${over}. This project allows ${describeLimits(config.light)} (${config.light}). ` +
            "Write or run the specs as usual.",
          true,
        );
      }
      lightClaim = { why: params.why, howToCheck: params.howToCheck };
      return text(
        `Accepted as a light change (${config.light}: ${describeLimits(config.light)}; now ${formatSize(size)}). ` +
          "The specs will not run for it, unless the change grows past that. Lint, typecheck and unit tests still run. " +
          `End your reply to the user with exactly this:\n\n${formatHowToCheck(params.howToCheck)}`,
      );
    },
  });

  pi.registerTool({
    name: "ask_user_to_verify",
    label: "Ask User To Verify",
    description:
      "Only after the same check failed several times, for things a person judges at a glance (a colour, how it looks, how it feels): " +
      "ask the user to look. Yes = the check counts as passed (verified by user). No = you get their note.",
    promptSnippet: "Ask the user to look at something a person judges at a glance",
    parameters: Type.Object({
      what: Type.String({ description: "What should be right, in plain words (e.g. 'the Save button is green')." }),
      howToLook: Type.String({ description: "Where to look and how to get there (e.g. 'open http://localhost:5173, Settings tab')." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: {}, isError });
      if (!askOffer || !ctx.hasUI) {
        return text(`Not now: this is offered only after the same failure repeats ${cfg(ctx).askUserAfter} times.`, true);
      }
      const offer = askOffer;
      const yes = "Yes — it is right";
      const choice = await ctx.ui.select(`Please check: ${params.what}\nHow to look: ${params.howToLook}`, [yes, "No — something is off"]);
      if (choice === undefined) return text("The user did not answer. Keep fixing, or tell them what still fails.");
      if (choice === yes) {
        const file = path.join(ctx.cwd, cfg(ctx).scenariosDir, "verified-by-user.json");
        let records: unknown[] = [];
        try {
          records = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
        } catch {
          records = [];
        }
        records.push({ at: new Date().toISOString(), what: params.what, howToLook: params.howToLook, specs: offer.specs });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`, "utf8");
        clearChanges();
        scenarios = [];
        fixAttempts = 0;
        qaFixAttempts = 0;
        visualQaConfirmed = false;
        persist();
        syncTools(ctx);
        ctx.ui.notify(`Verified by user: ${params.what}`, "info");
        return text(
          `The user looked and says it is right: "${params.what}". Recorded as verified by user` +
            (offer.specs.length ? ` (failing spec(s): ${offer.specs.join(", ")})` : "") +
            ". The scenario gate is closed for this change. Finish: tell the user it was verified by them, not by the specs" +
            (offer.specs.length ? ", and that the spec(s) above may check the wrong thing." : "."),
        );
      }
      const note = (await ctx.ui.input("What is off?", "e.g. still blue, too dark, wrong place")) ?? "";
      askTracker.reset();
      askOffer = null;
      syncTools(ctx);
      return text(
        `The user looked and says it is NOT right${note.trim() ? `: "${note.trim()}"` : " (no note)"}. ` +
          "Fix that — their words outrank the spec — then the specs run again.",
      );
    },
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
      recordRunResults(result, picked, ctx);
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
        return buildRunScenariosResponse(ctx, classifiedText + askUserOffer(ctx, config, report, result), result, config, "");
      }
      askTracker.reset();
      askOffer = null;
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

  const PlayActionSchema = Type.Object({
    do: Type.Union(
      ["click", "move", "drag", "press", "hold", "type", "wheel", "wait", "goto"].map((v) => Type.Literal(v)),
      { description: "What to do." },
    ),
    x: Type.Optional(Type.Number({ description: "Page x in pixels (same as the screenshot unless a scale is reported)." })),
    y: Type.Optional(Type.Number()),
    toX: Type.Optional(Type.Number({ description: "drag: end x" })),
    toY: Type.Optional(Type.Number({ description: "drag: end y" })),
    selector: Type.Optional(Type.String({ description: "click: CSS selector instead of x/y (DOM apps)." })),
    text: Type.Optional(Type.String({ description: "click: visible text to click; type: text to type." })),
    key: Type.Optional(Type.String({ description: "press/hold: e.g. 'E', 'ArrowLeft', 'Space', 'Control+Z'." })),
    ms: Type.Optional(Type.Number({ description: "hold/wait: milliseconds." })),
    dx: Type.Optional(Type.Number()),
    dy: Type.Optional(Type.Number({ description: "wheel: scroll amount." })),
    url: Type.Optional(Type.String({ description: "goto: path or URL." })),
    button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])),
    double: Type.Optional(Type.Boolean({ description: "click: double-click." })),
  });

  /** Text + screenshot for a play step; scale noted when the image was shrunk. */
  async function playResponse(ctx: ExtensionContext, res: StepResult, header: string, config: ScenariosConfig) {
    const vp = res.viewport;
    const scale = vp && vp.width > config.maxImageWidth ? config.maxImageWidth / vp.width : 1;
    const coords = vp
      ? scale < 1
        ? `Page is ${vp.width}×${vp.height}; the screenshot is shrunk ×${scale.toFixed(2)} — divide screenshot x/y by ${scale.toFixed(2)} for page coordinates.`
        : `Page is ${vp.width}×${vp.height}; screenshot pixels = page coordinates.`
      : "";
    const lines = [
      header,
      res.ok ? "" : `Action failed: ${res.error}`,
      `URL: ${res.url}${res.title ? ` · ${res.title}` : ""}`,
      coords,
      res.consoleErrors.length ? `Console errors since last step:\n  ${res.consoleErrors.slice(0, 5).join("\n  ")}` : "",
    ].filter(Boolean);
    const text = lines.join("\n");
    if (!res.shot) return [{ type: "text" as const, text }];
    const { images, paths } = await loadVisionImages([res.shot], config);
    return images.length
      ? await presentVisionToSession(ctx, text, images, paths, { checklist: false })
      : [{ type: "text" as const, text: `${text}\n(screenshot could not be loaded)` }];
  }

  pi.registerTool({
    name: "play",
    label: "Play",
    description:
      "[Lane A — explore] Use the app like a user, one step at a time: move, click, drag, press or hold keys, type, scroll, wait — and see a screenshot after each step. " +
      "Same Playwright browser and config as the specs. Use it to find out how the app behaves (where things are on a canvas, what a key does, how a screen looks) " +
      "before writing a spec; then play_save_spec turns the path you found into one. Exploring is not proof — run_scenarios is.",
    promptSnippet: "Try the app step by step with screenshots (explore)",
    promptGuidelines: [
      "First call with no actions (optionally url) to open the app and look; then a few actions per call, looking at each screenshot before the next.",
      "When a path works, call play_save_spec and add assertions — do not prove a fix with play alone.",
    ],
    parameters: Type.Object({
      actions: Type.Optional(Type.Array(PlayActionSchema, { description: "Done in order as one step (max 12). Omit to just look." })),
      url: Type.Optional(Type.String({ description: "Open (or restart at) this path/URL, e.g. '/' or '/settings'." })),
      settleMs: Type.Optional(Type.Number({ description: "Wait after the actions before the screenshot (default 300)." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const actions = (params.actions ?? []) as PlayAction[];
      if (actions.length > 0) {
        const problem = validateActions(actions);
        if (problem) return { content: [{ type: "text", text: `play: ${problem}` }], details: { ok: false }, isError: true };
      }
      try {
        if (!play?.running || params.url) {
          ensureWebScaffold(ctx.cwd, config, [{ id: "play", title: "play", steps: "-", testFile: ".pi/scenarios/play", kind: "web" }]);
          play = play ?? new PlaySession(ctx.cwd, config);
          const first = await play.start(params.url ?? config.qaShot.urlPath ?? "/", signal);
          if (actions.length === 0) {
            return { content: await playResponse(ctx, first, `Play session open at ${play.startUrl} (step 0/${config.playMaxSteps}).`, config), details: { step: 0 } };
          }
        }
        if (actions.length === 0) {
          return { content: [{ type: "text", text: "Session already open — give actions, or url to restart." }], details: {} };
        }
        if (play.steps >= config.playMaxSteps) {
          return {
            content: [{ type: "text", text: `Play step limit (${config.playMaxSteps}) reached — save what you found with play_save_spec, or restart with url.` }],
            details: { ok: false },
            isError: true,
          };
        }
        const res = await play.run(actions, Math.min(Math.max(params.settleMs ?? 300, 0), 10_000), signal);
        return {
          content: await playResponse(ctx, res, `Step ${play.steps}/${config.playMaxSteps}: ${res.ok ? "done" : "failed"}.`, config),
          details: { step: play.steps, ok: res.ok },
          isError: !res.ok,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Play session failed: ${(e as Error).message}\nCheck ${config.playwrightConfig} (webServer command, baseURL).` }],
          details: { ok: false },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "play_save_spec",
    label: "Save Play Path as Spec",
    description:
      "Turn the steps that worked in the current play session into a Playwright spec under .pi/scenarios/ (replays them and screenshots the end). " +
      "Then add the assertions it marks TODO and run_scenarios.",
    parameters: Type.Object({
      name: Type.String({ description: "File stem, e.g. 'travel-stage' → .pi/scenarios/travel-stage.spec.ts" }),
      title: Type.String({ description: "Test title: the user-visible flow." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      if (!play || play.recorded.length === 0) {
        return { content: [{ type: "text", text: "Nothing recorded — play some steps first (only steps that worked are kept)." }], details: { ok: false }, isError: true };
      }
      const stem = params.name.toLowerCase().replace(/\.spec\.ts$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "played-flow";
      const rel = path.posix.join(config.scenariosDir.replace(/\\/g, "/"), `${stem}.spec.ts`);
      const abs = path.join(ctx.cwd, rel);
      if (fs.existsSync(abs)) {
        return { content: [{ type: "text", text: `${rel} exists — pick another name, or add these steps to it by hand.` }], details: { ok: false }, isError: true };
      }
      const hasConsoleHelper = fs.existsSync(path.join(ctx.cwd, config.scenariosDir, "helpers", "console-capture.ts"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buildSpecFromRecording({ name: stem, title: params.title, startUrl: play.startUrl, steps: play.recorded, hasConsoleHelper }), "utf8");
      return {
        content: [
          {
            type: "text",
            text:
              `Wrote ${rel} from ${play.recorded.length} step(s). Next: fill in its // @covers line, replace the TODO with assertions on the screen it ends on, then run_scenarios. ` +
              "It is auto-discovered; register it with define_scenarios if this task needs it.",
          },
        ],
        details: { ok: true, file: rel },
      };
    },
  });

  pi.registerTool({
    name: "set_result_bar",
    label: "Set Result Bar",
    description:
      "Record what 'done' means for this project, once: product (a person must be able to use everything — fill the gaps the brief leaves, prove main flows with @journey specs) " +
      "or spec (build what is written; record gaps as questions). Decide from the user's request; ask the user first when it does not say.",
    promptSnippet: "Record: product or spec (what done means here)",
    parameters: Type.Object({
      bar: Type.Union([Type.Literal("product"), Type.Literal("spec")]),
      reason: Type.String({ description: "One line: what in the request decided it (or that the user chose it)." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const file = persistResultBar(ctx.cwd, params.bar);
      configCache = null;
      syncTools(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(`Result bar: ${params.bar} — ${params.reason}\n(saved to ${file}; change with /scenarios bar product|spec)`, "info");
      }
      return {
        content: [
          {
            type: "text",
            text:
              params.bar === "product"
                ? "Result bar: product. Build what a person needs to use each feature (input, feedback, stage hand-offs), and prove the main flow with a @journey spec — real input only."
                : "Result bar: spec. Build what the brief states; write gaps down as questions or assumptions for the user.",
          },
        ],
        details: { bar: params.bar },
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
      "Acceptance scenarios — list | run | run-all | sync | level | bar | light | ask-after | tidy | review | cap | pick | clear | doctor | qa on|off|status|model|human|approve [project]",
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

      if (sub === "bar") {
        const wanted = parts[1]?.toLowerCase();
        if (!wanted) {
          ctx.ui.notify(
            `Result bar: ${config.bar}.\n` +
              "  product — a person must be able to use everything; gaps filled; main flows proven by @journey specs\n" +
              "  spec    — build what the brief states; gaps recorded as questions\n" +
              "  unset   — the model decides on the first real build (asks you when unclear)\n" +
              "/scenarios bar product|spec|unset — saved for this project.",
            "info",
          );
          return;
        }
        if (!isResultBar(wanted)) {
          ctx.ui.notify("Use /scenarios bar product, spec or unset.", "warning");
          return;
        }
        const file = persistResultBar(ctx.cwd, wanted);
        configCache = null;
        syncTools(ctx);
        ctx.ui.notify(`Result bar: ${wanted} (saved to ${file}).`, "info");
        return;
      }

      if (sub === "light") {
        const wanted = parts[1]?.toLowerCase();
        if (!wanted) {
          ctx.ui.notify(
            `Light changes: ${config.light}. A small change the model calls light skips the specs; lint, typecheck and unit tests still run.\n` +
              `  strict   — ${describeLimits("strict")}\n` +
              `  standard — ${describeLimits("standard")} (default)\n` +
              `  loose    — ${describeLimits("loose")}\n` +
              `  off      — every code change runs the specs\n` +
              "/scenarios light strict|standard|loose|off [user] — saved for this project, or for every project with user.",
            "info",
          );
          return;
        }
        if (!isLightLevel(wanted)) {
          ctx.ui.notify("Use /scenarios light strict, standard, loose or off (add user to save it for every project).", "warning");
          return;
        }
        const file = persistScenariosSetting(ctx.cwd, { light: wanted as LightLevel }, parts[2]?.toLowerCase() === "user" ? "user" : "project");
        configCache = null;
        syncTools(ctx);
        ctx.ui.notify(`Light changes: ${wanted} — ${describeLimits(wanted as LightLevel)} (saved to ${file}).`, "info");
        return;
      }

      if (sub === "ask-after") {
        if (!parts[1]) {
          ctx.ui.notify(
            `Ask you to look: after ${config.askUserAfter || "never (0)"} identical failure(s) of something a person judges at a glance.\n` +
              "/scenarios ask-after <n> [user] — 0 turns it off.",
            "info",
          );
          return;
        }
        const value = Number(parts[1]);
        if (!Number.isInteger(value) || value < 0 || value > 20) {
          ctx.ui.notify("Use a whole number from 0 (off) to 20.", "warning");
          return;
        }
        const file = persistScenariosSetting(ctx.cwd, { askUserAfter: value }, parts[2]?.toLowerCase() === "user" ? "user" : "project");
        configCache = null;
        ctx.ui.notify(`Ask you to look: ${value === 0 ? "off" : `after ${value} identical failure(s)`} (saved to ${file}).`, "info");
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
        recordRunResults(result, toRun, ctx);
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
        recordRunResults(result, toRun, ctx);
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
        "Usage: /scenarios list | run | run-all | sync | level [thorough|standard] [user] | bar [product|spec|unset] | tidy | review | cap | pick <group> <n> | clear | doctor | qa on|off|model|human|approve|status [project]",
        "info",
      );
    },
  });
}
