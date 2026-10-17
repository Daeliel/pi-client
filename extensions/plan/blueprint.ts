import * as fs from "node:fs";
import * as path from "node:path";

/**
 * BLUEPRINT.md — the single source of truth. Content (items, criteria, tiers, notes) is
 * shared by the model and the user; the status marks are owned by the extension and only
 * ever set from evidence (see index.ts reconcile).
 *
 *   ## v1 — core
 *   - [ ] **R-01** Canvas: create 32/64 px, zoom, grid · proves: canvas.spec.ts
 */

/** How far a build goes: v1 only, v1 + v2, or every tier. */
export type PlanScope = "v1" | "v2" | "all";

export type Tier = "v1" | "v2" | "later";
export const TIERS: Tier[] = ["v1", "v2", "later"];

/** open, in progress, done, blocked, deferred. */
export type Mark = " " | "~" | "x" | "!" | "-";

export interface BlueprintItem {
  id: string;
  mark: Mark;
  tier: Tier | null;
  /** Text after the id up to the first " · " field. */
  title: string;
  /** `<file>.spec.ts` / `<file>.test.py` / `verify` / `manual`, or "" when missing. */
  proves: string;
  fields: Record<string, string>;
  /** 0-based line index in the file. */
  line: number;
}

export type BlueprintBar = "product" | "spec";

export interface ParsedBlueprint {
  goal: string;
  /** From the `Bar: product|spec` line; null when the line is missing. */
  bar: BlueprintBar | null;
  items: BlueprintItem[];
  /** Lines that name an id but are not a valid item line (fixable by the model). */
  malformed: Array<{ line: number; text: string; why: string }>;
  /** Point ids listed under `## Not covered` (each with its reason). */
  notCovered: Set<string>;
}

/** Ids an item serves: `· serves: S-07, S-08` (points) or `A-01` / `added` (additions). */
export function servesOf(item: BlueprintItem): string[] {
  return (item.fields.serves ?? "")
    .split(/[,\s]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
}

const ID_RE = /\*\*([A-Z]{1,4}-\d{1,4})\*\*/;
const ITEM_RE = /^(\s*[-*]\s+)\[([ xX~!\-])\]\s+(.*)$/;
const TIER_RE = /^##\s+(v1|v2|later)\b/i;
const SECTION_RE = /^##\s+/;
const FIELD_SEP = " · ";

function normMark(c: string): Mark {
  return (c === "X" ? "x" : c) as Mark;
}

function splitFields(rest: string): { title: string; fields: Record<string, string> } {
  const parts = rest.split(FIELD_SEP);
  const title = parts.shift()!.replace(ID_RE, "").trim();
  const fields: Record<string, string> = {};
  for (const p of parts) {
    const m = p.match(/^\s*([a-z][a-z-]*)\s*:\s*(.*)$/i);
    if (m) fields[m[1]!.toLowerCase()] = m[2]!.trim();
    else fields[`note${Object.keys(fields).length}`] = p.trim();
  }
  return { title, fields };
}

export function parseBlueprint(text: string): ParsedBlueprint {
  const lines = text.split(/\r?\n/);
  const items: BlueprintItem[] = [];
  const malformed: ParsedBlueprint["malformed"] = [];
  let tier: Tier | null = null;
  let goal = "";
  let bar: BlueprintBar | null = null;
  let inNotCovered = false;
  const notCovered = new Set<string>();
  lines.forEach((raw, i) => {
    const goalMatch = raw.match(/^\s*Goal\s*:\s*(.+)$/i);
    if (goalMatch && !goal) goal = goalMatch[1]!.trim();
    const barMatch = raw.match(/^\s*Bar\s*:\s*(product|spec)\b/i);
    if (barMatch && !bar) bar = barMatch[1]!.toLowerCase() as BlueprintBar;
    const tierMatch = raw.match(TIER_RE);
    if (tierMatch) {
      tier = tierMatch[1]!.toLowerCase() as Tier;
      return;
    }
    if (SECTION_RE.test(raw)) {
      tier = null;
      inNotCovered = /^##\s+not covered\b/i.test(raw);
      return;
    }
    if (inNotCovered) {
      const pid = raw.match(/^\s*[-*]\s+\*{0,2}(S-\d+)/)?.[1];
      if (pid) notCovered.add(pid);
      return;
    }
    const id = raw.match(ID_RE)?.[1];
    if (!id) return;
    const m = raw.match(ITEM_RE);
    if (!m) {
      // A REF/A line or prose mentioning an item is fine; only list lines that look like items count.
      if (/^\s*[-*]\s+\*\*[A-Z]+-\d+\*\*/.test(raw) && /^R-/.test(id)) {
        malformed.push({ line: i, text: raw.trim(), why: "item line needs a checkbox: `- [ ] **R-nn** …`" });
      }
      return;
    }
    if (!/^R-/.test(id)) return; // REF-01 / A-01 lists may use checkboxes too; only R- ids are items
    const { title, fields } = splitFields(m[3]!);
    items.push({ id, mark: normMark(m[2]!), tier, title, proves: fields.proves ?? "", fields, line: i });
  });
  return { goal, bar, items, malformed, notCovered };
}

export function readBlueprint(cwd: string, rel: string): { text: string; parsed: ParsedBlueprint } | null {
  const abs = path.resolve(cwd, rel);
  if (!fs.existsSync(abs)) return null;
  const text = fs.readFileSync(abs, "utf8").replace(/^﻿/, "");
  return { text, parsed: parseBlueprint(text) };
}

export function writeBlueprint(cwd: string, rel: string, text: string): void {
  const abs = path.resolve(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

/**
 * Rewrite one item's mark (and its blocked:/deferred: note) in place. Everything else on
 * the line — the content the model and user own — is kept byte for byte.
 */
export function setMark(text: string, id: string, mark: Mark, note?: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.match(ID_RE)?.[1] !== id) continue;
    const m = raw.match(ITEM_RE);
    if (!m) continue;
    const parts = m[3]!.split(FIELD_SEP).filter((p) => !/^\s*(blocked|deferred)\s*:/i.test(p));
    if (mark === "!" && note) parts.push(`blocked: ${oneLine(note)}`);
    if (mark === "-" && note) parts.push(`deferred: ${oneLine(note)}`);
    lines[i] = `${m[1]}[${mark}] ${parts.join(FIELD_SEP)}`;
    return lines.join(eol);
  }
  return text;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Items the given scope covers. */
export function inScope(items: BlueprintItem[], scope: PlanScope): BlueprintItem[] {
  const tiers: Tier[] = scope === "v1" ? ["v1"] : scope === "v2" ? ["v1", "v2"] : TIERS;
  return items.filter((i) => i.tier !== null && tiers.includes(i.tier));
}

/** The item to work on next: one already in progress, else the first open one in blueprint order. */
export function nextItem(items: BlueprintItem[], scope: PlanScope): BlueprintItem | undefined {
  const scoped = inScope(items, scope);
  return scoped.find((i) => i.mark === "~") ?? scoped.find((i) => i.mark === " ");
}

const PROVES_RE = /^(verify|manual|[\w./\\-]+\.(spec\.ts|test\.py|test\.ts))$/i;

/** Shape problems the model must fix before a run (returned by blueprint_check). */
export function checkBlueprint(parsed: ParsedBlueprint): string[] {
  const problems: string[] = [];
  if (!parsed.goal) problems.push("No `Goal: …` line — state in one line what is being built.");
  if (!parsed.bar) {
    problems.push("No `Bar: product` or `Bar: spec` line — product: a person can use everything (gaps filled, each item says how the user does it); spec: only what is written.");
  }
  const v1 = parsed.items.filter((i) => i.tier === "v1");
  if (parsed.items.length === 0) problems.push("No items. Items look like `- [ ] **R-01** What it does, checkably · proves: thing.spec.ts` under `## v1`.");
  else if (v1.length === 0) problems.push("`## v1` has no items — v1 is the smallest usable version and is built first.");
  const seen = new Set<string>();
  for (const it of parsed.items) {
    if (seen.has(it.id)) problems.push(`${it.id}: duplicate id — every item needs its own id.`);
    seen.add(it.id);
    if (it.tier === null) problems.push(`${it.id}: not under a \`## v1\` / \`## v2\` / \`## later\` heading.`);
    if (!it.proves) problems.push(`${it.id}: missing \`· proves: <spec>.spec.ts | verify | manual\`.`);
    else if (!PROVES_RE.test(it.proves)) problems.push(`${it.id}: proves "${it.proves}" — use a spec file name, \`verify\`, or \`manual\`.`);
    if (parsed.bar === "product" && it.proves && !/^(verify|manual)$/i.test(it.proves) && !it.fields.input) {
      problems.push(`${it.id}: product bar — say how the user does it: \`· input: <e.g. click a node on the map>\`. Its spec must do exactly that.`);
    }
    if (servesOf(it).length === 0) {
      problems.push(`${it.id}: say what it serves — \`· serves: S-07\` (the source points it builds) or an addition from \`## Reading\` (\`· serves: A-01\`; \`added\` is accepted too).`);
    }
    if (it.title.replace(/[^a-z0-9]/gi, "").length < 12) {
      problems.push(`${it.id}: "${it.title}" is too thin — say what it does in checkable terms (inputs, limits, visible result).`);
    }
  }
  for (const m of parsed.malformed) problems.push(`line ${m.line + 1}: ${m.why} — \`${m.text.slice(0, 80)}\``);
  return problems;
}

const MARK_LABEL: Record<Mark, string> = { " ": "open", "~": "in progress", x: "done", "!": "blocked", "-": "deferred" };

export function markLabel(mark: Mark): string {
  return MARK_LABEL[mark];
}

/** Compact status: "v1 3/8 done (1 blocked) · v2 0/4". */
export function tierCounts(items: BlueprintItem[]): string {
  return TIERS.map((t) => {
    const its = items.filter((i) => i.tier === t);
    if (its.length === 0) return "";
    const done = its.filter((i) => i.mark === "x").length;
    const blocked = its.filter((i) => i.mark === "!").length;
    const deferred = its.filter((i) => i.mark === "-").length;
    const extra = [blocked ? `${blocked} blocked` : "", deferred ? `${deferred} deferred` : ""].filter(Boolean).join(", ");
    return `${t} ${done}/${its.length} done${extra ? ` (${extra})` : ""}`;
  })
    .filter(Boolean)
    .join(" · ");
}

/** Ids + marks + short titles — re-sent each brief so the plan survives compaction. */
export function formatSummary(items: BlueprintItem[], scope: PlanScope): string {
  return inScope(items, scope)
    .map((i) => `  [${i.mark}] ${i.id} ${i.title.slice(0, 70)}${i.fields.blocked ? ` — blocked: ${i.fields.blocked}` : ""}`)
    .join("\n");
}
