import * as fs from "node:fs";
import * as path from "node:path";
import type { ScenariosConfig } from "./config";
import {
  formatCompactTidyHint,
  loadHousekeepManifest,
  saveHousekeepManifest,
  type ScenarioAudit,
} from "./housekeeping";
import type { ScenarioDefinition } from "./types";

/**
 * Model-assisted housekeeping (housekeeping.modelReview): the model looks over the
 * spec list and proposes which to scrap; the user confirms; only the extension deletes.
 */

export interface ReviewCandidate {
  testFile: string;
  id: string;
  title: string;
  lastRun?: "pass" | "fail" | "skip";
  group?: string;
  ageDays?: number;
}

export interface PendingReview {
  /** Files the model may propose (posix, relative to cwd). */
  candidates: ReviewCandidate[];
  /** Specs of the task that just passed — never proposable. */
  protectedFiles: string[];
}

function norm(cwd: string, f: string): string {
  return path.relative(cwd, path.resolve(cwd, f)).replace(/\\/g, "/").toLowerCase();
}

/** Why a review is warranted, or "" when the spec list is in good shape. */
export function reviewReason(audit: ScenarioAudit): string {
  return formatCompactTidyHint(audit).replace(/\. Run \/scenarios tidy$/, "");
}

/** Skip the automatic review when the spec set is the one the user already reviewed. */
export function alreadyReviewed(cwd: string, config: ScenariosConfig, discovered: ScenarioDefinition[]): boolean {
  const last = loadHousekeepManifest(cwd, config).lastReviewedSpecs;
  if (!last) return false;
  const seen = new Set(last);
  return discovered.every((s) => seen.has(norm(cwd, s.testFile)));
}

export function markReviewed(cwd: string, config: ScenariosConfig, discovered: ScenarioDefinition[]): void {
  const manifest = loadHousekeepManifest(cwd, config);
  manifest.lastReviewedSpecs = discovered.map((s) => norm(cwd, s.testFile)).sort();
  saveHousekeepManifest(cwd, config, manifest);
}

export function buildPendingReview(
  cwd: string,
  discovered: ScenarioDefinition[],
  audit: ScenarioAudit,
  lastRunById: Record<string, "pass" | "fail" | "skip">,
  protectedFiles: string[],
): PendingReview {
  const groupOf = new Map<string, string>();
  for (const g of audit.duplicateGroups) {
    for (const m of g.members) groupOf.set(norm(cwd, m.testFile), g.key);
  }
  const protectedSet = new Set(protectedFiles.map((f) => norm(cwd, f)));
  const now = Date.now();
  const candidates: ReviewCandidate[] = [];
  for (const s of discovered) {
    const key = norm(cwd, s.testFile);
    if (protectedSet.has(key)) continue;
    let ageDays: number | undefined;
    try {
      ageDays = Math.floor((now - fs.statSync(path.resolve(cwd, s.testFile)).mtimeMs) / 86_400_000);
    } catch {
      continue; // gone already
    }
    candidates.push({
      testFile: s.testFile.replace(/\\/g, "/"),
      id: s.id,
      title: s.title,
      lastRun: lastRunById[s.id],
      group: groupOf.get(key),
      ageDays,
    });
  }
  return { candidates, protectedFiles: [...protectedSet] };
}

export function buildReviewPrompt(
  review: PendingReview,
  reason: string,
  cap: { current: number; total: number },
): string {
  const lines = review.candidates.map((c) => {
    const bits = [
      `"${c.title}"`,
      c.lastRun ? `last run: ${c.lastRun}` : "not run this session",
      c.group ? `duplicate group: ${c.group}` : "",
      c.ageDays !== undefined ? `modified ${c.ageDays}d ago` : "",
    ].filter(Boolean);
    return `- ${c.testFile} — ${bits.join(" — ")}`;
  });
  const kept = review.protectedFiles.length
    ? `\n\nNot listed (part of the task that just passed, always kept): ${review.protectedFiles.join(", ")}`
    : "";
  return (
    `Scenario housekeeping review${reason ? ` (${reason})` : ""}. ` +
    `Briefly judge which acceptance specs are no longer worth keeping: duplicates or near-copies of another spec, ` +
    `specs for features that were removed or renamed, abandoned probes. Keep any spec that is the only proof of a user-visible flow. ` +
    `Read a spec only when its name and title are not enough to decide.\n\n` +
    `Call propose_scenario_cleanup once with the files to remove, each with a one-line reason (an empty list is fine). ` +
    `The user confirms each removal — do NOT delete, move or edit spec files yourself, and do not change code in this turn.\n\n` +
    `Spec cap: ${cap.total} spec(s) on disk, cap ${cap.current} (tidy hints and reviews start above it). ` +
    `If the specs are worth keeping because the project is broad, also pass cap { value, reason } with a cap that ` +
    `fits this project — the user confirms it too.\n\n` +
    `Specs:\n${lines.join("\n")}${kept}`
  );
}

export interface ProposedRemoval {
  file: string;
  reason: string;
}

/** Split a proposal into removals the user may confirm and ones that are not allowed. */
export function validateProposal(
  cwd: string,
  review: PendingReview,
  remove: ProposedRemoval[],
): { valid: ProposedRemoval[]; rejected: string[] } {
  const byKey = new Map(review.candidates.map((c) => [norm(cwd, c.testFile), c]));
  const protectedSet = new Set(review.protectedFiles);
  const valid: ProposedRemoval[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const r of remove) {
    const key = norm(cwd, r.file);
    if (seen.has(key)) continue;
    seen.add(key);
    const c = byKey.get(key);
    if (protectedSet.has(key)) rejected.push(`${r.file} (part of the task that just passed)`);
    else if (!c) rejected.push(`${r.file} (not in the review list)`);
    else valid.push({ file: c.testFile, reason: r.reason.trim() || "no reason given" });
  }
  return { valid, rejected };
}
