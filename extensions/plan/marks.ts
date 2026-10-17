import * as fs from "node:fs";
import * as path from "node:path";
import { readBlueprint, setMark, writeBlueprint, type BlueprintItem } from "./blueprint";
import { loadConfig } from "./config";

/**
 * Marks follow evidence outside autopilot too: when an item's spec passes in a normal gate
 * run its box is ticked; when it fails again, the tick goes. Items proven by `verify` are
 * ticked only after the model said it was building them (plan_item) and the suite passed —
 * a green suite alone does not mean an item was built. During an autopilot run autopilot
 * owns the marks, so nothing here touches them.
 */

const ACTIVE_KEY = Symbol.for("pi-client.plan-active-items");
type GlobalWithActive = typeof globalThis & { [ACTIVE_KEY]?: Set<string> };

function active(): Set<string> {
  const g = globalThis as GlobalWithActive;
  if (!g[ACTIVE_KEY]) g[ACTIVE_KEY] = new Set();
  return g[ACTIVE_KEY];
}

/** The model is building this item now (plan_item). */
export function markActive(id: string): void {
  active().add(id);
}

/** Items the model said it is building now. */
export function activeItems(): string[] {
  return [...active()];
}

export function clearActive(): void {
  active().clear();
}

export function autopilotRunning(cwd: string, blueprintPath: string): boolean {
  try {
    const run = JSON.parse(fs.readFileSync(path.resolve(cwd, path.dirname(blueprintPath), "run.json"), "utf8")) as { status?: string };
    return run.status === "running";
  } catch {
    return false;
  }
}

function specKey(file: string): string {
  return path.posix.basename(file.replace(/\\/g, "/")).toLowerCase();
}

function apply(cwd: string, change: (item: BlueprintItem) => " " | "x" | null): string[] {
  const config = loadConfig(cwd);
  if (!config.enabled || autopilotRunning(cwd, config.blueprintPath)) return [];
  const bp = readBlueprint(cwd, config.blueprintPath);
  if (!bp) return [];
  let text = bp.text;
  const changed: string[] = [];
  for (const item of bp.parsed.items) {
    if (item.mark === "!" || item.mark === "-") continue; // blocked / deferred: a decision, not evidence
    const next = change(item);
    if (next && next !== item.mark) {
      text = setMark(text, item.id, next);
      changed.push(`${item.id} ${next === "x" ? "done" : "reopened"}`);
    }
  }
  if (changed.length) writeBlueprint(cwd, config.blueprintPath, text);
  return changed;
}

/** After a scenarios run: items whose spec passed are done, whose spec failed are open. */
export function markFromSpecResults(cwd: string, checks: Array<{ testFile: string; status: string }>): string[] {
  const byFile = new Map(checks.map((c) => [specKey(c.testFile), c.status]));
  return apply(cwd, (item) => {
    if (!item.proves || /^(verify|manual)$/i.test(item.proves)) return null;
    const status = byFile.get(specKey(item.proves));
    return status === "pass" ? "x" : status === "fail" ? " " : null;
  });
}

/** After a passing verify gate: the verify-proven items the model was building are done. */
export function markFromVerifyPass(cwd: string): string[] {
  const building = active();
  if (building.size === 0) return [];
  const changed = apply(cwd, (item) => (building.has(item.id) && /^verify$/i.test(item.proves) ? "x" : null));
  for (const c of changed) building.delete(c.split(" ")[0]!);
  return changed;
}
