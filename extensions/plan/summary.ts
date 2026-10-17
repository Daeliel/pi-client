import { readBlueprint, TIERS, type BlueprintItem } from "./blueprint";
import type { PlanConfig } from "./config";
import { momentOf, parseExperience } from "./walkthrough";
import { readChecks } from "./moment-check";

/** "M-03 Chart 1/2" — items of a moment that are done, of all its items. */
export function momentStatus(items: BlueprintItem[], text: string): Array<{ id: string; title: string; done: number; total: number }> {
  return parseExperience(text).moments.map((m) => {
    const mine = items.filter((i) => momentOf(i) === m.id);
    return { id: m.id, title: m.title, done: mine.filter((i) => i.mark === "x").length, total: mine.length };
  });
}

/**
 * The few lines that keep the plan in view in every prompt — never the file itself.
 * Null when the project has no plan.
 */
export function planSummary(cwd: string, config: PlanConfig): string | null {
  const bp = readBlueprint(cwd, config.blueprintPath);
  if (!bp) return null;
  const { parsed, text } = bp;
  const moments = momentStatus(parsed.items, text);
  const tiered = TIERS.flatMap((t) => parsed.items.filter((i) => i.tier === t));
  const open = tiered.filter((i) => i.mark === " " || i.mark === "~").slice(0, 3);
  const lines = [
    "## Plan",
    `This project has a plan: ${config.blueprintPath}${parsed.goal ? ` — ${parsed.goal}` : ""}${parsed.bar ? ` · bar: ${parsed.bar}` : ""}.`,
  ];
  const checks = readChecks(cwd, config);
  if (moments.length) {
    lines.push(`Moments: ${moments.map((m) => `${m.id} ${m.title} ${m.done}/${m.total}${checks[m.id]?.state === "done" ? " ✓checked" : ""}`).join(" · ")}`);
  }
  lines.push(open.length ? `Next open: ${open.map((i) => `${i.id} ${i.title.slice(0, 60)}`).join(" · ")}` : "Every item is done.");
  lines.push(
    "Work from this plan: before building an item, call plan_item with its id — you get its moment and the source's own words. " +
      "Progress lives here; do not start a separate plan or task file. New work that fits no item: add an item first (serves, moment). " +
      "Boxes are ticked from evidence (its spec passing), not by hand.",
  );
  return lines.join("\n");
}
