import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig as loadResearchConfig, resolveApiKey } from "../research/config";
import { syncOwnedTools, type ToolActivationApi } from "../shared/tool-activation";
import { readBlueprint } from "./blueprint";
import { loadConfig } from "./config";

/**
 * Shared between the plan and autopilot extensions (each has its own module instance, so
 * the state lives on globalThis): whether a blueprint is being written right now.
 */
const KEY = Symbol.for("pi-client.plan-state");
type GlobalWithPlan = typeof globalThis & { [KEY]?: { planning: boolean } };

function state(): { planning: boolean } {
  const g = globalThis as GlobalWithPlan;
  if (!g[KEY]) g[KEY] = { planning: false };
  return g[KEY];
}

export function setPlanning(on: boolean): void {
  state().planning = on;
}

export function isPlanning(): boolean {
  return state().planning;
}

export const PLAN_TOOLS = [
  "write_blueprint",
  "add_source",
  "blueprint_check",
  "save_reference_image",
  "find_reference_images",
  "plan_item",
  "propose_plan",
  "moment_check",
];

/** propose_plan is offered at most once per session. */
const OFFERED = Symbol.for("pi-client.plan-offered");
type GlobalWithOffer = typeof globalThis & { [OFFERED]?: boolean };

export function setOffered(on: boolean): void {
  (globalThis as GlobalWithOffer)[OFFERED] = on;
}

function offered(): boolean {
  return (globalThis as GlobalWithOffer)[OFFERED] === true;
}

export function hasImageSearch(cwd: string): boolean {
  try {
    return Boolean(resolveApiKey(loadResearchConfig(cwd)));
  } catch {
    return false;
  }
}

/**
 * Plan tools the model should see now: write_blueprint always; checking and references
 * while a blueprint is being written or one exists.
 */
export function syncPlanTools(pi: ToolActivationApi, ctx: ExtensionContext): void {
  const config = loadConfig(ctx.cwd);
  if (!config.enabled) {
    syncOwnedTools(pi, PLAN_TOOLS, []);
    return;
  }
  const wanted = ["write_blueprint"];
  const hasPlan = Boolean(readBlueprint(ctx.cwd, config.blueprintPath));
  if (isPlanning() || hasPlan) {
    wanted.push("add_source", "blueprint_check", "save_reference_image");
    if (hasImageSearch(ctx.cwd)) wanted.push("find_reference_images");
  }
  if (hasPlan) wanted.push("plan_item", "moment_check");
  else if (!isPlanning() && !config.offerDeclined && !offered()) wanted.push("propose_plan");
  syncOwnedTools(pi, PLAN_TOOLS, wanted);
}
