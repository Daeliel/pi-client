import * as fs from "node:fs";
import * as path from "node:path";
import type { ScenariosConfig } from "./config";
import { filterForAutoRun } from "./housekeeping";
import type { ScenarioDefinition } from "./types";

const SKIP_FILES = new Set(["__qa-capture.spec.ts"]);

function normalizeTestFile(testFile: string): string {
  return testFile.replace(/\\/g, "/").toLowerCase();
}

function idFromFilename(filename: string): string {
  const base = filename.replace(/\.(spec\.ts|test\.py|test\.ts)$/i, "");
  return base.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "scenario";
}

function titleFromSpec(content: string, fallback: string): string {
  const m = content.match(/test\s*(?:\.(?:only|skip))?\s*\(\s*["'`]([^"'`]+)["'`]/);
  return m?.[1]?.trim() || fallback;
}

function kindFromFilename(filename: string): ScenarioDefinition["kind"] | null {
  if (filename.endsWith(".spec.ts")) return "web";
  if (filename.endsWith(".test.py") || /^test_.*\.py$/i.test(filename)) return "api";
  return null;
}

/** Scan scenariosDir for runnable test files not managed by define_scenarios alone. */
export function discoverScenariosFromDisk(cwd: string, config: ScenariosConfig): ScenarioDefinition[] {
  const dir = path.join(cwd, config.scenariosDir);
  if (!fs.existsSync(dir)) return [];

  const found: ScenarioDefinition[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;

    const kind = kindFromFilename(entry.name);
    if (!kind) continue;

    const testFile = path.join(config.scenariosDir, entry.name).replace(/\\/g, "/");
    const abs = path.join(cwd, testFile);
    let title = `Discovered: ${idFromFilename(entry.name)}`;
    let steps = "Auto-discovered from disk — see test file for steps.";

    try {
      const content = fs.readFileSync(abs, "utf8");
      if (kind === "web") {
        title = titleFromSpec(content, title);
      }
    } catch {
      // keep defaults
    }

    found.push({
      id: idFromFilename(entry.name),
      title,
      steps,
      testFile,
      kind,
    });
  }

  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** Registered entries override discovered entries that share the same testFile. */
export function mergeScenarioLists(
  registered: ScenarioDefinition[],
  discovered: ScenarioDefinition[],
): ScenarioDefinition[] {
  const byFile = new Map<string, ScenarioDefinition>();
  for (const d of discovered) byFile.set(normalizeTestFile(d.testFile), d);
  for (const r of registered) byFile.set(normalizeTestFile(r.testFile), r);
  return [...byFile.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveEffectiveScenarios(
  cwd: string,
  registered: ScenarioDefinition[],
  config: ScenariosConfig,
): ScenarioDefinition[] {
  let list: ScenarioDefinition[];
  if (!config.autoDiscoverScenarios) {
    list = registered;
  } else {
    const discovered = discoverScenariosFromDisk(cwd, config);
    list = registered.length === 0 ? discovered : mergeScenarioLists(registered, discovered);
  }
  return filterForAutoRun(list, cwd, config);
}

export function formatDiscoveredSummary(discovered: ScenarioDefinition[], registered: ScenarioDefinition[]): string {
  if (discovered.length === 0) return "No spec files found on disk.";
  const regFiles = new Set(registered.map((r) => normalizeTestFile(r.testFile)));
  const onlyDisk = discovered.filter((d) => !regFiles.has(normalizeTestFile(d.testFile)));
  const lines = [`Discovered ${discovered.length} test file(s) in scenarios dir:`];
  for (const d of discovered) {
    const tag = regFiles.has(normalizeTestFile(d.testFile)) ? "registered" : "disk-only";
    lines.push(`  - ${d.id} [${d.kind}] ${d.testFile} (${tag})`);
  }
  if (onlyDisk.length > 0) {
    lines.push("", `${onlyDisk.length} on disk but not in this session — run /scenarios sync or run_scenarios (auto-merge).`);
  }
  return lines.join("\n");
}
