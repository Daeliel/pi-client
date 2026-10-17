import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanConfig } from "./config";
import { quoteInSource, readPoints, readSources, sourcesDir, textWords, type Source } from "./sources";
import { completeVision } from "../shared/model-complete";

/**
 * The second, fresh read: when the text sources together are long (over rereadAboveWords),
 * the extension sends each source — in sections a small model can hold — in requests that
 * see nothing but that text, and asks for its points again. Fresh points the plan's
 * POINTS.md lacks become findings until a point covers them. Re-run when a source changes.
 */

const SECTION_WORDS = 1200;

interface RereadRecord {
  shas: Record<string, string>;
  at: string;
  /** Verbatim quotes the fresh read found, with their source. */
  found: Array<{ source: string; quote: string }>;
}

function recordPath(cwd: string, config: PlanConfig): string {
  return path.resolve(cwd, sourcesDir(config.blueprintPath), "REREAD.json");
}

function readRecord(cwd: string, config: PlanConfig): RereadRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordPath(cwd, config), "utf8")) as RereadRecord;
  } catch {
    return null;
  }
}

function textSources(cwd: string, config: PlanConfig): Source[] {
  return readSources(cwd, config.blueprintPath).filter((s) => s.kind === "text");
}

/** Due when the sources are long and were not re-read in exactly this version. */
export function rereadDue(cwd: string, config: PlanConfig): boolean {
  const sources = textSources(cwd, config);
  if (textWords(sources) <= config.rereadAboveWords) return false;
  const rec = readRecord(cwd, config);
  if (!rec) return true;
  return sources.some((s) => rec.shas[s.id] !== s.sha);
}

/** Paragraph-aligned sections of about SECTION_WORDS words. */
export function sections(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const para of text.split(/\n\s*\n/)) {
    const n = para.split(/\s+/).filter(Boolean).length;
    if (words > 0 && words + n > SECTION_WORDS) {
      out.push(current.join("\n\n"));
      current = [];
      words = 0;
    }
    current.push(para);
    words += n;
  }
  if (current.length) out.push(current.join("\n\n"));
  return out;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** A fresh point is covered when a listed point says the same — contained either way, or mostly the same words. */
export function covered(fresh: string, listed: string[]): boolean {
  const f = norm(fresh);
  const fw = new Set(f.split(" "));
  return listed.some((q) => {
    const p = norm(q);
    if (!p) return false;
    if (p.includes(f) || f.includes(p)) return true;
    const pw = new Set(p.split(" "));
    const shared = [...fw].filter((w) => pw.has(w)).length;
    return shared / Math.min(fw.size, pw.size) >= 0.6;
  });
}

/** Run the fresh read; returns how many sections were read. Errors leave no record (it is retried). */
export async function runReread(ctx: ExtensionContext, config: PlanConfig, onStep?: (text: string) => void): Promise<{ ok: true; sections: number } | { ok: false; error: string }> {
  const model = ctx.model;
  if (!model) return { ok: false, error: "no session model" };
  const found: RereadRecord["found"] = [];
  const shas: Record<string, string> = {};
  let count = 0;
  for (const s of textSources(ctx.cwd, config)) {
    shas[s.id] = s.sha;
    const text = fs.readFileSync(path.resolve(ctx.cwd, s.file), "utf8");
    const parts = sections(text);
    for (const [i, part] of parts.entries()) {
      onStep?.(`fresh read ${s.id} ${i + 1}/${parts.length}`);
      const reply = await completeVision(
        ctx,
        model,
        "You read a document for the first time. List every statement in it that someone building what it describes must honour — rules, numbers, decisions, constraints, what the user sees or does. Quote each in the document's own words.",
        `One per line, as: - "exact words from the text"\nNo commentary.\n\n---\n${part}`,
        [],
        { signal: ctx.signal, maxTokens: 1500 },
      );
      if (!reply.ok) return { ok: false, error: reply.error ?? "no answer" };
      count++;
      for (const line of reply.text.split(/\r?\n/)) {
        const quote = line.match(/^\s*[-*\d.)]*\s*["“](.+?)["”]\s*$/)?.[1]?.trim();
        // Only what is really in the source counts — a fresh read can misquote too.
        if (quote && quote.length > 8 && quoteInSource(quote, text)) found.push({ source: s.id, quote });
      }
    }
  }
  const file = recordPath(ctx.cwd, config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ shas, at: new Date().toISOString(), found }, null, 2)}\n`, "utf8");
  return { ok: true, sections: count };
}

/** What the fresh read found that POINTS.md still lacks (checkPlan reports these). */
export function rereadProblems(cwd: string, config: PlanConfig): string[] {
  if (rereadDue(cwd, config)) {
    return [`The sources are over ${config.rereadAboveWords} words: a fresh read is due — call blueprint_check to run it.`];
  }
  const rec = readRecord(cwd, config);
  if (!rec) return [];
  const listed = readPoints(cwd, config.blueprintPath)?.points.map((p) => p.quote) ?? [];
  const missing = rec.found.filter((f) => !covered(f.quote, listed));
  if (missing.length === 0) return [];
  const shown = missing.slice(0, 25).map((m) => `  ${m.source}: "${m.quote}"`).join("\n");
  return [
    `A fresh read of the sources found ${missing.length} statement(s) POINTS.md does not have — add each as a point (then serve it, or list it under Not covered):\n${shown}${missing.length > 25 ? `\n  … and ${missing.length - 25} more` : ""}`,
  ];
}
