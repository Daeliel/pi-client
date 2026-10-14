import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, foundationConfigPaths } from "../shared/config-paths";
import { readJsonConfig } from "../shared/json-config";

export interface ResearchConfig {
  enabled: boolean;
  /** Stored in ~/.pi/research.config.json via /research key — env BRAVE_API_KEY wins if set. */
  apiKey?: string;
  maxResults: number;
  /** Page text per search result (only the top `contentResults` get any). */
  maxContentChars: number;
  /** How many of the top search results get their page text fetched. The rest are title + snippet. */
  contentResults: number;
  /** Page text limit for fetch_web_page — one page the model chose, so it may be longer. */
  maxPageChars: number;
  includeContentDefault: boolean;
  fetchTimeoutMs: number;
  defaultCountry: string;
}

export const DEFAULT_CONFIG: ResearchConfig = {
  enabled: true,
  maxResults: 5,
  maxContentChars: 2500,
  contentResults: 2,
  maxPageChars: 8000,
  includeContentDefault: true,
  fetchTimeoutMs: 15000,
  defaultCountry: "US",
};

function readJson(file: string): Partial<ResearchConfig> | null {
  return readJsonConfig<ResearchConfig>(file);
}

export function userResearchConfigPath(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, "research.config.json");
}

/** Layer defaults < user ~/.pi < project .pi < legacy project root. */
export function loadConfig(cwd: string): ResearchConfig {
  const layers = foundationConfigPaths(cwd, "research.config.json");
  let cfg: ResearchConfig = { ...DEFAULT_CONFIG };
  for (const file of layers) {
    const override = readJson(file);
    if (!override) continue;
    cfg = { ...cfg, ...override };
  }
  return cfg;
}

export function resolveApiKey(config: ResearchConfig): string | null {
  const fromEnv = process.env.BRAVE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = config.apiKey?.trim();
  return fromFile || null;
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function apiKeySource(config: ResearchConfig): "env" | "file" | "none" {
  if (process.env.BRAVE_API_KEY?.trim()) return "env";
  if (config.apiKey?.trim()) return "file";
  return "none";
}

/** Save API key to user-global config only (never the project repo). */
export function saveUserApiKey(apiKey: string): string {
  const file = userResearchConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing: Partial<ResearchConfig> = {};
  const current = readJson(file);
  if (current) existing = current;
  const next = { ...existing, apiKey: apiKey.trim() };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return file;
}

export function clearUserApiKey(): boolean {
  const file = userResearchConfigPath();
  if (!fs.existsSync(file)) return false;
  const current = readJson(file);
  if (!current) return false;
  const { apiKey: _removed, ...rest } = current;
  if (Object.keys(rest).length === 0) {
    fs.unlinkSync(file);
    return true;
  }
  fs.writeFileSync(file, `${JSON.stringify(rest, null, 2)}\n`, "utf8");
  return true;
}
