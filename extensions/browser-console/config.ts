import * as path from "node:path";
import { foundationConfigPaths } from "../shared/config-paths";
import { readJsonConfig } from "../shared/json-config";

export interface BrowserConsoleConfig {
  /** Master switch — when false, hooks and tools stay idle. */
  enabled: boolean;
  /** Chrome DevTools Protocol host (browser with --remote-debugging-port). */
  cdpHost: string;
  cdpPort: number;
  /** Try to connect when a pi session starts. */
  autoConnect: boolean;
  /** Substrings to match tab URL when picking a page (case-insensitive). Empty = first page tab. */
  urlMatch: string[];
  /** After web file edits, pull console errors into the tool result. */
  checkOnEdit: boolean;
  /** Reload the attached tab before checking (needs an open matching tab). */
  autoReloadOnEdit: boolean;
  /** Milliseconds to wait after reload before reading the console buffer. */
  reloadWaitMs: number;
  /** Block agent_end while console errors remain for tracked web files. */
  blocking: boolean;
  maxFixAttempts: number;
  /** Ring buffer capacity per session. */
  bufferSize: number;
  /** Collapse identical console errors in the buffer (Flutter render loops). */
  dedupeConsole: boolean;
  /** Max unique error groups in tool/agent reports. */
  maxReportGroups: number;
  /** Total character cap for console error reports. */
  maxReportChars: number;
  /** Stack lines per error in reports (full trace stays in buffer). */
  maxStackLinesInReport: number;
  /** Treat console.warn as failures (not just error / uncaught). */
  includeWarnings: boolean;
  /** Launch Chrome/Edge with --remote-debugging-port when CDP is unreachable. */
  autoLaunchBrowser: boolean;
  /** When CDP is unavailable, browser_screenshot uses Playwright instead of failing. */
  playwrightFallback: boolean;
  /** Optional path to chrome.exe / msedge.exe (auto-detected if omitted). */
  browserExecutable?: string;
  /** Separate profile dir for auto-launched debug browser (default ~/.pi/chrome-debug). */
  debugUserDataDir?: string;
  /** URL to open when auto-launching (e.g. http://localhost:5173). */
  launchUrl?: string;
  /** Max ms to wait for CDP after auto-launch. */
  launchWaitMs: number;
}

export const DEFAULT_CONFIG: BrowserConsoleConfig = {
  enabled: true,
  cdpHost: "127.0.0.1",
  cdpPort: 9222,
  autoConnect: true,
  urlMatch: [],
  checkOnEdit: true,
  autoReloadOnEdit: true,
  reloadWaitMs: 2000,
  blocking: true,
  maxFixAttempts: 5,
  bufferSize: 200,
  dedupeConsole: true,
  maxReportGroups: 20,
  maxReportChars: 12_000,
  maxStackLinesInReport: 4,
  includeWarnings: false,
  autoLaunchBrowser: true,
  playwrightFallback: true,
  launchWaitMs: 12000,
};

function readJson(file: string): Partial<BrowserConsoleConfig> | null {
  return readJsonConfig<BrowserConsoleConfig>(file);
}

/** Layer defaults < user < project CONFIG_DIR_NAME < legacy project root. */
export function loadConfig(cwd: string): BrowserConsoleConfig {
  const layers = foundationConfigPaths(cwd, "browser-console.config.json");

  let cfg: BrowserConsoleConfig = { ...DEFAULT_CONFIG, urlMatch: [...DEFAULT_CONFIG.urlMatch] };
  for (const file of layers) {
    const override = readJson(file);
    if (!override) continue;
    cfg = {
      ...cfg,
      ...override,
      urlMatch: override.urlMatch ?? cfg.urlMatch,
    };
  }
  return cfg;
}
