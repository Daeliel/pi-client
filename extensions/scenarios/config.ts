import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, foundationConfigPaths } from "../shared/config-paths";
import { readJsonConfig } from "../shared/json-config";

export interface RunnerConfig {
  enabled?: boolean;
  /** Shell command; `{files}` = space-separated test paths, `{py}` = python interpreter. */
  command: string;
  /** Probe run before executing scenarios (skip runner if probe fails). */
  probe?: string;
}

/** Who must approve the visual QA shot before finish. */
export type QaShotMode = "model" | "human" | "off";

export interface QaShotConfig {
  enabled: boolean;
  /**
   * model = agent confirm_visual_qa (default);
   * human = user must /scenarios qa approve;
   * off = capture may still run for review but never blocks finish.
   */
  mode: QaShotMode;
  /** Block agent_end until approved (ignored when mode is off). */
  blocking: boolean;
  /** Skip QA shot when no web/UI files changed this task. */
  gateOnWebChanges: boolean;
  /** Overwritten each capture (not versioned). */
  outputPath: string;
  /** Path appended to baseURL in .pi/playwright.config.ts. */
  urlPath: string;
}

/**
 * How hard the scenarios gate works.
 * thorough (default): every spec runs on every code change; passing specs' screenshots are reviewed.
 * standard: smoke specs plus the specs this change touches; screenshots only on failure. A full
 * run is still one call away (run_scenarios all, /scenarios run-all) before calling work done.
 */
export type ScenarioLevel = "thorough" | "standard";

export function isScenarioLevel(value: unknown): value is ScenarioLevel {
  return value === "thorough" || value === "standard";
}

export interface HousekeepingConfig {
  enabled: boolean;
  /** Notify / suggest tidy when count exceeds this. */
  maxSpecsBeforeAudit: number;
  /** Suggest /scenarios tidy at end of agent turn when warranted. */
  auditOnAgentEnd: boolean;
  /** Exclude __*.spec.ts from auto-discovered runs (except __qa-capture). */
  skipScratchInAutoRun: boolean;
  /** Delete __*.spec.ts scratch specs once the scenarios gate passes (task done). */
  autoDeleteScratch: boolean;
  /**
   * After a passing gate, when housekeeping is warranted, let the model propose specs
   * to scrap; the user confirms each removal. Also on demand: /scenarios review.
   */
  modelReview: boolean;
}

export interface ScenariosConfig {
  /** Master switch — when false, hooks and tools stay idle. */
  enabled: boolean;
  /** thorough | standard — see ScenarioLevel. */
  level: ScenarioLevel;
  /** Block agent_end while scenarios are undefined, missing, or failing. */
  blocking: boolean;
  maxFixAttempts: number;
  timeoutMs: number;
  /** Default directory for scenario test files (created by the agent). */
  scenariosDir: string;
  /** Per-project Playwright config (scaffolded on first web scenario). */
  playwrightConfig: string;
  /** Require define_scenarios before the gate passes. */
  requireDefined: boolean;
  /** Only gate when code files were edited this task (docs, notes, images and lockfiles do not count). */
  gateOnCodeChanges: boolean;
  /** Attach Playwright failure screenshots to run_scenarios / gate messages. */
  visionOnFailure: boolean;
  /** Attach .pi/scenarios/output/ screenshots after passing web specs. */
  visionOnPass: boolean;
  /** Merge disk .spec.ts files into run_scenarios (with session-registered scenarios). */
  autoDiscoverScenarios: boolean;
  /** Fail run_scenarios when a passing web spec matches weak/forbidden patterns (DOM scroll, canvas-only assert). */
  failOnWeakSpec: boolean;
  /** Max images attached per vision message (context bloat cap). */
  maxScreenshotsPerRun: number;
  maxImageWidth: number;
  maxImageBytes: number;
  jpegQuality: number;
  qaShot: QaShotConfig;
  housekeeping: HousekeepingConfig;
  web: RunnerConfig;
  api: RunnerConfig;
  script: RunnerConfig;
}

export const DEFAULT_CONFIG: ScenariosConfig = {
  enabled: true,
  level: "thorough",
  blocking: true,
  maxFixAttempts: 5,
  timeoutMs: 180000,
  scenariosDir: ".pi/scenarios",
  playwrightConfig: ".pi/playwright.config.ts",
  requireDefined: true,
  gateOnCodeChanges: true,
  visionOnFailure: true,
  visionOnPass: true,
  autoDiscoverScenarios: true,
  failOnWeakSpec: true,
  maxScreenshotsPerRun: 4,
  maxImageWidth: 1280,
  maxImageBytes: 900_000,
  jpegQuality: 80,
  qaShot: {
    enabled: false,
    mode: "model",
    blocking: true,
    gateOnWebChanges: true,
    outputPath: ".pi/qa-shot.jpg",
    urlPath: "/",
  },
  housekeeping: {
    enabled: true,
    maxSpecsBeforeAudit: 10,
    auditOnAgentEnd: true,
    skipScratchInAutoRun: true,
    autoDeleteScratch: true,
    modelReview: false,
  },
  web: {
    enabled: true,
    command: "{pw} test {files} --config {config}",
    probe: "{pw} --version",
  },
  api: {
    enabled: true,
    command: "{py} -m pytest {files} -q",
    probe: "{py} -m pytest --version",
  },
  script: {
    enabled: true,
    command: "{py} {files}",
    probe: "{py} --version",
  },
};

function readJson(file: string): Partial<ScenariosConfig> | null {
  return readJsonConfig<ScenariosConfig>(file);
}

function mergeRunner(base: RunnerConfig, override: Partial<RunnerConfig> | undefined): RunnerConfig {
  if (!override) return base;
  return { ...base, ...override };
}

function normalizeQaMode(mode: unknown, enabled: boolean): QaShotMode {
  if (mode === "model" || mode === "human" || mode === "off") return mode;
  // Legacy: enabled false ≈ off for gating; keep enabled flag for capture toggle.
  if (!enabled && mode === undefined) return "model";
  return "model";
}

function mergeQaShot(base: QaShotConfig, override: Partial<QaShotConfig> | undefined): QaShotConfig {
  if (!override) return base;
  const merged = { ...base, ...override };
  merged.mode = normalizeQaMode(merged.mode, merged.enabled);
  return merged;
}

function mergeHousekeeping(
  base: HousekeepingConfig,
  override: Partial<HousekeepingConfig> | undefined,
): HousekeepingConfig {
  if (!override) return base;
  return { ...base, ...override };
}

/** Layer defaults < user < project CONFIG_DIR_NAME < legacy project root. */
export function loadConfig(cwd: string): ScenariosConfig {
  const layers = foundationConfigPaths(cwd, "scenarios.config.json");

  let cfg: ScenariosConfig = {
    ...DEFAULT_CONFIG,
    web: { ...DEFAULT_CONFIG.web },
    api: { ...DEFAULT_CONFIG.api },
    script: { ...DEFAULT_CONFIG.script },
    qaShot: { ...DEFAULT_CONFIG.qaShot },
    housekeeping: { ...DEFAULT_CONFIG.housekeeping },
  };

  for (const file of layers) {
    const override = readJson(file);
    if (!override) continue;
    cfg = {
      ...cfg,
      ...override,
      web: mergeRunner(cfg.web, override.web),
      api: mergeRunner(cfg.api, override.api),
      script: mergeRunner(cfg.script, override.script),
      qaShot: mergeQaShot(cfg.qaShot, override.qaShot),
      housekeeping: mergeHousekeeping(cfg.housekeeping, override.housekeeping),
    };
  }
  if (!isScenarioLevel(cfg.level)) cfg.level = DEFAULT_CONFIG.level;
  return cfg;
}

export type QaShotPersistScope = "user" | "project";

export function userScenariosConfigPath(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, "scenarios.config.json");
}

export function projectScenariosConfigPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, "scenarios.config.json");
}

function writeQaShotPartial(
  cwd: string,
  scope: QaShotPersistScope,
  patch: Partial<QaShotConfig>,
): string {
  const target = scope === "user" ? userScenariosConfigPath() : projectScenariosConfigPath(cwd);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJson(target) ?? {};
  const prevQa = (existing.qaShot ?? {}) as Partial<QaShotConfig>;
  const toWrite = {
    ...existing,
    qaShot: { ...prevQa, ...patch },
  };
  fs.writeFileSync(target, `${JSON.stringify(toWrite, null, 2)}\n`, "utf8");
  return target;
}

/** Save housekeeping.maxSpecsBeforeAudit to the project config (spec count before tidy hints/reviews). */
export function persistMaxSpecsBeforeAudit(cwd: string, max: number): string {
  const target = projectScenariosConfigPath(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = readJson(target) ?? {};
  const prev = (existing.housekeeping ?? {}) as Partial<HousekeepingConfig>;
  const toWrite = { ...existing, housekeeping: { ...prev, maxSpecsBeforeAudit: max } };
  fs.writeFileSync(target, `${JSON.stringify(toWrite, null, 2)}\n`, "utf8");
  return target;
}

/** Save the gate level to the project (default) or user config. */
export function persistScenarioLevel(cwd: string, level: ScenarioLevel, scope: QaShotPersistScope = "project"): string {
  const target = scope === "user" ? userScenariosConfigPath() : projectScenariosConfigPath(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = readJson(target) ?? {};
  fs.writeFileSync(target, `${JSON.stringify({ ...existing, level }, null, 2)}\n`, "utf8");
  return target;
}

/** Save qaShot.enabled to user or project config (survives Pi restarts). */
export function persistQaShotEnabled(cwd: string, enabled: boolean, scope: QaShotPersistScope): string {
  return writeQaShotPartial(cwd, scope, { enabled });
}

/** Save qaShot.mode (model | human | off). */
export function persistQaShotMode(cwd: string, mode: QaShotMode, scope: QaShotPersistScope): string {
  if (mode === "off") {
    return writeQaShotPartial(cwd, scope, { mode, enabled: false });
  }
  return writeQaShotPartial(cwd, scope, { mode, enabled: true });
}
