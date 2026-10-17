import * as fs from "node:fs";
import * as path from "node:path";
import { isCodePath } from "../shared/edit-tools";

/**
 * Light changes: a small, low-risk edit (a colour, a label, one condition) skips the
 * scenario run. The model judges "small" when it calls light_change; the extension checks
 * the size it measures against the user's chosen setting. Verify's quick checks still run.
 */

export type LightLevel = "strict" | "standard" | "loose" | "off";

export function isLightLevel(value: unknown): value is LightLevel {
  return value === "strict" || value === "standard" || value === "loose" || value === "off";
}

export interface LightLimits {
  lines: number;
  files: number;
  newFiles: number;
}

export const LIGHT_LIMITS: Record<Exclude<LightLevel, "off">, LightLimits> = {
  strict: { lines: 10, files: 1, newFiles: 0 },
  standard: { lines: 30, files: 3, newFiles: 0 },
  loose: { lines: 100, files: 6, newFiles: 1 },
};

export function describeLimits(level: LightLevel): string {
  if (level === "off") return "off — every code change runs the specs";
  const l = LIGHT_LIMITS[level];
  const newFiles = l.newFiles === 0 ? "no new files" : `at most ${l.newFiles} new file${l.newFiles > 1 ? "s" : ""}`;
  return `up to ${l.lines} changed lines, ${l.files === 1 ? "1 file" : `up to ${l.files} files`}, ${newFiles}`;
}

export interface ChangeSize {
  lines: number;
  files: number;
  newFiles: number;
}

function lines(text: string): string[] {
  const out = text.split(/\r?\n/).map((l) => l.trimEnd());
  if (out.at(-1) === "") out.pop();
  return out;
}

/** Changed lines between two versions: the larger of lines added and lines removed (order-blind). */
export function changedLines(before: string | null, after: string | null): number {
  const a = before === null ? [] : lines(before);
  const b = after === null ? [] : lines(after);
  const counts = new Map<string, number>();
  for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of b) {
    const n = counts.get(l) ?? 0;
    if (n > 0) counts.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of counts.values()) removed += n;
  return Math.max(added, removed);
}

/** Remembers each code file as it was before its first edit, so the change can be measured. */
export class ChangeMeter {
  private before = new Map<string, string | null>();

  /** Call before an edit runs. Only the first call per file counts. */
  snapshot(cwd: string, file: string): void {
    const abs = path.resolve(cwd, file);
    if (this.before.has(abs) || !isCodePath(abs)) return;
    let text: string | null = null;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      text = null;
    }
    this.before.set(abs, text);
  }

  clear(): void {
    this.before.clear();
  }

  /** True when every changed code file has a "before" (a resumed session may not). */
  covers(cwd: string, files: Iterable<string>): boolean {
    return [...files].filter(isCodePath).every((f) => this.before.has(path.resolve(cwd, f)));
  }

  measure(): ChangeSize {
    const size: ChangeSize = { lines: 0, files: 0, newFiles: 0 };
    for (const [abs, before] of this.before) {
      let after: string | null = null;
      try {
        after = fs.readFileSync(abs, "utf8");
      } catch {
        after = null;
      }
      if (before === after) continue;
      size.files++;
      if (before === null) size.newFiles++;
      size.lines += changedLines(before, after);
    }
    return size;
  }
}

export function formatSize(size: ChangeSize): string {
  const extra = size.newFiles ? `, ${size.newFiles} new` : "";
  return `${size.lines} changed line${size.lines === 1 ? "" : "s"} in ${size.files} file${size.files === 1 ? "" : "s"}${extra}`;
}

/** Null when the change fits the level; otherwise what is over. */
export function overLimit(level: LightLevel, size: ChangeSize): string | null {
  if (level === "off") return "light changes are off for this project";
  const l = LIGHT_LIMITS[level];
  const over: string[] = [];
  if (size.lines > l.lines) over.push(`${size.lines} lines (max ${l.lines})`);
  if (size.files > l.files) over.push(`${size.files} files (max ${l.files})`);
  if (size.newFiles > l.newFiles) over.push(`${size.newFiles} new file(s) (max ${l.newFiles})`);
  return over.length ? over.join(", ") : null;
}

export function formatHowToCheck(steps: string[]): string {
  return `Not verified by specs — how to check:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
}
