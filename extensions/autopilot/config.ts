import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, foundationConfigPaths } from "../shared/config-paths";
import { readJsonConfig } from "../shared/json-config";
import type { PlanScope } from "../plan/blueprint";

export type AutopilotScope = PlanScope;

export interface AutopilotConfig {
  /** Master switch — when false, no autopilot/blueprint tools are offered at all. */
  enabled: boolean;
  /** Print/JSON mode has no approval dialog: "allow" starts runs without one, "deny" hides autopilot. */
  headless: "allow" | "deny";
  /** Proving failures on one item before it is marked blocked and the run moves on. */
  itemAttempts: number;
  /**
   * Stops in a row with no edit and failing evidence before the item is marked blocked and the
   * run moves on. Three items blocked this way in a row pause the run.
   */
  stallStops: number;
  /** Scope offered first in the approval dialog. */
  defaultScope: AutopilotScope;
  /** One item running past budget × this is stopped and marked blocked. */
  budgetCeiling: number;
  /** Commit after each item on an autopilot/<slug> branch. */
  checkpoints: boolean;
}

export const DEFAULT_CONFIG: AutopilotConfig = {
  enabled: true,
  headless: "deny",
  itemAttempts: 3,
  stallStops: 3,
  defaultScope: "v1",
  budgetCeiling: 1.5,
  checkpoints: true,
};

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
}

/** Layer defaults < ~/.pi/autopilot.config.json < <cwd>/.pi/autopilot.config.json < <cwd>/autopilot.config.json. */
export function loadConfig(cwd: string): AutopilotConfig {
  let cfg: AutopilotConfig = { ...DEFAULT_CONFIG };
  for (const file of foundationConfigPaths(cwd, "autopilot.config.json")) {
    const override = readJsonConfig<AutopilotConfig>(file);
    if (override) cfg = { ...cfg, ...override };
  }
  cfg.enabled = cfg.enabled !== false;
  cfg.headless = cfg.headless === "allow" ? "allow" : "deny";
  cfg.itemAttempts = clampInt(cfg.itemAttempts, DEFAULT_CONFIG.itemAttempts, 1, 10);
  cfg.stallStops = clampInt(cfg.stallStops, DEFAULT_CONFIG.stallStops, 1, 10);
  if (!["v1", "v2", "all"].includes(cfg.defaultScope)) cfg.defaultScope = "v1";
  cfg.budgetCeiling =
    typeof cfg.budgetCeiling === "number" && cfg.budgetCeiling >= 1 && cfg.budgetCeiling <= 5 ? cfg.budgetCeiling : 1.5;
  cfg.checkpoints = cfg.checkpoints !== false;
  return cfg;
}

/** Merge a patch into the project's .pi/autopilot.config.json (e.g. checkpoints off, enabled off). */
export function persistProjectConfig(cwd: string, patch: Partial<AutopilotConfig>): string {
  const target = path.join(cwd, CONFIG_DIR_NAME, "autopilot.config.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = readJsonConfig<AutopilotConfig>(target) ?? {};
  fs.writeFileSync(target, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, "utf8");
  return target;
}
