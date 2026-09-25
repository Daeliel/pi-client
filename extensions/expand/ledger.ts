import * as fs from "node:fs";
import * as path from "node:path";
import { isExpandAxis, type ExpandAxis } from "./config";

/**
 * The ledger is what /expand knows about the project across sessions:
 *  - systems map: what the thing IS (systems, content pools, known interactions)
 *  - pillars: what it must stay
 *  - ideas: everything proposed, with what happened to each
 */

export type SystemKind = "system" | "pool";

export interface MappedSystem {
  name: string;
  kind: SystemKind;
  /** For pools: how many entries exist (12 weapons, 3 classes). */
  count?: number;
  /** One line: what it does / what is in it. */
  summary: string;
  files: string[];
}

export interface Interaction {
  a: string;
  b: string;
  note: string;
}

export interface SystemsMap {
  systems: MappedSystem[];
  interactions: Interaction[];
  /** Gaps the mapper noticed (asymmetries, dead ends). Ideas are supposed to build on these. */
  gaps: string[];
  mappedAt: number;
}

export type IdeaFit = "high" | "medium" | "low";
export type IdeaSize = "S" | "M" | "L";
export type IdeaStatus = "proposed" | "rejected" | "picked" | "building" | "done";

export interface Idea {
  /** Stable, human-facing number. Never reused. */
  n: number;
  title: string;
  axis: ExpandAxis;
  /** Existing systems/pools this builds on — the anti-generic rule. */
  buildsOn: string[];
  /** The asymmetry or missing piece it fills. */
  gap: string;
  size: IdeaSize;
  fit: IdeaFit;
  /** One line on why it fits (or strains) the pillars. */
  fitNote: string;
  /** How the user will see/reach it — reachability is checked in the fit critique. */
  playerFacing: string;
  status: IdeaStatus;
  createdAt: number;
  updatedAt: number;
  note?: string;
}

export interface Ledger {
  version: 1;
  map: SystemsMap | null;
  pillars: string[];
  ideas: Idea[];
}

export function emptyLedger(): Ledger {
  return { version: 1, map: null, pillars: [], ideas: [] };
}

export function loadLedger(cwd: string, rel: string): Ledger {
  const file = path.join(cwd, rel);
  try {
    if (!fs.existsSync(file)) return emptyLedger();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Ledger>;
    return {
      version: 1,
      map:
        parsed.map && Array.isArray(parsed.map.systems)
          ? {
              systems: parsed.map.systems,
              interactions: Array.isArray(parsed.map.interactions) ? parsed.map.interactions : [],
              gaps: Array.isArray(parsed.map.gaps) ? parsed.map.gaps : [],
              mappedAt: typeof parsed.map.mappedAt === "number" ? parsed.map.mappedAt : 0,
            }
          : null,
      pillars: Array.isArray(parsed.pillars) ? parsed.pillars.filter((p): p is string => typeof p === "string") : [],
      ideas: Array.isArray(parsed.ideas) ? parsed.ideas.filter(isIdea) : [],
    };
  } catch {
    return emptyLedger();
  }
}

function isIdea(v: unknown): v is Idea {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.n === "number" && typeof o.title === "string" && isExpandAxis(o.axis) && typeof o.status === "string";
}

export function saveLedger(cwd: string, rel: string, ledger: Ledger): void {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

// ---------- pillars ----------

/** "fast runs; build variety | readable danger" → three pillars. */
export function parsePillars(text: string): string[] {
  return text
    .split(/\s*[;|\n]\s*/)
    .map((p) => p.trim().replace(/^[-*\d.)\s]+/, ""))
    .filter(Boolean);
}

// ---------- map ----------

export interface MapInput {
  systems: Array<{ name: string; kind: SystemKind; count?: number; summary: string; files?: string[] }>;
  interactions?: Array<{ a: string; b: string; note: string }>;
  gaps?: string[];
}

/** Replace or merge the systems map. Merge matches systems by name (case-insensitive). */
export function applyMap(ledger: Ledger, input: MapInput, merge: boolean): SystemsMap {
  const prev = merge && ledger.map ? ledger.map : { systems: [], interactions: [], gaps: [], mappedAt: 0 };
  const systems = [...prev.systems];
  for (const s of input.systems) {
    const idx = systems.findIndex((x) => x.name.toLowerCase() === s.name.trim().toLowerCase());
    const next: MappedSystem = {
      name: s.name.trim(),
      kind: s.kind === "pool" ? "pool" : "system",
      count: typeof s.count === "number" && Number.isFinite(s.count) ? Math.max(0, Math.floor(s.count)) : undefined,
      summary: (s.summary ?? "").trim(),
      files: Array.isArray(s.files) ? s.files.filter((f) => typeof f === "string") : [],
    };
    if (idx >= 0) systems[idx] = { ...systems[idx]!, ...next, files: [...new Set([...systems[idx]!.files, ...next.files])] };
    else systems.push(next);
  }
  const interactions = [...prev.interactions];
  for (const i of input.interactions ?? []) {
    if (!i.a || !i.b) continue;
    if (!interactions.some((x) => x.a === i.a && x.b === i.b && x.note === i.note)) interactions.push({ a: i.a, b: i.b, note: i.note ?? "" });
  }
  const gaps = merge ? [...new Set([...prev.gaps, ...(input.gaps ?? [])])] : [...(input.gaps ?? [])];
  ledger.map = { systems, interactions, gaps, mappedAt: Date.now() };
  return ledger.map;
}

export function formatMap(map: SystemsMap | null): string {
  if (!map || map.systems.length === 0) return "(no systems map yet — /expand map)";
  const lines: string[] = [];
  for (const s of map.systems) {
    const count = s.kind === "pool" && s.count !== undefined ? ` ×${s.count}` : "";
    lines.push(`  ${s.kind === "pool" ? "pool  " : "system"} ${s.name}${count} — ${s.summary}`);
  }
  if (map.interactions.length > 0) {
    lines.push("  interactions:");
    for (const i of map.interactions) lines.push(`    ${i.a} ↔ ${i.b}: ${i.note}`);
  }
  if (map.gaps.length > 0) {
    lines.push("  gaps:");
    for (const g of map.gaps) lines.push(`    - ${g}`);
  }
  return lines.join("\n");
}

// ---------- ideas ----------

export interface IdeaInput {
  title: string;
  axis: ExpandAxis;
  buildsOn: string[];
  gap: string;
  size: IdeaSize;
  fit: IdeaFit;
  fitNote?: string;
  playerFacing?: string;
}

function nextN(ledger: Ledger): number {
  return ledger.ideas.reduce((m, i) => Math.max(m, i.n), 0) + 1;
}

function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
}

/**
 * Add proposals. Titles matching a rejected or done idea are refused (memory);
 * titles matching an open one update it instead of duplicating.
 */
export function addIdeas(ledger: Ledger, inputs: IdeaInput[]): { added: Idea[]; refused: Array<{ title: string; why: string }> } {
  const added: Idea[] = [];
  const refused: Array<{ title: string; why: string }> = [];
  for (const raw of inputs) {
    const title = raw.title.trim();
    if (!title) continue;
    const existing = ledger.ideas.find((i) => sameTitle(i.title, title));
    if (existing && (existing.status === "rejected" || existing.status === "done")) {
      refused.push({ title, why: `already ${existing.status} as #${existing.n}` });
      continue;
    }
    if (!Array.isArray(raw.buildsOn) || raw.buildsOn.filter(Boolean).length === 0) {
      refused.push({ title, why: "does not name an existing system it builds on" });
      continue;
    }
    const now = Date.now();
    const fields = {
      title,
      axis: raw.axis,
      buildsOn: raw.buildsOn.map((b) => b.trim()).filter(Boolean),
      gap: (raw.gap ?? "").trim(),
      size: raw.size === "S" || raw.size === "L" ? raw.size : "M",
      fit: raw.fit === "high" || raw.fit === "low" ? raw.fit : "medium",
      fitNote: (raw.fitNote ?? "").trim(),
      playerFacing: (raw.playerFacing ?? "").trim(),
      updatedAt: now,
    } as const;
    if (existing) {
      Object.assign(existing, fields);
      added.push(existing);
    } else {
      const idea: Idea = { n: nextN(ledger), ...fields, status: "proposed", createdAt: now };
      ledger.ideas.push(idea);
      added.push(idea);
    }
  }
  return { added, refused };
}

export function findIdea(ledger: Ledger, ref: string | number): Idea | undefined {
  const n = typeof ref === "number" ? ref : Number.parseInt(String(ref).replace(/^#/, ""), 10);
  if (Number.isFinite(n)) return ledger.ideas.find((i) => i.n === n);
  return ledger.ideas.find((i) => sameTitle(i.title, String(ref)));
}

export function setStatus(idea: Idea, status: IdeaStatus, note?: string): void {
  idea.status = status;
  idea.updatedAt = Date.now();
  if (note !== undefined) idea.note = note;
}

const FIT_RANK: Record<IdeaFit, number> = { high: 0, medium: 1, low: 2 };
const SIZE_RANK: Record<IdeaSize, number> = { S: 0, M: 1, L: 2 };

/** Top-n open proposals by pillar fit, then size. Low fit is never auto-picked. */
export function autoPick(ledger: Ledger, n: number, from?: Idea[]): Idea[] {
  const pool = (from ?? ledger.ideas).filter((i) => i.status === "proposed" && i.fit !== "low");
  return pool.sort((a, b) => FIT_RANK[a.fit] - FIT_RANK[b.fit] || SIZE_RANK[a.size] - SIZE_RANK[b.size] || a.n - b.n).slice(0, Math.max(0, n));
}

export function formatIdea(i: Idea): string {
  const builds = i.buildsOn.length > 0 ? ` · builds on ${i.buildsOn.join(", ")}` : "";
  return `  #${i.n} [${i.axis}/${i.size}/fit ${i.fit}] ${i.title}${builds}\n      gap: ${i.gap}${i.note ? `\n      note: ${i.note}` : ""}`;
}

export function formatIdeas(ledger: Ledger, statuses: IdeaStatus[] = ["proposed", "picked", "building"]): string {
  const list = ledger.ideas.filter((i) => statuses.includes(i.status));
  if (list.length === 0) return "  (none)";
  return list.map(formatIdea).join("\n");
}

export function formatLedgerSummary(ledger: Ledger): string {
  const by = (s: IdeaStatus) => ledger.ideas.filter((i) => i.status === s).length;
  return [
    `Pillars: ${ledger.pillars.length > 0 ? ledger.pillars.join(" · ") : "(none — /expand pillars <a; b; c>)"}`,
    `Systems map: ${ledger.map ? `${ledger.map.systems.length} systems/pools, ${ledger.map.gaps.length} gaps` : "none"}`,
    `Ideas: ${by("proposed")} proposed · ${by("picked") + by("building")} in progress · ${by("done")} done · ${by("rejected")} rejected`,
  ].join("\n");
}
