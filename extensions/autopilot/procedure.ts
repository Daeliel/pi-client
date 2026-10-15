import type { BlueprintItem } from "./blueprint";

/** How to write a blueprint. Returned by write_blueprint / start_autopilot when none exists. */
export function buildBlueprintProcedure(opts: {
  blueprintPath: string;
  refsDir: string;
  budgetMinutes: number | null;
  imageSearch: boolean;
  forAutopilot: boolean;
}): string {
  const budget =
    opts.budgetMinutes !== null
      ? `\nTime budget: ${formatMinutes(opts.budgetMinutes)}. Size v1 to fit it; put the rest in v2/later.`
      : "";
  const images = opts.imageSearch
    ? "Use find_reference_images (or any image-search tool you have) for visual references; keep them with save_reference_image."
    : "If the user gave images, keep them with save_reference_image. If you have an image-search tool, use it and save results with save_reference_image.";
  return `BLUEPRINT — write the plan to ${opts.blueprintPath} before any app code.${budget}

1. Sources: the user's request; any design doc they named (expand it, never silently rewrite it — mark your additions "(added)"); reference images; for "works like <product>" requests, research the product with web_search instead of guessing.
2. Inventory: screens, entities, actions, states the thing needs.
3. Tiers: \`## v1\` = the smallest version that is a usable product. Then \`## v2\`, \`## later\`. Build vertical slices (each item usable on its own), not layers.
4. Items: one line each, small enough to build and prove in one sitting, described in checkable terms (inputs, limits, visible result).
5. Evidence: every item says what proves it — a Playwright/pytest spec file, \`verify\` (the project's tests), or \`manual\` (only the user can judge, e.g. "feels fun").
6. References: ${images} Describe each under \`## References\` with what it shows, which items it informs, and what it cannot prove (motion, feel, exact colours).
7. Call blueprint_check and fix every problem it reports.${opts.forAutopilot ? "\n8. Then call start_autopilot again." : "\n8. Then stop and tell the user the blueprint is ready (they can build it step by step or start autopilot on it)."}

Format:
\`\`\`
# Blueprint: <name>

Goal: <one line>
Stack: <languages/frameworks>

## v1 — core
- [ ] **R-01** <what it does, checkably> · proves: <name>.spec.ts
- [ ] **R-02** <…> · proves: verify

## v2
- [ ] **R-10** <…> · proves: <name>.spec.ts

## later
- [ ] **R-20** <…> · proves: manual

## References
- **REF-01** ${opts.refsDir.replace(/^\.pi\/blueprint\//, "")}/<file>.png — <what it shows> → R-01, R-02 · cannot show: <…> · source: <url or file>

## Assumptions
\`\`\`
Order inside a tier is the build order — put what other items depend on first. Leave every box as \`[ ]\`: status marks are set by autopilot from evidence, not by hand.`;
}

export function formatMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${String(m % 60).padStart(2, "0")}h` : `${m} min`;
}

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
}): string {
  const { item } = opts;
  const evidence =
    opts.specPath !== null
      ? `Evidence: ${opts.specPath} must pass (write or extend it — it must drive the real UI/API for this item).`
      : item.proves.toLowerCase() === "verify"
        ? "Evidence: the project's verify suite (lint/build/tests) must pass, including tests you add for this item."
        : "Evidence: manual — build it; the user confirms it at the end.";
  const refs = opts.refs.length ? `\nReferences for this item (attached): ${opts.refs.join(", ")}` : "";
  return `AUTOPILOT${opts.resumed ? " (resumed)" : ""} — next item ${item.id}${opts.attempt > 1 ? ` (attempt ${opts.attempt}/${opts.maxAttempts})` : ""} · ${opts.progress}${opts.timeNote ? ` · ${opts.timeNote}` : ""}

${item.id}: ${item.title}
${evidence}${refs}

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

export function buildFinishCheck(open: BlueprintItem[]): string {
  return `Not done yet — open in this run:\n${open.map((i) => `  [${i.mark}] ${i.id} ${i.title.slice(0, 80)}`).join("\n")}\nContinue with the first one.`;
}
