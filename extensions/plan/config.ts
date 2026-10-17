import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, foundationConfigPaths } from "../shared/config-paths";
import { readJsonConfig } from "../shared/json-config";

export interface PlanConfig {
  /** Master switch — when false, no plan tools or command are offered. */
  enabled: boolean;
  /** The blueprint — single source of truth for what to build and how far it got. */
  blueprintPath: string;
  /** Reference images live here (kept local, never shipped). */
  refsDir: string;
  /**
   * A second, fresh look at the sources runs automatically when the text sources together
   * exceed this many words — counted here, never judged by the model.
   */
  rereadAboveWords: number;
  /** The user said no to "plan this first?" in this project — the offer is not made again. */
  offerDeclined: boolean;
}

export const DEFAULT_CONFIG: PlanConfig = {
  enabled: true,
  blueprintPath: ".pi/blueprint/BLUEPRINT.md",
  refsDir: ".pi/blueprint/refs",
  rereadAboveWords: 1500,
  offerDeclined: false,
};

/** Merge a patch into the project's .pi/plan.config.json. */
export function persistProjectConfig(cwd: string, patch: Partial<PlanConfig>): string {
  const target = path.join(cwd, CONFIG_DIR_NAME, "plan.config.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = readJsonConfig<PlanConfig>(target) ?? {};
  fs.writeFileSync(target, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, "utf8");
  return target;
}

/** Layer defaults < ~/.pi/plan.config.json < <cwd>/.pi/plan.config.json < <cwd>/plan.config.json. */
export function loadConfig(cwd: string): PlanConfig {
  let cfg: PlanConfig = { ...DEFAULT_CONFIG };
  for (const file of foundationConfigPaths(cwd, "plan.config.json")) {
    const override = readJsonConfig<PlanConfig>(file);
    if (override) cfg = { ...cfg, ...override };
  }
  cfg.enabled = cfg.enabled !== false;
  cfg.offerDeclined = cfg.offerDeclined === true;
  if (typeof cfg.blueprintPath !== "string" || !cfg.blueprintPath) cfg.blueprintPath = DEFAULT_CONFIG.blueprintPath;
  if (typeof cfg.refsDir !== "string" || !cfg.refsDir) cfg.refsDir = DEFAULT_CONFIG.refsDir;
  if (typeof cfg.rereadAboveWords !== "number" || !Number.isFinite(cfg.rereadAboveWords) || cfg.rereadAboveWords < 0) {
    cfg.rereadAboveWords = DEFAULT_CONFIG.rereadAboveWords;
  }
  return cfg;
}
