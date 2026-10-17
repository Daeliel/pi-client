import type { BlueprintItem } from "../plan/blueprint";
import { formatMinutes } from "../plan/procedure";

export { formatMinutes };

const ASSUMPTION_RULE =
  "If something is unclear, do not ask the user — choose what you would recommend, add it under `## Assumptions` as `- A-nn (R-xx): …`, and continue.";

/** The brief for one item — also the nudge after a stop. Carries the plan so it survives compaction. */
export function buildBrief(opts: {
  item: BlueprintItem;
  specPath: string | null;
  summary: string;
  progress: string;
  timeNote: string;
  attempt: number;
  maxAttempts: number;
  refs: string[];
  resumed?: boolean;
  /** The item's moment and the source's own words for what it serves (from the plan). */
  context?: string;
}): string {
  const { item } = opts;
  const evidence =
    opts.specPath !== null
      ? `Evidence: ${opts.specPath} must pass (write or extend it — it must drive the real UI/API for this item).`
      : item.proves.toLowerCase() === "verify"
        ? "Evidence: the project's verify suite (lint/build/tests) must pass, including tests you add for this item."
        : "Evidence: manual — build it; the user confirms it at the end.";
  const refs = opts.refs.length ? `\nReferences for this item (attached): ${opts.refs.join(", ")}` : "";
  const input = item.fields.input
    ? `\nThe user does it by: ${item.fields.input} — build that path, and make the spec do exactly that with real input (no app functions for the user's actions).`
    : "";
  return `AUTOPILOT${opts.resumed ? " (resumed)" : ""} — next item ${item.id}${opts.attempt > 1 ? ` (attempt ${opts.attempt}/${opts.maxAttempts})` : ""} · ${opts.progress}${opts.timeNote ? ` · ${opts.timeNote}` : ""}

${item.id}: ${item.title}${input}
${evidence}${refs}${opts.context ? `\n\n${opts.context}` : ""}

Build ${item.id} now, then make its evidence pass. Do not work on other items, and do not change the [ ] marks in the blueprint — autopilot sets them from evidence. ${ASSUMPTION_RULE}

Plan (blueprint ${"order"}):
${opts.summary}`;
}

export function buildRetry(item: BlueprintItem, report: string, attempt: number, max: number): string {
  return `AUTOPILOT — ${item.id} is not proven yet (attempt ${attempt}/${max}). Fix the app or the spec so the evidence passes; do not weaken the spec to make it pass.

${report}

${ASSUMPTION_RULE}`;
}

export function buildStallNudge(item: BlueprintItem, stops: number, max: number): string {
  return `AUTOPILOT — you stopped without changing anything (${stops}/${max}). Continue with ${item.id}: ${item.title}. ${ASSUMPTION_RULE} If ${item.id} truly cannot be built here, call defer_items with a one-line reason and the run moves on.`;
}

export function buildReplan(minutesLeft: number, open: BlueprintItem[]): string {
  return `AUTOPILOT — behind schedule: ${formatMinutes(minutesLeft)} left, ${open.length} item(s) open in this run:
${open.map((i) => `  ${i.id} ${i.title.slice(0, 80)}`).join("\n")}

Re-plan: call defer_items for what will not fit (one-line reason each; the most valuable items stay). You may also reorder items in the blueprint. Then continue with the first open item.`;
}

/** Product bar, once before the run may finish: use it as a person would, then report. */
export function buildPlaytest(journeys: string[], playAvailable: boolean): string {
  const run = journeys.length
    ? `Run the @journey spec(s) (${journeys.join(", ")}) with run_scenarios, then`
    : "There is no @journey spec yet — write one (the main flow start to finish, real input only), run it, then";
  const look = playAvailable
    ? "go through the main flow yourself with `play`: every screen or stage, entering and leaving it, the controls on each. You are checking that a person can do it and that it makes sense — not playing well."
    : "check each screen or stage of the main flow can be reached and left through the UI.";
  return `AUTOPILOT — playtest before finishing (result bar: product). Every item passed its evidence; now check that a person can actually use what was built.

${run} ${look}

For anything a person could not do, could not understand, or that looks wrong — add an item to the current tier of the blueprint (\`- [ ] **R-nn** … · input: … · proves: …\`). Then stop: autopilot builds the new items, or finishes if you added none.`;
}

export function buildFinishCheck(open: BlueprintItem[]): string {
  return `Not done yet — open in this run:\n${open.map((i) => `  [${i.mark}] ${i.id} ${i.title.slice(0, 80)}`).join("\n")}\nContinue with the first one.`;
}
