import * as fs from "node:fs";
import * as path from "node:path";
import type { ScenariosConfig } from "./config";

function newestMtime(root: string, ext?: string): number | null {
  if (!fs.existsSync(root)) return null;
  let newest: number | null = null;

  const visit = (p: string) => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        visit(path.join(p, entry.name));
      }
      return;
    }
    if (ext && !p.endsWith(ext)) return;
    newest = newest === null ? stat.mtimeMs : Math.max(newest, stat.mtimeMs);
  };

  visit(root);
  return newest;
}

function servesStaticWebBuild(cwd: string, config: ScenariosConfig): boolean {
  const pwPath = path.join(cwd, config.playwrightConfig);
  if (!fs.existsSync(pwPath)) return false;
  try {
    const text = fs.readFileSync(pwPath, "utf8");
    return (
      text.includes("build/web") ||
      text.includes("build\\web") ||
      text.includes("server.mjs") ||
      text.includes("server.js")
    );
  } catch {
    return false;
  }
}

/**
 * Warn when Flutter Dart sources are newer than build/web (Playwright serves stale UI).
 * Does not fail the run — surfaces in report so the model rebuilds.
 */
export function checkStaleFlutterWebBuild(cwd: string, config: ScenariosConfig): string | null {
  if (!fs.existsSync(path.join(cwd, "pubspec.yaml"))) return null;
  if (!servesStaticWebBuild(cwd, config)) return null;

  const buildWeb = path.join(cwd, "build/web");
  if (!fs.existsSync(buildWeb)) {
    return (
      "WARNING: Flutter project has no build/web yet. Run `flutter build web` before run_scenarios " +
      "when Playwright serves static output."
    );
  }

  const libNewest = newestMtime(path.join(cwd, "lib"), ".dart");
  const buildNewest = newestMtime(buildWeb);
  if (libNewest === null || buildNewest === null) return null;
  if (libNewest <= buildNewest) return null;

  const libAge = new Date(libNewest).toISOString();
  const buildAge = new Date(buildNewest).toISOString();
  return (
    "WARNING: Stale web build — lib/**/*.dart is newer than build/web. " +
    `Sources: ${libAge}; build/web: ${buildAge}. ` +
    "Run `flutter build web` (then restart static server if needed) before trusting scenario passes or screenshots."
  );
}

export function collectPreflightWarnings(cwd: string, config: ScenariosConfig): string[] {
  const warnings: string[] = [];
  const stale = checkStaleFlutterWebBuild(cwd, config);
  if (stale) warnings.push(stale);
  return warnings;
}
