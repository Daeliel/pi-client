import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Sources — what the user gave, kept as given — and points: what the sources say, one
 * statement each, quoted verbatim. The blueprint must account for every point (served by an
 * item, or listed under "Not covered"), and for text sources the quote must really be in the
 * source: a paraphrase or an invented quote is caught here, not at the end of the build.
 *
 *   sources/INDEX.md:  - SRC-1 DESIGN.md · text · 9023 words · sha 3f9a1c2b · given by user
 *   POINTS.md:         - S-07 (SRC-1 §2 The route map) "Branching goes up to 5 branches wide."
 */

export type SourceKind = "text" | "image";

export interface Source {
  id: string;
  /** Repo-relative path (a living doc in place, or a copy under sources/). */
  file: string;
  kind: SourceKind;
  words: number;
  sha: string;
  /** "given by user" | "found by model" — and anything else written after it. */
  note: string;
}

export interface Point {
  id: string;
  source: string;
  /** Where in the source ("§2 The route map"), free text. */
  where: string;
  quote: string;
  line: number;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

export function sourcesDir(blueprintPath: string): string {
  return path.posix.join(path.posix.dirname(blueprintPath.replace(/\\/g, "/")), "sources");
}

export function pointsPath(blueprintPath: string): string {
  return path.posix.join(path.posix.dirname(blueprintPath.replace(/\\/g, "/")), "POINTS.md");
}

function indexPath(blueprintPath: string): string {
  return path.posix.join(sourcesDir(blueprintPath), "INDEX.md");
}

export function fingerprint(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 12);
}

export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

// ---------- index ----------

const SOURCE_LINE = /^\s*-\s+(SRC-\d+)\s+(\S.*?)\s+·\s+(text|image)\s+·\s+(?:(\d+)\s+words\s+·\s+)?sha\s+([0-9a-f]+)(?:\s+·\s+(.*))?$/;

export function readSources(cwd: string, blueprintPath: string): Source[] {
  const abs = path.resolve(cwd, indexPath(blueprintPath));
  if (!fs.existsSync(abs)) return [];
  const out: Source[] = [];
  for (const line of fs.readFileSync(abs, "utf8").split(/\r?\n/)) {
    const m = line.match(SOURCE_LINE);
    if (!m) continue;
    out.push({ id: m[1]!, file: m[2]!, kind: m[3] as SourceKind, words: Number(m[4] ?? 0), sha: m[5]!, note: (m[6] ?? "").trim() });
  }
  return out;
}

function writeSources(cwd: string, blueprintPath: string, sources: Source[]): void {
  const abs = path.resolve(cwd, indexPath(blueprintPath));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const lines = [
    "# Sources",
    "",
    "What the plan was built from — kept as given. Fingerprints show when a source changed since its points were taken.",
    "",
    ...sources.map(
      (s) => `- ${s.id} ${s.file} · ${s.kind} · ${s.kind === "text" ? `${s.words} words · ` : ""}sha ${s.sha}${s.note ? ` · ${s.note}` : ""}`,
    ),
    "",
  ];
  fs.writeFileSync(abs, lines.join("\n"), "utf8");
}

/** Current fingerprint and size of a source file (null when it is gone). */
export function measure(cwd: string, file: string): { kind: SourceKind; words: number; sha: string } | null {
  const abs = path.resolve(cwd, file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const buf = fs.readFileSync(abs);
  const kind: SourceKind = IMAGE_EXT.test(file) ? "image" : "text";
  return { kind, words: kind === "text" ? countWords(buf.toString("utf8")) : 0, sha: fingerprint(buf) };
}

/**
 * Register a source, or re-register it after reading its changes (updates size and
 * fingerprint). `text` is saved verbatim as a new file under sources/ (the user's prompt).
 */
export function addSource(
  cwd: string,
  blueprintPath: string,
  input: { file?: string; text?: string; note?: string },
): { source: Source; refreshed: boolean } {
  const sources = readSources(cwd, blueprintPath);
  let file = input.file?.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!file) {
    if (!input.text?.trim()) throw new Error("give a file, or the text to keep (e.g. the user's request, verbatim)");
    const dir = path.resolve(cwd, sourcesDir(blueprintPath));
    fs.mkdirSync(dir, { recursive: true });
    let n = 1;
    while (fs.existsSync(path.join(dir, `prompt-${n}.md`))) n++;
    file = path.posix.join(sourcesDir(blueprintPath), `prompt-${n}.md`);
    fs.writeFileSync(path.resolve(cwd, file), `${input.text.trim()}\n`, "utf8");
  }
  const abs = path.resolve(cwd, file);
  if (path.relative(cwd, abs).startsWith("..")) throw new Error(`${file} is outside the project`);
  const now = measure(cwd, file);
  if (!now) throw new Error(`no such file: ${file}`);
  const existing = sources.find((s) => s.file.toLowerCase() === file!.toLowerCase());
  if (existing) {
    Object.assign(existing, now);
    if (input.note) existing.note = input.note;
    writeSources(cwd, blueprintPath, sources);
    return { source: existing, refreshed: true };
  }
  const next = Math.max(0, ...sources.map((s) => Number(s.id.slice(4)))) + 1;
  const source: Source = { id: `SRC-${next}`, file, ...now, note: input.note?.trim() || "given by user" };
  sources.push(source);
  writeSources(cwd, blueprintPath, sources);
  return { source, refreshed: false };
}

/** Text sources' words together — what decides the automatic second look. */
export function textWords(sources: Source[]): number {
  return sources.filter((s) => s.kind === "text").reduce((n, s) => n + s.words, 0);
}

// ---------- points ----------

const POINT_LINE = /^\s*-\s+\*{0,2}(S-\d+)\*{0,2}\s+\((SRC-\d+)\s*([^)]*)\)\s+["“](.+)["”]\s*$/;

export function readPoints(cwd: string, blueprintPath: string): { points: Point[]; malformed: string[] } | null {
  const abs = path.resolve(cwd, pointsPath(blueprintPath));
  if (!fs.existsSync(abs)) return null;
  const points: Point[] = [];
  const malformed: string[] = [];
  fs.readFileSync(abs, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!/^\s*-\s+\*{0,2}S-\d+/.test(line)) return;
      const m = line.match(POINT_LINE);
      if (!m) {
        malformed.push(`POINTS.md line ${i + 1}: write \`- S-nn (SRC-n where) "verbatim quote"\` — \`${line.trim().slice(0, 70)}\``);
        return;
      }
      points.push({ id: m[1]!, source: m[2]!, where: m[3]!.trim(), quote: m[4]!.trim(), line: i });
    });
  return { points, malformed };
}

/** Whitespace, case, quote marks and markdown emphasis do not make a quote different. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`#>]/g, "")
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** A long quote may be shortened with "…" — each piece must still be in the source, in order. */
export function quoteInSource(quote: string, sourceText: string): boolean {
  const hay = normalise(sourceText);
  let at = 0;
  for (const piece of normalise(quote).split(/\s*(?:\.\.\.|…)\s*/).filter(Boolean)) {
    const i = hay.indexOf(piece, at);
    if (i < 0) return false;
    at = i + piece.length;
  }
  return true;
}

// ---------- checks ----------

export interface SourceCheck {
  problems: string[];
  /** Sources whose file changed since they were registered. */
  changed: Source[];
  /** Points whose quote is no longer in its (changed) source. */
  staleQuotes: Point[];
}

/**
 * Sources, points and coverage. `servedIds` are the S-ids referenced from the blueprint
 * (items' `serves:`), `notCovered` the S-ids listed under "## Not covered".
 */
export function checkSources(
  cwd: string,
  blueprintPath: string,
  servedIds: Set<string>,
  notCovered: Set<string>,
): SourceCheck {
  const problems: string[] = [];
  const changed: Source[] = [];
  const staleQuotes: Point[] = [];
  const sources = readSources(cwd, blueprintPath);
  if (sources.length === 0) {
    problems.push("No sources registered — call add_source for what this plan is built from: the user's request (text, verbatim), each document, each image.");
    return { problems, changed, staleQuotes };
  }
  const textOf = new Map<string, string>();
  for (const s of sources) {
    const now = measure(cwd, s.file);
    if (!now) {
      problems.push(`${s.id} ${s.file} is gone — restore it or remove it from sources/INDEX.md.`);
      continue;
    }
    if (now.sha !== s.sha) changed.push(s);
    if (s.kind === "text") textOf.set(s.id, fs.readFileSync(path.resolve(cwd, s.file), "utf8"));
  }

  const read = readPoints(cwd, blueprintPath);
  if (!read) {
    problems.push(`No ${pointsPath(blueprintPath)} — list what the sources say, one point per line, quoted verbatim: \`- S-01 (SRC-1 §2) "…"\`.`);
    return { problems, changed, staleQuotes };
  }
  problems.push(...read.malformed);
  const seen = new Set<string>();
  const known = new Set(sources.map((s) => s.id));
  for (const p of read.points) {
    if (seen.has(p.id)) problems.push(`${p.id}: duplicate point id.`);
    seen.add(p.id);
    if (!known.has(p.source)) {
      problems.push(`${p.id}: unknown source ${p.source}.`);
      continue;
    }
    const text = textOf.get(p.source);
    if (text !== undefined && !quoteInSource(p.quote, text)) {
      const src = sources.find((s) => s.id === p.source)!;
      if (changed.includes(src)) staleQuotes.push(p);
      else problems.push(`${p.id}: the quote is not in ${p.source} — quote the source's own words (shorten with "…"), do not paraphrase: "${p.quote.slice(0, 60)}"`);
    }
  }
  for (const p of read.points) {
    if (!servedIds.has(p.id) && !notCovered.has(p.id)) {
      problems.push(`${p.id}: not served by any item and not under \`## Not covered\` — add \`serves: ${p.id}\` to the item(s) that build it, or say why it is left out.`);
    }
  }
  for (const id of [...servedIds, ...notCovered]) {
    if (/^S-\d+$/.test(id) && !seen.has(id)) problems.push(`${id} is referenced in the blueprint but is not in POINTS.md.`);
  }
  for (const s of changed) {
    problems.push(
      `${s.id} ${s.file} changed since its points were taken — re-read it, update POINTS.md (and the items serving changed points), then add_source again to record the new version.`,
    );
  }
  for (const p of staleQuotes) problems.push(`${p.id}: its quote is no longer in ${p.source} (changed) — update or remove the point and what serves it.`);
  return { problems, changed, staleQuotes };
}
