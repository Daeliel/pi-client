import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, foundationConfigPaths } from "../shared/config-paths";
import { readJsonConfig } from "../shared/json-config";

/** Directions an idea can take the project. Also the /once modifiers. */
export type ExpandAxis = "more" | "deeper" | "wider" | "tension";
export const EXPAND_AXES: ExpandAxis[] = ["more", "deeper", "wider", "tension"];

export function isExpandAxis(v: unknown): v is ExpandAxis {
  return typeof v === "string" && (EXPAND_AXES as string[]).includes(v);
}

/** One line per axis — shown by /expand, /once and in the ideas prompt. */
export const AXIS_DESCRIPTIONS: Record<ExpandAxis, string> = {
  more: "More of what exists: new content for an existing pool (gear, levels, enemies; entity types, templates).",
  deeper: "A mechanic that links two or more existing systems so they interact.",
  wider: "A new kind of thing: a class, mode, role or workflow that changes how the whole is used.",
  tension: "Trade-offs, risk/reward, scarcity, constraints — meaningful choices, not more stuff.",
};

export interface ExpandConfig {
  /** Master switch — when false, hooks, tools and command stay idle. */
  enabled: boolean;
  /** Ideas to propose per ideas pass (spread over the requested axes). */
  ideasPerPass: number;
  /** Fit-critique passes after a build ("does it fit, is it reachable, is it explained"). 0 = none. */
  fitPasses: number;
  /** Hard cap for /expand auto <n>. */
  autoMax: number;
  /** "provider/modelId" for an independent fit critic. Text-only is fine here. Empty = session model critiques itself. */
  criticModel: string;
  /** Where the systems map + pillars + idea ledger persist across sessions. */
  ledgerPath: string;
}

export const DEFAULT_CONFIG: ExpandConfig = {
  enabled: true,
  ideasPerPass: 6,
  fitPasses: 1,
  autoMax: 3,
  criticModel: "",
  ledgerPath: ".pi/expand/ledger.json",
};

function readJson(file: string): Partial<ExpandConfig> | null {
  return readJsonConfig<ExpandConfig>(file);
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
}

/** Layer defaults < ~/.pi/expand.config.json < <cwd>/.pi/expand.config.json < <cwd>/expand.config.json. */
export function loadConfig(cwd: string): ExpandConfig {
  let cfg: ExpandConfig = { ...DEFAULT_CONFIG };
  for (const file of foundationConfigPaths(cwd, "expand.config.json")) {
    const override = readJson(file);
    if (override) cfg = { ...cfg, ...override };
  }
  cfg.ideasPerPass = clampInt(cfg.ideasPerPass, DEFAULT_CONFIG.ideasPerPass, 1, 12);
  cfg.fitPasses = clampInt(cfg.fitPasses, DEFAULT_CONFIG.fitPasses, 0, 3);
  cfg.autoMax = clampInt(cfg.autoMax, DEFAULT_CONFIG.autoMax, 1, 10);
  if (typeof cfg.criticModel !== "string") cfg.criticModel = "";
  if (typeof cfg.ledgerPath !== "string" || !cfg.ledgerPath) cfg.ledgerPath = DEFAULT_CONFIG.ledgerPath;
  return cfg;
}

export type PersistScope = "user" | "project";

/** Save the critic model ("provider/modelId", or "" to clear). */
export function persistCriticModel(cwd: string, criticModel: string, scope: PersistScope): string {
  const target =
    scope === "user" ? path.join(os.homedir(), CONFIG_DIR_NAME, "expand.config.json") : path.join(cwd, CONFIG_DIR_NAME, "expand.config.json");
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = readJson(target) ?? {};
  fs.writeFileSync(target, `${JSON.stringify({ ...existing, criticModel }, null, 2)}\n`, "utf8");
  return target;
}
