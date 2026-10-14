import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, foundationConfigPaths } from "../shared/config-paths";
import { readJsonConfig } from "../shared/json-config";

/** Concrete polish levels, weakest to strongest. */
export type PolishLevel = "off" | "basic" | "standard" | "showcase" | "ultimate";
/** What the user can set: a concrete level, or auto-inference per prompt. */
export type PolishSetting = PolishLevel | "auto";

export const POLISH_LEVELS: PolishLevel[] = ["off", "basic", "standard", "showcase", "ultimate"];

export function isPolishLevel(v: unknown): v is PolishLevel {
  return typeof v === "string" && (POLISH_LEVELS as string[]).includes(v);
}

export function isPolishSetting(v: unknown): v is PolishSetting {
  return v === "auto" || isPolishLevel(v);
}

/** Rank for comparisons: levelAtLeast("showcase", "standard") === true. */
export function levelRank(level: PolishLevel): number {
  return POLISH_LEVELS.indexOf(level);
}

export function levelAtLeast(level: PolishLevel, min: PolishLevel): boolean {
  return levelRank(level) >= levelRank(min);
}

/** One line per level — shown by /polish and when a level is set. */
export const LEVEL_DESCRIPTIONS: Record<PolishLevel | "auto", string> = {
  auto: "Pick a level per prompt: standard for UI work, off for scripts and small fixes. Says which one it chose.",
  off: "Nothing added. Build exactly what was asked.",
  basic: "Small finishing rules only (styled controls, hover states, no unfinished edges). No extra passes.",
  standard: "States design choices up front, then one 'weakest three' pass per raw surface.",
  showcase: "Standard plus a real design reference lookup and a separate vision-model critic. Several passes.",
  ultimate: "Everything on, every surface revisited (polished ones too), plus motion, responsive and accessibility passes. Slow on purpose.",
};

export interface PolishConfig {
  /** Master switch — when false, hooks, tools and command stay idle. */
  enabled: boolean;
  /** Default level, or "auto" to infer from the prompt + project stack. */
  level: PolishSetting;
  /** Max "second look" passes per surface per user prompt, by level. */
  passes: Record<PolishLevel, number>;
  /**
   * Same weakness named this many times → stop working on that surface and report it.
   * A repeat with no file edits in between stops immediately regardless.
   */
  maxNamings: number;
  /** "provider/modelId" of a vision-capable model used as critic at showcase+. Empty = use session model. */
  criticModel: string;
  /** Notify when auto picks or changes the level. */
  announceAuto: boolean;
  /** Where polish screenshots go (overwritten per pass). */
  shotDir: string;
  /** Where the surfaces inventory persists across sessions. */
  inventoryPath: string;
}

export const DEFAULT_CONFIG: PolishConfig = {
  enabled: true,
  level: "auto",
  passes: { off: 0, basic: 0, standard: 1, showcase: 3, ultimate: 6 },
  maxNamings: 3,
  criticModel: "",
  announceAuto: true,
  shotDir: ".pi/polish",
  inventoryPath: ".pi/polish/inventory.json",
};

type RawConfig = Partial<Omit<PolishConfig, "passes">> & { passes?: Partial<Record<PolishLevel, number>> };

function readJson(file: string): RawConfig | null {
  return readJsonConfig<RawConfig>(file) as RawConfig | null;
}

/** Layer defaults < ~/.pi/polish.config.json < <cwd>/.pi/polish.config.json < <cwd>/polish.config.json. */
export function loadConfig(cwd: string): PolishConfig {
  const layers = foundationConfigPaths(cwd, "polish.config.json");
  let cfg: PolishConfig = { ...DEFAULT_CONFIG, passes: { ...DEFAULT_CONFIG.passes } };
  for (const file of layers) {
    const override = readJson(file);
    if (!override) continue;
    const { passes, level, ...rest } = override;
    cfg = { ...cfg, ...rest, passes: { ...cfg.passes, ...(passes ?? {}) } };
    if (isPolishSetting(level)) cfg.level = level;
  }
  // Known levels only; never negative or non-numeric pass caps.
  const passes = {} as Record<PolishLevel, number>;
  for (const lvl of POLISH_LEVELS) {
    const n = cfg.passes[lvl];
    passes[lvl] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CONFIG.passes[lvl];
  }
  passes.off = 0;
  cfg.passes = passes;
  return cfg;
}

export type PersistScope = "user" | "project";

export function userPolishConfigPath(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, "polish.config.json");
}

export function projectPolishConfigPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, "polish.config.json");
}

function writePartial(cwd: string, scope: PersistScope, patch: RawConfig): string {
  const target = scope === "user" ? userPolishConfigPath() : projectPolishConfigPath(cwd);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = readJson(target) ?? {};
  fs.writeFileSync(target, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, "utf8");
  return target;
}

/** Save the default level (survives Pi restarts). */
export function persistLevel(cwd: string, level: PolishSetting, scope: PersistScope): string {
  return writePartial(cwd, scope, { level });
}

/** Save the critic model ("provider/modelId", or "" to clear). */
export function persistCriticModel(cwd: string, criticModel: string, scope: PersistScope): string {
  return writePartial(cwd, scope, { criticModel });
}
