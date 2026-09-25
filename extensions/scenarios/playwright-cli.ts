import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const pexec = promisify(exec);

const cliCache = new Map<string, string>();

async function probe(cmd: string, cwd: string): Promise<boolean> {
  try {
    await pexec(`${cmd} --version`, { cwd, timeout: 15000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** True when the project has @playwright/test installed locally. */
export function projectHasLocalPlaywright(cwd: string): boolean {
  if (fs.existsSync(path.join(cwd, "node_modules", "@playwright/test", "package.json"))) {
    return true;
  }
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Boolean(deps["@playwright/test"]);
  } catch {
    return false;
  }
}

function npmGlobalPlaywrightCandidates(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return [];
  if (process.platform === "win32") {
    const npmBin = path.join(home, "AppData/Roaming/npm");
    return ["playwright.cmd", "playwright.ps1", "playwright"].map((name) => path.join(npmBin, name));
  }
  const prefix = process.env.NPM_CONFIG_PREFIX || path.join(home, ".npm-global");
  return [path.join(prefix, "bin", "playwright"), "/usr/local/bin/playwright"];
}

/**
 * Resolve Playwright CLI for a project cwd.
 * Local npx wins when @playwright/test is in the project — global CLI + local
 * node_modules/playwright causes module resolution conflicts on Windows.
 */
export async function resolvePlaywrightCli(cwd: string): Promise<string> {
  const key = path.resolve(cwd);
  const cached = cliCache.get(key);
  if (cached) return cached;

  if (projectHasLocalPlaywright(cwd)) {
    for (const cmd of ["npx --no-install playwright", "npx playwright"]) {
      if (await probe(cmd, cwd)) {
        cliCache.set(key, cmd);
        return cmd;
      }
    }
  }

  if (await probe("playwright", cwd)) {
    cliCache.set(key, "playwright");
    return "playwright";
  }

  for (const cliPath of npmGlobalPlaywrightCandidates()) {
    if (!fs.existsSync(cliPath)) continue;
    const quoted = `"${cliPath.replace(/"/g, '\\"')}"`;
    if (await probe(quoted, cwd)) {
      cliCache.set(key, quoted);
      return quoted;
    }
  }

  const fallback = projectHasLocalPlaywright(cwd) ? "npx playwright" : "playwright";
  cliCache.set(key, fallback);
  return fallback;
}

/** Clear cache (tests or cwd switch in long sessions). */
export function clearPlaywrightCliCache(): void {
  cliCache.clear();
}
