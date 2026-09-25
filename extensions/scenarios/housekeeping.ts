import * as fs from "node:fs";
import * as path from "node:path";
import type { ScenariosConfig } from "./config";
import type { ScenarioDefinition } from "./types";

export const HOUSEKEEP_MANIFEST = ".housekeep.json";

export interface HousekeepManifest {
  /** group key → canonical testFile (posix path under project). */
  canonicalByGroup?: Record<string, string>;
}

export interface DuplicateGroup {
  key: string;
  members: ScenarioDefinition[];
  canonical?: string;
}

export interface ScenarioAudit {
  total: number;
  maxRecommended: number;
  scratch: ScenarioDefinition[];
  duplicateGroups: DuplicateGroup[];
  solo: ScenarioDefinition[];
  failedLastRun: ScenarioDefinition[];
  passedLastRun: ScenarioDefinition[];
  manifestPath: string;
}

const SCRATCH_RE = /^__.+\.(spec\.ts|test\.py)$/i;
const ALWAYS_SKIP = new Set(["__qa-capture.spec.ts"]);

export function isScratchSpecFile(filename: string): boolean {
  if (ALWAYS_SKIP.has(filename)) return true;
  return SCRATCH_RE.test(filename);
}

export function scenarioFilename(testFile: string): string {
  return path.basename(testFile.replace(/\\/g, "/"));
}

export function groupKeyForId(id: string): string {
  const token = id.split("-")[0]?.trim().toLowerCase();
  return token || id.toLowerCase();
}

export function manifestPath(cwd: string, config: ScenariosConfig): string {
  return path.join(cwd, config.scenariosDir, HOUSEKEEP_MANIFEST);
}

export function loadHousekeepManifest(cwd: string, config: ScenariosConfig): HousekeepManifest {
  const file = manifestPath(cwd, config);
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")) as HousekeepManifest;
  } catch {
    return {};
  }
}

export function saveHousekeepManifest(cwd: string, config: ScenariosConfig, manifest: HousekeepManifest): string {
  const file = manifestPath(cwd, config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return file;
}

function normalizeFile(f: string): string {
  return f.replace(/\\/g, "/").toLowerCase();
}

export function buildDuplicateGroups(
  discovered: ScenarioDefinition[],
  manifest: HousekeepManifest,
): { groups: DuplicateGroup[]; solo: ScenarioDefinition[] } {
  const byKey = new Map<string, ScenarioDefinition[]>();
  for (const s of discovered) {
    if (isScratchSpecFile(scenarioFilename(s.testFile))) continue;
    const key = groupKeyForId(s.id);
    const list = byKey.get(key) ?? [];
    list.push(s);
    byKey.set(key, list);
  }

  const groups: DuplicateGroup[] = [];
  const solo: ScenarioDefinition[] = [];

  for (const [key, members] of [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (members.length < 2) {
      solo.push(members[0]!);
      continue;
    }
    const sorted = [...members].sort((a, b) => a.id.localeCompare(b.id));
    const canonical = manifest.canonicalByGroup?.[key];
    groups.push({ key, members: sorted, canonical });
  }

  solo.sort((a, b) => a.id.localeCompare(b.id));
  return { groups, solo };
}

export function auditScenarios(
  cwd: string,
  config: ScenariosConfig,
  discovered: ScenarioDefinition[],
  lastRunById: Record<string, "pass" | "fail" | "skip"> = {},
): ScenarioAudit {
  const manifest = loadHousekeepManifest(cwd, config);
  const scratch = discovered.filter((s) => isScratchSpecFile(scenarioFilename(s.testFile)));
  const { groups, solo } = buildDuplicateGroups(discovered, manifest);

  const failedLastRun = discovered.filter((s) => lastRunById[s.id] === "fail");
  const passedLastRun = discovered.filter((s) => lastRunById[s.id] === "pass");

  return {
    total: discovered.length,
    maxRecommended: config.housekeeping.maxSpecsBeforeAudit,
    scratch,
    duplicateGroups: groups,
    solo,
    failedLastRun,
    passedLastRun,
    manifestPath: manifestPath(cwd, config),
  };
}

/** Auto-run list: skip scratch; when canonical chosen for a group, skip siblings. */
export function filterForAutoRun(
  discovered: ScenarioDefinition[],
  cwd: string,
  config: ScenariosConfig,
): ScenarioDefinition[] {
  if (!config.housekeeping.enabled) return discovered;

  const manifest = loadHousekeepManifest(cwd, config);
  const { groups } = buildDuplicateGroups(discovered, manifest);
  const suppressed = new Set<string>();

  for (const g of groups) {
    const canonical = g.canonical;
    if (!canonical) continue;
    const canonNorm = normalizeFile(canonical);
    for (const m of g.members) {
      if (normalizeFile(m.testFile) !== canonNorm) {
        suppressed.add(normalizeFile(m.testFile));
      }
    }
  }

  return discovered.filter((s) => {
    const name = scenarioFilename(s.testFile);
    if (config.housekeeping.skipScratchInAutoRun && isScratchSpecFile(name)) return false;
    if (suppressed.has(normalizeFile(s.testFile))) return false;
    return true;
  });
}

export function setCanonicalPick(
  cwd: string,
  config: ScenariosConfig,
  groupKey: string,
  index1Based: number,
  discovered: ScenarioDefinition[],
): { ok: boolean; message: string; manifestPath?: string } {
  const { groups } = buildDuplicateGroups(discovered, loadHousekeepManifest(cwd, config));
  const group = groups.find((g) => g.key === groupKey.toLowerCase());
  if (!group) {
    const keys = groups.map((g) => g.key).join(", ") || "(none)";
    return { ok: false, message: `No duplicate group "${groupKey}". Groups: ${keys}` };
  }
  if (index1Based < 1 || index1Based > group.members.length) {
    return { ok: false, message: `Pick 1–${group.members.length} for group "${group.key}".` };
  }

  const picked = group.members[index1Based - 1]!;
  const manifest = loadHousekeepManifest(cwd, config);
  manifest.canonicalByGroup = manifest.canonicalByGroup ?? {};
  manifest.canonicalByGroup[group.key] = picked.testFile;
  const saved = saveHousekeepManifest(cwd, config, manifest);

  return {
    ok: true,
    message: `Canonical for "${group.key}": ${picked.id} (${picked.testFile}). Others in this group are skipped on auto-run until you /scenarios tidy apply yes.`,
    manifestPath: saved,
  };
}

export interface ApplyHousekeepResult {
  deleted: string[];
  skipped: string[];
}

export function deleteScratchFiles(cwd: string, discovered: ScenarioDefinition[]): ApplyHousekeepResult {
  const deleted: string[] = [];
  for (const s of discovered) {
    if (!isScratchSpecFile(scenarioFilename(s.testFile))) continue;
    const abs = path.join(cwd, s.testFile);
    if (!fs.existsSync(abs)) continue;
    fs.unlinkSync(abs);
    deleted.push(s.testFile);
  }
  return { deleted, skipped: [] };
}

export function applyCanonicalDeletions(
  cwd: string,
  config: ScenariosConfig,
  discovered: ScenarioDefinition[],
): ApplyHousekeepResult {
  const manifest = loadHousekeepManifest(cwd, config);
  const { groups } = buildDuplicateGroups(discovered, manifest);
  const deleted: string[] = [];
  const skipped: string[] = [];

  for (const g of groups) {
    const canonical = g.canonical ?? manifest.canonicalByGroup?.[g.key];
    if (!canonical) {
      skipped.push(`group "${g.key}" (no canonical — use /scenarios pick ${g.key} <n> first)`);
      continue;
    }
    const canonNorm = normalizeFile(canonical);
    for (const m of g.members) {
      if (normalizeFile(m.testFile) === canonNorm) continue;
      const abs = path.join(cwd, m.testFile);
      if (!fs.existsSync(abs)) continue;
      fs.unlinkSync(abs);
      deleted.push(m.testFile);
    }
  }

  return { deleted, skipped };
}

export function formatTidyReport(audit: ScenarioAudit): string {
  const lines: string[] = [
    "=== Scenario housekeeping ===",
    `Total on disk: ${audit.total} (recommended max: ${audit.maxRecommended})`,
    `Manifest: ${audit.manifestPath}`,
    "",
  ];

  if (audit.scratch.length > 0) {
    lines.push("SCRATCH (skipped from auto-run; safe to delete):");
    for (const s of audit.scratch) {
      lines.push(`  - ${s.testFile}`);
    }
    lines.push("  → /scenarios tidy scratch yes");
    lines.push("");
  }

  if (audit.duplicateGroups.length > 0) {
    lines.push("DUPLICATE GROUPS (pick ONE canonical per group):");
    for (const g of audit.duplicateGroups) {
      lines.push(`  [${g.key}]${g.canonical ? ` canonical: ${g.canonical}` : ""}`);
      g.members.forEach((m, i) => {
        lines.push(`    ${i + 1}. ${m.id} — ${m.title}`);
        lines.push(`       ${m.testFile}`);
      });
      lines.push(`    → /scenarios pick ${g.key} <number>`);
    }
    lines.push("  → /scenarios tidy apply yes   (delete non-canonical in resolved groups)");
    lines.push("");
  }

  if (audit.failedLastRun.length > 0) {
    lines.push("FAILED LAST RUN (fix or delete):");
    for (const s of audit.failedLastRun) lines.push(`  - ${s.id} — ${s.testFile}`);
    lines.push("");
  }

  if (audit.solo.length > 0) {
    lines.push("SOLO (no duplicate group):");
    for (const s of audit.solo) lines.push(`  - ${s.id}`);
    lines.push("");
  }

  lines.push("COMMANDS:");
  lines.push("  /scenarios tidy              — this menu");
  lines.push("  /scenarios pick <group> <n>  — mark canonical");
  lines.push("  /scenarios tidy scratch yes  — delete scratch files");
  lines.push("  /scenarios tidy apply yes    — delete non-canonical (groups you picked)");

  return lines.join("\n");
}

export function formatCompactTidyHint(audit: ScenarioAudit): string {
  const parts: string[] = [];
  if (audit.total > audit.maxRecommended) {
    parts.push(`${audit.total} specs (max ${audit.maxRecommended})`);
  }
  if (audit.scratch.length > 0) parts.push(`${audit.scratch.length} scratch`);
  if (audit.duplicateGroups.some((g) => !g.canonical)) {
    parts.push(`${audit.duplicateGroups.filter((g) => !g.canonical).length} groups need canonical pick`);
  }
  if (parts.length === 0) return "";
  return `Scenario housekeeping: ${parts.join(", ")}. Run /scenarios tidy`;
}
