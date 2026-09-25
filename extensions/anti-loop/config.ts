import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, foundationConfigPaths } from "../shared/config-paths";
import { readJsonConfig } from "../shared/json-config";

export interface AntiLoopConfig {
  enabled: boolean;
  /** Identical tool+args streak before blocking the call. */
  maxIdenticalToolCalls: number;
  /** Truncation / thrash recoveries before hard-stopping the agent loop. */
  maxRecoveries: number;
  /** Auto-continue when the model hits max output tokens. */
  recoverOnTruncation: boolean;
  /** Detect "I'm stuck in a loop" style assistant text/thinking. */
  detectStuckPhrases: boolean;
  /** Detect repeated plan lines in the thinking channel (reasoning thrash). */
  detectThinkingLoops: boolean;
  /** Same normalized thinking line must appear this many times to count as a loop. */
  thinkingLoopMinRepeats: number;
  /** Recover when the model dumps Hermes/Qwen XML tools into thinking without a native toolCall. */
  recoverGhostToolCalls: boolean;
  /** User-help mode: /stuck, interrupt, last recovery, hard-stop handoff. */
  userHelp: boolean;
  /** Unique tool fingerprints with no edits before a "looks stuck" notify. 0 disables. */
  churnNotifyAfterUniqueTools: number;
}

export const DEFAULT_CONFIG: AntiLoopConfig = {
  enabled: true,
  maxIdenticalToolCalls: 3,
  maxRecoveries: 2,
  recoverOnTruncation: true,
  detectStuckPhrases: true,
  detectThinkingLoops: true,
  thinkingLoopMinRepeats: 3,
  recoverGhostToolCalls: true,
  userHelp: true,
  churnNotifyAfterUniqueTools: 6,
};

function readJson(file: string): Partial<AntiLoopConfig> | null {
  return readJsonConfig<AntiLoopConfig>(file);
}

export function loadConfig(cwd: string): AntiLoopConfig {
  const layers = foundationConfigPaths(cwd, "anti-loop.config.json");
  let cfg: AntiLoopConfig = { ...DEFAULT_CONFIG };
  for (const file of layers) {
    const override = readJson(file);
    if (!override) continue;
    cfg = { ...cfg, ...override };
  }
  return cfg;
}

export function userAntiLoopConfigPath(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, "anti-loop.config.json");
}

export function projectAntiLoopConfigPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, "anti-loop.config.json");
}

export function persistEnabled(cwd: string, enabled: boolean, scope: "user" | "project"): string {
  const target = scope === "user" ? userAntiLoopConfigPath() : projectAntiLoopConfigPath(cwd);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = readJson(target) ?? {};
  const toWrite = { ...existing, enabled };
  fs.writeFileSync(target, `${JSON.stringify(toWrite, null, 2)}\n`, "utf8");
  return target;
}
