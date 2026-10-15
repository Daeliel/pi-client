/**
 * Time budget, decided between items (never mid-item): keep going, ask the model to
 * re-plan because the pace will not fit, or stop at this clean boundary.
 */
export type BudgetDecision = "go" | "replan" | "stop";

export function budgetDecision(opts: {
  usedMinutes: number;
  budgetMinutes: number | null;
  /** Items finished (done, blocked, manual-built) so far in this run. */
  finished: number;
  /** Items still open in this run's scope. */
  open: number;
  /** `finished` when the model was last asked to re-plan (-1 = never). */
  replanAt: number;
}): BudgetDecision {
  if (opts.budgetMinutes === null) return "go";
  const left = opts.budgetMinutes - opts.usedMinutes;
  if (left <= 0) return "stop";
  const avg = opts.finished > 0 ? opts.usedMinutes / opts.finished : 0;
  // Not even half an average item fits: starting one would mean cutting it off.
  if (avg > 0 && left < avg * 0.5) return "stop";
  // At this pace the open items will not fit — ask once per finished item, not every stop.
  if (avg > 0 && opts.open >= 2 && opts.open * avg > left * 1.1 && opts.replanAt !== opts.finished) return "replan";
  return "go";
}

/** "90", "90m", "1.5h", "2:30" → minutes; "" → no limit; anything else → "invalid". */
export function parseBudget(text: string | undefined): number | null | "invalid" {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  const hm = t.match(/^(\d+):(\d{1,2})h?$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const h = t.match(/^(\d+(?:\.\d+)?)\s*h(ours?)?$/);
  if (h) return Math.round(Number(h[1]) * 60);
  const m = t.match(/^(\d+)\s*(m|min|minutes?)?$/);
  if (m) return Number(m[1]);
  return "invalid";
}
