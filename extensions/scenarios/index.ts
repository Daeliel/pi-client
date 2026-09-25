import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";
import { loadConfig, persistQaShotEnabled, persistQaShotMode, type ScenariosConfig } from "./config";
import {
  ensureScenariosDir,
  ensurePlaywrightProjectDeps,
  ensureWebScaffold,
  formatDefinitions,
  formatReport,
  runScenarios,
  toolchainStatus,
  validateDefinitions,
} from "./engine";
import {
  discoverScenariosFromDisk,
  formatDiscoveredSummary,
  mergeScenarioLists,
  resolveEffectiveScenarios,
} from "./discover";
import {
  applyCanonicalDeletions,
  auditScenarios,
  deleteScratchFiles,
  formatCompactTidyHint,
  formatTidyReport,
  setCanonicalPick,
} from "./housekeeping";
import { formatSpecPatternWarnings, scanSpecPatterns } from "./spec-audit";
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
import { resetGateClaim, tryClaimGate, isGateClaimed } from "../shared/gate-orchestrator";
import { classifyScenarioFailure, formatClassifiedFailure } from "../shared/failure-classify";
import { detectStacks, formatStackDoctorLines, shouldInjectWebProcedure } from "../shared/stack-detect";
import { withGateWorkingMessage } from "../shared/working-status";
const WEB_FILE = /\.(html?|js|mjs|cjs|jsx|ts|tsx|css|vue|svelte)$/i;

function isWebFile(filePath: string): boolean {
  return WEB_FILE.test(filePath.replace(/\\/g, "/"));
}

const EDIT_TOOLS = new Set(["write", "edit", "create", "multiedit", "apply_patch", "str_replace"]);
const STATE_TYPE = "foundation-scenarios-state";

interface PersistedState {
  changedFiles?: string[];
  fixAttempts?: number;
  qaFixAttempts?: number;
  scenarios?: ScenarioDefinition[];
  visualQaConfirmed?: boolean;
  lastRunById?: Record<string, "pass" | "fail" | "skip">;
  specsCreatedThisSession?: string[];
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

function extractPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "filename", "file"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  const changedFiles = new Set<string>();
  let fixAttempts = 0;
  let qaFixAttempts = 0;
  let visualQaConfirmed = false;
  let scenarios: ScenarioDefinition[] = [];
  let lastRunById: Record<string, "pass" | "fail" | "skip"> = {};
  let specsCreatedThisSession: string[] = [];
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

  function persist() {
    pi.appendEntry<PersistedState>(STATE_TYPE, {
      changedFiles: [...changedFiles],
      fixAttempts,
      qaFixAttempts,
      scenarios,
      visualQaConfirmed,
      lastRunById,
      specsCreatedThisSession,
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
      }
    }

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
    });

    return {
      systemPrompt: `${event.systemPrompt}\n\n${procedure}`,
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || !EDIT_TOOLS.has(event.toolName)) return;

    const p = extractPath(event.input);
    if (p && !changedFiles.has(p)) {
      changedFiles.add(p);
      if (isWebFile(p)) {
        visualQaConfirmed = false;
      }
      if (isScenarioSpecPath(p) && !specsCreatedThisSession.includes(p)) {
        specsCreatedThisSession.push(p);
      }
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

  function effectiveScenarios(ctx: ExtensionContext): ScenarioDefinition[] {
    return resolveEffectiveScenarios(ctx.cwd, scenarios, cfg(ctx));
  }

  async function buildRunScenariosResponse(
    ctx: ExtensionContext,
    report: string,
    result: Awaited<ReturnType<typeof runScenarios>>,
    config: ScenariosConfig,
    introSuffix: string,
  ) {
    const failureShots = result.failed && config.visionOnFailure ? (result.screenshots ?? []) : [];
    const passShots = !result.failed && config.visionOnPass ? (result.outputScreenshots ?? []) : [];
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
    const config = cfg(ctx);
    if (!config.enabled || !config.blocking) return;
    if (config.gateOnCodeChanges && changedFiles.size === 0) return;
    if (isGateClaimed()) return;

    await withGateWorkingMessage(ctx, "Acceptance gates (scenarios/QA) — inference idle", async () => {
      const toRun = effectiveScenarios(ctx);

      if (config.requireDefined && toRun.length === 0) {
        if (fixAttempts >= config.maxFixAttempts) {
          ctx.ui.notify(
            `No acceptance scenarios defined after ${config.maxFixAttempts} attempts — stopping the fix loop.`,
            "error",
          );
          changedFiles.clear();
          fixAttempts = 0;
          persist();
          return;
        }
        if (!tryClaimGate("scenarios")) return;
        fixAttempts += 1;
        persist();
        pi.sendUserMessage(
          `You changed code but no acceptance scenarios are defined (attempt ${fixAttempts}/${config.maxFixAttempts}). ` +
            `Call define_scenarios (or optional scaffold_scenario) with each user-visible flow, write the test files under ${config.scenariosDir}, ` +
            `then call run_scenarios before finishing.`,
          { deliverAs: "followUp" },
        );
        return;
      }

      if (toRun.length > 0) {
        const result = await runScenarios(ctx.cwd, toRun, config, ctx.signal);
        if (ctx.signal?.aborted) return;

        if (result.failed) {
          if (fixAttempts >= config.maxFixAttempts) {
            ctx.ui.notify(
              `Scenarios still failing after ${config.maxFixAttempts} attempts — stopping the fix loop. Run /scenarios run`,
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

          if (!tryClaimGate("scenarios")) return;
          fixAttempts += 1;
          persist();
          const report = formatReport(result, toRun);
          const classified = classifyScenarioFailure({
            report,
            preflightWarnings: result.preflightWarnings,
            weakSpecBlocking: Boolean(result.weakSpecWarnings?.some((w) => w.blocking)),
            missingFiles: result.missingFiles,
          });
          const intro = formatClassifiedFailure(
            classified,
            `Acceptance scenarios failed (attempt ${fixAttempts}/${config.maxFixAttempts}). ` +
              `Fix the app or tests — do not finish while scenarios fail.`,
            { screens: config.visionOnFailure ? result.screenshots : undefined },
          );
          const shots = config.visionOnFailure ? (result.screenshots ?? []) : [];
          await sendVisionFollowUp(ctx, intro, shots, config);
          return;
        }
        recordRunResults(result, toRun);
      }

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

      if (config.housekeeping.enabled && config.housekeeping.auditOnAgentEnd && ctx.hasUI) {
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
          description: "Run only these scenario ids. Omit to run all defined scenarios.",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
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

      const result = await runScenarios(
        ctx.cwd,
        toRun,
        config,
        signal,
        filterIds ? new Set([...filterIds]) : undefined,
      );
      const report = formatReport(result, toRun);
      recordRunResults(result, toRun);
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
      "Acceptance scenarios — list | run | run-all | sync | tidy | pick | clear | doctor | qa on|off|status|model|human|approve [project]",
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
          ctx.ui.notify(`Visual QA shot enabled (saved to ${file}). Mode: ${cfg(ctx).qaShot.mode}`, "info");
          return;
        }
        if (action === "off") {
          const file = persistQaShotMode(ctx.cwd, "off", scope);
          configCache = null;
          persist();
          ctx.ui.notify(`Visual QA shot disabled / mode off (saved to ${file}).`, "info");
          return;
        }
        if (action === "model" || action === "human") {
          const file = persistQaShotMode(ctx.cwd, action, scope);
          configCache = null;
          visualQaConfirmed = false;
          persist();
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
        const result = await runScenarios(ctx.cwd, toRun, config);
        recordRunResults(result, toRun);
        const report = formatReport(result, toRun);
        if (result.failed) {
          ctx.ui.notify("Scenarios failed — sending failures to the agent to fix.", "error");
          const failureShots = config.visionOnFailure ? (result.screenshots ?? []) : [];
          await sendVisionFollowUp(ctx, `Acceptance scenarios failed. Fix these:\n\n${report}`, failureShots, config);
        } else {
          const passShots = config.visionOnPass ? (result.outputScreenshots ?? []) : [];
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
        const result = await runScenarios(ctx.cwd, toRun, config);
        recordRunResults(result, toRun);
        const report = formatReport(result, toRun);
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
        "Usage: /scenarios list | run | run-all | sync | tidy | pick <group> <n> | clear | doctor | qa on|off|model|human|approve|status [project]",
        "info",
      );
    },
  });
}
