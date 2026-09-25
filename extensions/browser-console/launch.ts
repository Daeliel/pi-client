import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserConsoleConfig } from "./config";
import { sleep } from "./cdp";

const CHROME_CANDIDATES_WIN = [
  () => path.join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  () => path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  () => path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  () => path.join(process.env.PROGRAMFILES ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  () => path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
];

const CHROME_CANDIDATES_UNIX = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

export function isCdpConnectionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("fetch failed") ||
    lower.includes("econnrefused") ||
    lower.includes("cdp list failed") ||
    lower.includes("network request failed") ||
    lower.includes("socket hang up")
  );
}

export function findBrowserExecutable(config: BrowserConsoleConfig): string | null {
  if (config.browserExecutable && fs.existsSync(config.browserExecutable)) {
    return config.browserExecutable;
  }
  const candidates =
    process.platform === "win32"
      ? CHROME_CANDIDATES_WIN.map((fn) => fn())
      : CHROME_CANDIDATES_UNIX;
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function defaultDebugProfileDir(): string {
  return path.join(os.homedir(), ".pi", "chrome-debug");
}

export async function isCdpReachable(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Start Chrome/Edge with a dedicated debug profile if CDP is not reachable. */
export async function launchDebugBrowser(config: BrowserConsoleConfig, openUrl?: string): Promise<void> {
  const exe = findBrowserExecutable(config);
  if (!exe) {
    throw new Error(
      "Chrome or Edge not found. Install Chrome, or set browserExecutable in browser-console.config.json",
    );
  }

  const profile = config.debugUserDataDir ?? defaultDebugProfileDir();
  fs.mkdirSync(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
  ];

  const url = openUrl ?? config.launchUrl;
  if (url) args.push(url);

  spawn(exe, args, { detached: true, stdio: "ignore" }).unref();

  const deadline = Date.now() + config.launchWaitMs;
  while (Date.now() < deadline) {
    if (await isCdpReachable(config.cdpHost, config.cdpPort)) return;
    await sleep(400);
  }

  throw new Error(
    `Timed out waiting for CDP on ${config.cdpHost}:${config.cdpPort} after launching ${path.basename(exe)}`,
  );
}

export async function ensureDebugBrowserRunning(
  config: BrowserConsoleConfig,
  openUrl?: string,
): Promise<boolean> {
  if (await isCdpReachable(config.cdpHost, config.cdpPort)) return true;
  if (!config.autoLaunchBrowser) return false;
  await launchDebugBrowser(config, openUrl);
  return true;
}
