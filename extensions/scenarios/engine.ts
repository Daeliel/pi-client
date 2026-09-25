import { exec } from "node:child_process";
import { promisify } from "node:util";
import { clipMiddle, plainOutputEnv, stripAnsi } from "../shared/output";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ScenariosConfig, RunnerConfig } from "./config";
import type { ScenarioDefinition, ScenarioCheckResult, ScenariosRunResult } from "./types";
import {
  buildPlaywrightConfigTemplate,
  CONSOLE_CAPTURE_HELPER_TEMPLATE,
  CONSOLE_CAPTURE_HELPER_VERSION,
  CANVAS_INTERACTION_HELPER_TEMPLATE,
  CANVAS_INTERACTION_HELPER_VERSION,
} from "./templates";
import { findFailureScreenshots, findScenarioOutputScreenshots, pruneTestResults } from "./vision";
import { resolvePlaywrightCli } from "./playwright-cli";
import { collectPreflightWarnings } from "./preflight";
import { hasBlockingSpecWarnings, scanSpecFileContent, formatSpecPatternWarnings } from "./spec-audit";
import { detectStacks } from "../shared/stack-detect";

const pexec = promisify(exec);

interface RunOutput {
  code: number;
  out: string;
  timedOut: boolean;
  aborted: boolean;
}

async function run(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<RunOutput> {
  if (signal?.aborted) return { code: 0, out: "", timedOut: false, aborted: true };
  try {
    const { stdout, stderr } = await pexec(command, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      signal,
      env: plainOutputEnv(),
    });
    return { code: 0, out: stripAnsi(`${stdout}${stderr}`).trim(), timedOut: false, aborted: false };
  } catch (e: unknown) {
    const err = e as {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
      signal?: string;
      name?: string;
      message?: string;
    };
    if (err.name === "AbortError" || signal?.aborted) {
      return { code: 0, out: "", timedOut: false, aborted: true };
    }
    const out = stripAnsi(`${err.stdout ?? ""}${err.stderr ?? ""}`).trim() || err.message || "unknown error";
    const timedOut = Boolean(err.killed) || err.signal === "SIGTERM";
    const code = typeof err.code === "number" ? err.code : 1;
    return { code: timedOut ? 124 : code, out, timedOut, aborted: false };
  }
}

const toolCache = new Map<string, boolean>();
async function hasTool(probe: string, cwd: string): Promise<boolean> {
  const cached = toolCache.get(probe);
  if (cached !== undefined) return cached;
  const r = await run(probe, cwd, 15000);
  const ok = r.code === 0;
  toolCache.set(probe, ok);
  return ok;
}

let cachedPython: string | null | undefined;
async function pythonCmd(cwd: string): Promise<string | null> {
  if (cachedPython !== undefined) return cachedPython;
  for (const candidate of ["python", "python3", "py"]) {
    if (await hasTool(`${candidate} --version`, cwd)) {
      cachedPython = candidate;
      return candidate;
    }
  }
  cachedPython = null;
  return null;
}

function prepareCommand(
  template: string,
  py: string | null,
  files: string[],
  playwrightConfig?: string,
  playwrightCli = "playwright",
): string {
  const fileArg = files.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(" ");
  let command = template
    .replace(/\{py\}/g, py ?? "python")
    .replace(/\{files\}/g, fileArg || ".")
    .replace(/\{config\}/g, playwrightConfig ?? ".pi/playwright.config.ts")
    .replace(/\{pw\}/g, playwrightCli);
  if (playwrightCli !== "playwright") {
    command = command.replace(/^playwright(?=\s)/, playwrightCli);
  }
  return command;
}

function runnerForKind(config: ScenariosConfig, kind: ScenarioDefinition["kind"]): RunnerConfig {
  if (kind === "web") return config.web;
  if (kind === "api") return config.api;
  return config.script;
}

function resolveTestPath(cwd: string, testFile: string): string {
  return path.isAbsolute(testFile) ? testFile : path.join(cwd, testFile);
}

export function ensureScenariosDir(cwd: string, config: ScenariosConfig): void {
  const dir = path.join(cwd, config.scenariosDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Create .pi/playwright.config.ts when the project uses web scenarios (never overwrites). */
export async function ensurePlaywrightProjectDeps(cwd: string): Promise<string | null> {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["@playwright/test"]) return null;
  } catch {
    return "could not read package.json — run: npm install -D @playwright/test";
  }

  try {
    await pexec("npm install -D @playwright/test", {
      cwd,
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return "installed @playwright/test in project";
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "npm install failed";
    return `npm install -D @playwright/test failed: ${out}`;
  }
}

export function ensureConsoleCaptureHelper(cwd: string, config: ScenariosConfig): boolean {
  const relHelper = path.join(config.scenariosDir, "helpers/console-capture.ts");
  const absHelper = path.join(cwd, relHelper);
  if (fs.existsSync(absHelper)) {
    const existing = fs.readFileSync(absHelper, "utf8");
    if (existing.includes(CONSOLE_CAPTURE_HELPER_VERSION)) return false;
  } else {
    fs.mkdirSync(path.dirname(absHelper), { recursive: true });
  }
  fs.writeFileSync(absHelper, CONSOLE_CAPTURE_HELPER_TEMPLATE, "utf8");
  return true;
}

export function ensureCanvasInteractionHelper(cwd: string, config: ScenariosConfig): boolean {
  const relHelper = path.join(config.scenariosDir, "helpers/canvas-interaction.ts");
  const absHelper = path.join(cwd, relHelper);
  if (fs.existsSync(absHelper)) {
    const existing = fs.readFileSync(absHelper, "utf8");
    if (existing.includes(CANVAS_INTERACTION_HELPER_VERSION)) return false;
  } else {
    fs.mkdirSync(path.dirname(absHelper), { recursive: true });
  }
  fs.writeFileSync(absHelper, CANVAS_INTERACTION_HELPER_TEMPLATE, "utf8");
  return true;
}

export function ensureWebScaffold(
  cwd: string,
  config: ScenariosConfig,
  scenarios: ScenarioDefinition[],
): string[] {
  if (!scenarios.some((s) => s.kind === "web")) return [];

  ensureScenariosDir(cwd, config);
  const created: string[] = [];

  const relConfig = config.playwrightConfig;
  const absConfig = path.join(cwd, relConfig);
  if (!fs.existsSync(absConfig)) {
    fs.mkdirSync(path.dirname(absConfig), { recursive: true });
    const detection = detectStacks(cwd);
    fs.writeFileSync(absConfig, buildPlaywrightConfigTemplate(detection.playwright), "utf8");
    created.push(relConfig);
  }

  if (ensureConsoleCaptureHelper(cwd, config)) {
    created.push(path.join(config.scenariosDir, "helpers/console-capture.ts").replace(/\\/g, "/"));
  }

  if (ensureCanvasInteractionHelper(cwd, config)) {
    created.push(path.join(config.scenariosDir, "helpers/canvas-interaction.ts").replace(/\\/g, "/"));
  }

  return created;
}

export function validateDefinitions(
  cwd: string,
  scenarios: ScenarioDefinition[],
): { valid: ScenarioDefinition[]; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  const valid: ScenarioDefinition[] = [];

  for (const s of scenarios) {
    if (!s.id?.trim()) {
      errors.push("Each scenario needs a non-empty id.");
      continue;
    }
    if (seen.has(s.id)) {
      errors.push(`Duplicate scenario id: ${s.id}`);
      continue;
    }
    seen.add(s.id);
    if (!s.title?.trim()) errors.push(`Scenario ${s.id}: title is required.`);
    if (!s.steps?.trim()) errors.push(`Scenario ${s.id}: steps are required.`);
    if (!s.testFile?.trim()) errors.push(`Scenario ${s.id}: testFile is required.`);
    if (!["web", "api", "script"].includes(s.kind)) {
      errors.push(`Scenario ${s.id}: kind must be web, api, or script.`);
      continue;
    }
    valid.push(s);
  }
  return { valid, errors };
}

export async function runScenarios(
  cwd: string,
  scenarios: ScenarioDefinition[],
  config: ScenariosConfig,
  signal?: AbortSignal,
  filterIds?: Set<string>,
): Promise<ScenariosRunResult> {
  const checks: ScenarioCheckResult[] = [];
  const missingFiles: string[] = [];
  const py = await pythonCmd(cwd);
  const pw = await resolvePlaywrightCli(cwd);

  const selected = filterIds ? scenarios.filter((s) => filterIds.has(s.id)) : scenarios;
  const hasWeb = selected.some((s) => s.kind === "web");
  const runStarted = Date.now();
  const preflightWarnings = hasWeb ? collectPreflightWarnings(cwd, config) : [];
  if (hasWeb) {
    ensureConsoleCaptureHelper(cwd, config);
    ensureCanvasInteractionHelper(cwd, config);
  }
  if (hasWeb && config.visionOnFailure) {
    pruneTestResults(cwd, config);
  }

  for (const scenario of selected) {
    const absPath = resolveTestPath(cwd, scenario.testFile);
    if (!fs.existsSync(absPath)) {
      missingFiles.push(scenario.testFile);
      checks.push({
        scenarioId: scenario.id,
        title: scenario.title,
        testFile: scenario.testFile,
        kind: scenario.kind,
        status: "fail",
        output: "",
        reason: "test file missing — create it and implement the flow",
      });
      continue;
    }

    const runner = runnerForKind(config, scenario.kind);
    if (runner.enabled === false) {
      checks.push({
        scenarioId: scenario.id,
        title: scenario.title,
        testFile: scenario.testFile,
        kind: scenario.kind,
        status: "skip",
        output: "",
        reason: `${scenario.kind} runner disabled in config`,
      });
      continue;
    }

    if (runner.probe) {
      const pwCli = scenario.kind === "web" ? pw : "playwright";
      const probeCmd = prepareCommand(runner.probe, py, [scenario.testFile], config.playwrightConfig, pwCli);
      if (!(await hasTool(probeCmd, cwd))) {
        checks.push({
          scenarioId: scenario.id,
          title: scenario.title,
          testFile: scenario.testFile,
          kind: scenario.kind,
          status: "skip",
          output: "",
          reason: `toolchain missing (probe failed: \`${probeCmd}\`) — run /scenarios doctor`,
        });
        continue;
      }
    }

    const pwCli = scenario.kind === "web" ? pw : "playwright";
    const command = prepareCommand(runner.command, py, [scenario.testFile], config.playwrightConfig, pwCli);
    const rel = path.relative(cwd, absPath) || scenario.testFile;
    const result = await run(command, cwd, config.timeoutMs, signal);

    if (result.aborted) {
      return { ran: false, failed: false, missingFiles, checks };
    }

    const screenshots =
      scenario.kind === "web" && result.code !== 0 && config.visionOnFailure
        ? findFailureScreenshots(cwd, config, runStarted - 1000)
        : undefined;

    checks.push({
      scenarioId: scenario.id,
      title: scenario.title,
      testFile: rel,
      kind: scenario.kind,
      status: result.code === 0 ? "pass" : "fail",
      output: result.out,
      reason: result.timedOut ? "timed out" : result.code !== 0 ? `exit ${result.code}` : undefined,
      screenshots,
    });
  }

  const allScreenshots = checks.flatMap((c) => c.screenshots ?? []);
  const uniqueScreenshots = [...new Set(allScreenshots)];

  const hasPass = checks.some((c) => c.status === "pass");
  const outputScreenshots =
    hasWeb && hasPass && config.visionOnPass
      ? findScenarioOutputScreenshots(cwd, config, runStarted - 1000)
      : undefined;

  const ran = checks.some((c) => c.status === "pass" || c.status === "fail");

  const canvasProject = hasWeb && detectStacks(cwd).stacks.includes("flutter");
  const weakSpecWarnings =
    config.failOnWeakSpec !== false
      ? checks.flatMap((c) => {
          if (c.status !== "pass" || c.kind !== "web") return [];
          const abs = resolveTestPath(cwd, c.testFile);
          if (!fs.existsSync(abs)) return [];
          try {
            const text = fs.readFileSync(abs, "utf8");
            return scanSpecFileContent(c.testFile.replace(/\\/g, "/"), text, { canvasProject });
          } catch {
            return [];
          }
        })
      : [];

  const failed =
    missingFiles.length > 0 ||
    checks.some((c) => c.status === "fail") ||
    (checks.length > 0 && !checks.some((c) => c.status === "pass")) ||
    (config.failOnWeakSpec !== false && hasBlockingSpecWarnings(weakSpecWarnings));

  return {
    ran,
    failed,
    missingFiles,
    checks,
    screenshots: uniqueScreenshots.length ? uniqueScreenshots : undefined,
    outputScreenshots: outputScreenshots?.length ? outputScreenshots : undefined,
    preflightWarnings: preflightWarnings.length ? preflightWarnings : undefined,
    weakSpecWarnings: weakSpecWarnings.length ? weakSpecWarnings : undefined,
  };
}

export function formatReport(result: ScenariosRunResult, scenarios: ScenarioDefinition[]): string {
  if (scenarios.length === 0) {
    return "No acceptance scenarios defined. Call define_scenarios with user-visible flows before finishing.";
  }

  const lines: string[] = [];
  if (result.preflightWarnings?.length) {
    for (const w of result.preflightWarnings) lines.push(w);
    lines.push("");
  }
  if (result.missingFiles.length > 0) {
    lines.push("Missing test files:");
    for (const f of result.missingFiles) lines.push(`  - ${f}`);
    lines.push("");
  }

  for (const c of result.checks) {
    const icon = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "SKIP";
    const suffix = c.reason ? ` (${c.reason})` : "";
    lines.push(`[${icon}] ${c.scenarioId}: ${c.title} — ${c.testFile}${suffix}`);
    if (c.status === "fail" && c.output) {
      lines.push(clipMiddle(c.output, 4000));
    }
    if (c.status === "fail" && c.screenshots?.length) {
      lines.push(`  screenshots: ${c.screenshots.length} captured (attached when visionOnFailure is on)`);
    }
  }

  if (result.screenshots?.length) {
    lines.push("", `${result.screenshots.length} failure screenshot(s) available for review.`);
  }

  if (result.outputScreenshots?.length) {
    lines.push("", `${result.outputScreenshots.length} spec output screenshot(s) from .pi/scenarios/output/ (attached when visionOnPass is on).`);
  }

  if (result.weakSpecWarnings?.length) {
    lines.push("", ...formatSpecPatternWarnings(result.weakSpecWarnings));
    if (hasBlockingSpecWarnings(result.weakSpecWarnings)) {
      lines.push("", "FAIL: Playwright exited 0 but spec proof is too weak — fix patterns above and re-run.");
    }
  }

  if (lines.length === 0) return "No scenario checks ran.";
  const skipCount = result.checks.filter((c) => c.status === "skip").length;
  if (skipCount === result.checks.length && result.checks.length > 0) {
    lines.push("", "WARNING: All scenario checks were SKIPPED — this is NOT a pass. Run /scenarios doctor.");
  }
  return lines.join("\n");
}

export function formatDefinitions(scenarios: ScenarioDefinition[]): string {
  if (scenarios.length === 0) return "(no scenarios defined)";
  return scenarios
    .map(
      (s) =>
        `- ${s.id} [${s.kind}] ${s.title}\n  file: ${s.testFile}\n  steps: ${s.steps.replace(/\n/g, "\n         ")}`,
    )
    .join("\n");
}

export interface ToolStatus {
  name: string;
  ok: boolean;
  hint: string;
}

/** Client toolchain probes for /scenarios doctor and session_start warnings. */
export async function toolchainStatus(cwd: string, config: ScenariosConfig): Promise<ToolStatus[]> {
  if (!config.enabled) return [];
  const out: ToolStatus[] = [];
  const py = await pythonCmd(cwd);
  const pw = await resolvePlaywrightCli(cwd);

  const runners: Array<[string, RunnerConfig]> = [
    ["web (Playwright)", config.web],
    ["api (pytest)", config.api],
    ["script", config.script],
  ];

  for (const [label, runner] of runners) {
    if (runner.enabled === false) continue;
    if (!runner.probe) continue;
    const pwCli = label.startsWith("web") ? pw : "playwright";
    const probe = prepareCommand(runner.probe, py, [], config.playwrightConfig, pwCli);
    const ok = await hasTool(probe, cwd);
    let hint = `ensure \`${probe}\` works`;
    if (label.startsWith("web")) {
      hint = ok
        ? "Playwright ready (local npx when @playwright/test is in the project; global otherwise)"
        : "Run install-on-client.bat, or npm install -D @playwright/test in the project";
    } else if (label.startsWith("api")) {
      hint = py ? `${py} -m pip install pytest httpx` : "Install Python 3 and put it on PATH";
    } else if (!py) {
      hint = "Install Python 3 for script scenarios, or use web/api kinds";
    }
    out.push({ name: label, ok, hint });
  }

  return out;
}
