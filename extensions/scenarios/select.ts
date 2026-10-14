import * as fs from "node:fs";
import * as path from "node:path";
import { isCodePath } from "../shared/edit-tools";
import type { ScenarioDefinition } from "./types";

/**
 * Which specs the standard level runs for a change: the task's own specs, the smoke specs,
 * and the specs the changed code belongs to. Thorough runs everything and never calls this.
 *
 * A spec says what it proves with a header line, `// @covers: src/systems/energy.js, src/ui/**`.
 * Without one, its file name is matched against the changed files' names word by word
 * (energy-charge.spec.ts ↔ src/systems/energy.js), so older specs are picked up too.
 */

export interface StandardPick {
  run: ScenarioDefinition[];
  skipped: ScenarioDefinition[];
  /** scenario id → why it runs ("this task", "smoke", "covers src/x.js", "name matches src/x.js"). */
  reasons: Record<string, string>;
  /** Changed code files that no spec (other than smoke) claims. */
  uncovered: string[];
}

/** Words too common in file names to say anything about what a spec covers. */
const STOP_WORDS = new Set([
  "spec", "test", "tests", "index", "main", "utils", "util", "helper", "helpers", "types", "type",
  "config", "state", "game", "core", "common", "shared", "constants", "data", "module", "scenario",
]);

const SMOKE_NAME = /^smoke[-_.]/i;
const SMOKE_TAG = /@smoke\b/;
const COVERS = /@covers\s*:?\s*(.+)$/gim;

/** Repo-relative posix path, lower case, for comparing edited paths with headers. */
export function relKey(cwd: string, file: string): string {
  const abs = path.resolve(cwd, file);
  return path.relative(cwd, abs).replace(/\\/g, "/").toLowerCase();
}

/** The words of a file name: craneYard.js → crane, yard; room-energy-pool.spec.ts → room, energy, pool. */
export function nameWords(file: string): string[] {
  const base = path.basename(file.replace(/\\/g, "/")).replace(/(\.(spec|test))?\.[a-z0-9]+$/i, "");
  return base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w))
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

/** Paths and globs from `@covers:` lines (comma or space separated). */
export function parseCovers(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(COVERS)) {
    for (const part of m[1]!.split(/[,\s]+/)) {
      const p = part.trim().replace(/\*\/$/, "").replace(/\\/g, "/").replace(/^\.\//, "");
      if (p) out.push(p.toLowerCase());
    }
  }
  return out;
}

/** `src/ui/**`, `src/*.js` and `src/systems/` (a folder) style patterns against a repo-relative path. */
export function coversMatch(pattern: string, rel: string): boolean {
  if (!/[*?]/.test(pattern)) {
    return pattern.endsWith("/") ? rel.startsWith(pattern) : rel === pattern || rel.startsWith(`${pattern}/`);
  }
  const re = pattern
    .split("**")
    .map((piece) => piece.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
    .join(".*");
  return new RegExp(`^${re}$`).test(rel);
}

export function isSmokeSpec(testFile: string, content: string): boolean {
  return SMOKE_NAME.test(path.basename(testFile)) || SMOKE_TAG.test(content);
}

function readSpec(cwd: string, testFile: string): string {
  try {
    return fs.readFileSync(path.resolve(cwd, testFile), "utf8");
  } catch {
    return "";
  }
}

export function pickStandard(
  cwd: string,
  specs: ScenarioDefinition[],
  changedFiles: Iterable<string>,
  focusFiles: Iterable<string>,
  read: (testFile: string) => string = (f) => readSpec(cwd, f),
): StandardPick {
  const focus = new Set([...focusFiles].map((f) => relKey(cwd, f)));
  const specKeys = new Set(specs.map((s) => relKey(cwd, s.testFile)));
  const changed = [...new Set([...changedFiles].map((f) => relKey(cwd, f)))].filter(
    (f) => isCodePath(f) && !specKeys.has(f) && !f.includes("/.pi/scenarios/") && !f.startsWith(".pi/scenarios/"),
  );
  const claimed = new Set<string>();
  const run: ScenarioDefinition[] = [];
  const skipped: ScenarioDefinition[] = [];
  const reasons: Record<string, string> = {};

  for (const spec of specs) {
    const key = relKey(cwd, spec.testFile);
    const content = read(spec.testFile);
    const covers = parseCovers(content);
    const words = new Set(nameWords(spec.testFile));
    const hits = changed.filter((f) =>
      covers.length > 0 ? covers.some((c) => coversMatch(c, f)) : nameWords(f).some((w) => words.has(w)),
    );
    for (const f of hits) claimed.add(f);

    let why = "";
    if (focus.has(key)) why = "this task";
    else if (isSmokeSpec(spec.testFile, content)) why = "smoke";
    else if (hits.length > 0) why = `${covers.length > 0 ? "covers" : "name matches"} ${hits[0]}`;

    if (why) {
      reasons[spec.id] = why;
      run.push(spec);
    } else {
      skipped.push(spec);
    }
  }
  return { run, skipped, reasons, uncovered: changed.filter((f) => !claimed.has(f)) };
}

/** One paragraph for the model and the user: what ran, what did not, how to run it all. */
export function formatStandardNote(pick: StandardPick): string {
  const total = pick.run.length + pick.skipped.length;
  const lines = [
    `Standard level: ran ${pick.run.length} of ${total} spec(s) — ` +
      (pick.run.map((s) => `${s.id} (${pick.reasons[s.id]})`).join(", ") || "none") +
      ".",
  ];
  if (pick.uncovered.length > 0) {
    lines.push(
      `No spec covers: ${pick.uncovered.slice(0, 6).join(", ")}${pick.uncovered.length > 6 ? ", …" : ""} — ` +
        "add an `@covers:` line to the spec that proves it, or rely on smoke.",
    );
  }
  if (pick.skipped.length > 0) {
    lines.push("Before calling a milestone done, run everything: run_scenarios with all: true (or /scenarios run-all).");
  }
  return lines.join("\n");
}
