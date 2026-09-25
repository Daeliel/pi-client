import * as fs from "node:fs";
import * as path from "node:path";
import type { PolishLevel } from "./config";

export type SurfaceStatus = "raw" | "polished";

/** A weakness the critic named that has not been confirmed fixed yet. */
export interface OpenWeakness {
  text: string;
  /** How many passes in a row named this same weakness. */
  namings: number;
}

/** One user-facing thing (screen, menu, page) that polish tracks. */
export interface Surface {
  id: string;
  name: string;
  /** Path appended to the Playwright baseURL when capturing this surface. */
  urlPath: string;
  status: SurfaceStatus;
  /** Total polish passes ever run on this surface. */
  passes: number;
  open: OpenWeakness[];
  /** Files known to belong to this surface (scenario spec + files edited during its passes). Normalised, lowercase. */
  files: string[];
  /** Why the loop stopped without reaching "polished", if it did. */
  note?: string;
  updatedAt: number;
}

export interface Inventory {
  version: 1;
  surfaces: Surface[];
}

export function emptyInventory(): Inventory {
  return { version: 1, surfaces: [] };
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "surface"
  );
}

// ---------- disk ----------

export function loadInventory(cwd: string, relPath: string): Inventory {
  const file = path.join(cwd, relPath);
  try {
    if (!fs.existsSync(file)) return emptyInventory();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Inventory>;
    if (!parsed || !Array.isArray(parsed.surfaces)) return emptyInventory();
    const surfaces = parsed.surfaces.filter(isSurface);
    for (const s of surfaces) if (!Array.isArray(s.files)) s.files = [];
    return { version: 1, surfaces };
  } catch {
    return emptyInventory();
  }
}

/** Comparable form for file paths: forward slashes, lowercase, no leading ./ */
export function normalizeFile(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** Two paths refer to the same file if one is a suffix of the other on a path boundary (relative vs absolute). */
export function sameFile(a: string, b: string): boolean {
  const x = normalizeFile(a);
  const y = normalizeFile(b);
  if (x === y) return true;
  return x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

export function addSurfaceFiles(surface: Surface, files: Iterable<string>): void {
  for (const f of files) {
    const n = normalizeFile(f);
    if (!n || n.startsWith(".pi/")) continue;
    if (!surface.files.some((existing) => sameFile(existing, n))) surface.files.push(n);
  }
}

/** Surfaces that own at least one of the given files. */
export function surfacesTouchingFiles(inv: Inventory, files: Iterable<string>): Surface[] {
  const list = [...files];
  return inv.surfaces.filter((s) => s.files.some((sf) => list.some((f) => sameFile(sf, f))));
}

function isSurface(v: unknown): v is Surface {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === "string" && typeof s.name === "string" && (s.status === "raw" || s.status === "polished");
}

/** Atomic write (tmp + rename) — a crash mid-write must not leave a half file. */
export function saveInventory(cwd: string, relPath: string, inv: Inventory): void {
  const file = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(inv, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

// ---------- surfaces ----------

export function findSurface(inv: Inventory, nameOrId: string): Surface | undefined {
  const id = slugify(nameOrId);
  return inv.surfaces.find((s) => s.id === id || s.name.toLowerCase() === nameOrId.trim().toLowerCase());
}

/** Add or refresh a surface. Never downgrades a polished surface. */
export function upsertSurface(inv: Inventory, name: string, urlPath?: string): Surface {
  const existing = findSurface(inv, name);
  if (existing) {
    if (urlPath && urlPath !== existing.urlPath) {
      existing.urlPath = urlPath;
      existing.updatedAt = Date.now();
    }
    return existing;
  }
  const surface: Surface = {
    id: slugify(name),
    name: name.trim(),
    urlPath: urlPath || "/",
    status: "raw",
    passes: 0,
    open: [],
    files: [],
    updatedAt: Date.now(),
  };
  inv.surfaces.push(surface);
  return surface;
}

/** define_scenarios already lists every user-visible flow — reuse it as the surface source. */
export function seedFromScenarios(
  inv: Inventory,
  defs: Array<{ title?: unknown; kind?: unknown; testFile?: unknown }>,
): { added: Surface[]; touched: Surface[] } {
  const added: Surface[] = [];
  const touched: Surface[] = [];
  for (const d of defs) {
    if (d.kind !== "web" || typeof d.title !== "string" || !d.title.trim()) continue;
    const before = inv.surfaces.length;
    const s = upsertSurface(inv, d.title);
    if (inv.surfaces.length > before) added.push(s);
    touched.push(s);
    if (typeof d.testFile === "string" && d.testFile.trim()) {
      // Spec files live under .pi/ and are excluded by addSurfaceFiles; keep them here on purpose —
      // they are the one file we know for sure belongs to this surface.
      const n = normalizeFile(d.testFile);
      if (!s.files.some((f) => sameFile(f, n))) s.files.push(n);
    }
  }
  return { added, touched };
}

/** Surfaces whose name is mentioned in the prompt (whole-word, case-insensitive). */
export function surfacesMentioned(inv: Inventory, prompt: string): Surface[] {
  const text = prompt.toLowerCase();
  return inv.surfaces.filter((s) => {
    const name = s.name.toLowerCase();
    if (name.length < 3) return false;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(name)}([^a-z0-9]|$)`, "i");
    return re.test(text);
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function reopenSurface(surface: Surface, reason: string): void {
  surface.status = "raw";
  surface.note = reason;
  surface.updatedAt = Date.now();
}

export function markPolished(surface: Surface): void {
  surface.status = "polished";
  surface.open = [];
  surface.note = undefined;
  surface.updatedAt = Date.now();
}

/**
 * Which surface gets the next pass.
 * raw first (least-worked first); ultimate also revisits polished surfaces.
 * When `scope` is given, only surfaces in it are considered (specific user request).
 */
export function pickNextSurface(
  inv: Inventory,
  level: PolishLevel,
  exclude: Set<string>,
  scope?: Set<string>,
): Surface | undefined {
  const candidates = inv.surfaces.filter((s) => !exclude.has(s.id) && (!scope || scope.has(s.id)));
  const raw = candidates.filter((s) => s.status === "raw").sort((a, b) => a.passes - b.passes || a.updatedAt - b.updatedAt);
  if (raw.length > 0) return raw[0];
  if (level !== "ultimate") return undefined;
  const polished = candidates.filter((s) => s.status === "polished").sort((a, b) => a.passes - b.passes);
  return polished[0];
}

// ---------- weakness matching ----------

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "and", "or", "of", "to", "in", "on", "it", "its", "this", "that", "with", "for",
  "be", "should", "could", "would", "very", "too", "not", "no", "has", "have", "looks", "look", "like", "still",
  "needs", "need", "more", "less", "some", "there", "which", "into", "than", "as", "at", "by", "from",
]);

export function weaknessTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9#\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** Jaccard similarity on content words. */
export function weaknessSimilarity(a: string, b: string): number {
  const ta = weaknessTokens(a);
  const tb = weaknessTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

export const SAME_WEAKNESS_THRESHOLD = 0.45;

export function isSameWeakness(a: string, b: string): boolean {
  return weaknessSimilarity(a, b) >= SAME_WEAKNESS_THRESHOLD;
}

export interface RecordResult {
  /** Named again this pass (namings incremented). */
  repeated: OpenWeakness[];
  /** First time named. */
  fresh: OpenWeakness[];
  /** Named ≥ maxNamings times — stop working on these. */
  exhausted: OpenWeakness[];
  /** Previously open, not named this pass → treated as fixed. */
  resolved: OpenWeakness[];
}

/**
 * Merge this pass's weaknesses into the surface's open list.
 * Anything open that was not named again counts as resolved.
 */
export function recordWeaknesses(surface: Surface, named: string[], maxNamings: number): RecordResult {
  const result: RecordResult = { repeated: [], fresh: [], exhausted: [], resolved: [] };
  const next: OpenWeakness[] = [];
  const matchedOld = new Set<OpenWeakness>();

  for (const raw of named) {
    const text = raw.trim();
    if (!text) continue;
    const old = surface.open.find((o) => !matchedOld.has(o) && isSameWeakness(o.text, text));
    if (old) {
      matchedOld.add(old);
      const w: OpenWeakness = { text, namings: old.namings + 1 };
      next.push(w);
      result.repeated.push(w);
      if (w.namings >= maxNamings) result.exhausted.push(w);
    } else {
      const w: OpenWeakness = { text, namings: 1 };
      next.push(w);
      result.fresh.push(w);
    }
  }
  for (const o of surface.open) if (!matchedOld.has(o)) result.resolved.push(o);

  surface.open = next;
  surface.updatedAt = Date.now();
  return result;
}

// ---------- formatting ----------

export function formatSurfaceLine(s: Surface): string {
  const passes = s.passes === 1 ? "1 pass" : `${s.passes} passes`;
  const open = s.open.length > 0 ? ` · open: ${s.open.map((o) => `${shorten(o.text, 60)} (${o.namings}x)`).join("; ")}` : "";
  const note = s.note ? ` · ${s.note}` : "";
  return `- ${s.name} (${s.urlPath}) — ${s.status}, ${passes}${open}${note}`;
}

export function formatInventory(inv: Inventory): string {
  if (inv.surfaces.length === 0) return "(no surfaces registered yet)";
  return inv.surfaces.map(formatSurfaceLine).join("\n");
}

function shorten(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
