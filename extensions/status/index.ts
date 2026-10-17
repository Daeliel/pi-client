import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, foundationConfigPaths } from "../shared/config-paths";
import { readJsonConfig } from "../shared/json-config";
import { extractEditPath, isEditTool } from "../shared/edit-tools";
import { syncOwnedTools } from "../shared/tool-activation";
import { playtestOn } from "../shared/playtest";
import { readBlueprint, TIERS } from "../plan/blueprint";
import { loadConfig as loadPlanConfig } from "../plan/config";
import { activeItems, autopilotRunning } from "../plan/marks";

/**
 * One line above the editor while the agent works:
 *   Implementing colour change · editing (2 files) · ~50%
 * The step comes from the model (status tool), the phase from what the agent is doing,
 * the percentage from the plan when one is being built (no ~), else the model's estimate (~).
 */

const WIDGET = "pi-client-status";
/** Remind the model after this many tool calls in a run without a status update (then every NUDGE_EVERY). */
const FIRST_NUDGE = 2;
const NUDGE_EVERY = 10;
const NUDGE =
  "[status line] The user's status line shows no step or progress. Call status with your current step (2-5 words) " +
  "and percent (how much of this task is done, 0-100) — once now, then only when the step changes.";
const TOOLS = ["status"];

interface StatusConfig {
  enabled: boolean;
}

function loadConfig(cwd: string): StatusConfig {
  let cfg: StatusConfig = { enabled: true };
  for (const file of foundationConfigPaths(cwd, "status.config.json")) {
    const o = readJsonConfig<StatusConfig>(file);
    if (o) cfg = { ...cfg, ...o };
  }
  return cfg;
}

function persistEnabled(enabled: boolean): string {
  const file = path.join(os.homedir(), CONFIG_DIR_NAME, "status.config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readJsonConfig<StatusConfig>(file) ?? {};
  fs.writeFileSync(file, `${JSON.stringify({ ...existing, enabled }, null, 2)}\n`, "utf8");
  return file;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "glob"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const CHECK_TOOLS = /^(run_scenarios|run_verify|verify|play|capture_page_screenshot|moment_check|blueprint_check)$/;

export function phaseOf(toolName: string, editedFiles: number): string | null {
  if (toolName === "status") return null;
  if (isEditTool(toolName)) return `editing (${editedFiles} file${editedFiles === 1 ? "" : "s"})`;
  if (READ_TOOLS.has(toolName)) return "reading";
  if (toolName === "plan_item") return "reading the plan";
  if (SHELL_TOOLS.has(toolName)) return "running commands";
  if (CHECK_TOOLS.test(toolName)) return "checking";
  if (/search|fetch|research/i.test(toolName)) return "researching";
  return toolName.replace(/_/g, " ");
}

/** Share of the tier being built that is done, or null when no plan item is being built. */
export function planPercent(cwd: string): number | null {
  const config = loadPlanConfig(cwd);
  if (!config.enabled) return null;
  if (activeItems().length === 0 && !autopilotRunning(cwd, config.blueprintPath)) return null;
  const bp = readBlueprint(cwd, config.blueprintPath);
  if (!bp) return null;
  const live = bp.parsed.items.filter((i) => i.mark !== "-");
  const tier = TIERS.find((t) => live.some((i) => i.tier === t && i.mark !== "x")) ?? TIERS.find((t) => live.some((i) => i.tier === t));
  const items = live.filter((i) => i.tier === tier);
  if (items.length === 0) return null;
  return Math.round((items.filter((i) => i.mark === "x").length / items.length) * 100);
}

export function formatStatus(parts: { mode?: string; step?: string; phase?: string; plan?: number | null; estimate?: number }): string {
  const percent = parts.plan != null ? `${parts.plan}%` : parts.estimate != null ? `~${parts.estimate}%` : "";
  return [parts.mode, parts.step, parts.phase, percent].filter(Boolean).join(" · ");
}

const GUIDE =
  "## Status line\n\n" +
  "The user sees one status line while you work. Call status with a 2-5 word step (e.g. \"Implementing colour change\") " +
  "when you start a task and when you move to a new step — not after every tool call. " +
  "Add percent: your estimate of how much of the whole task is done.";

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let step = "";
  let estimate: number | undefined;
  let phase = "";
  const edited = new Set<string>();
  /** Tool calls since the last status call (or since the run began). */
  let sinceStatus = 0;
  let statusCalled = false;

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!enabled || (!step && !phase)) {
      ctx.ui.setWidget(WIDGET, undefined);
      return;
    }
    ctx.ui.setWidget(WIDGET, [formatStatus({ mode: playtestOn() ? "playtest mode" : undefined, step, phase, plan: planPercent(ctx.cwd), estimate })], { placement: "aboveEditor" });
  }

  function reset() {
    step = "";
    estimate = undefined;
    phase = "";
    edited.clear();
    sinceStatus = 0;
    statusCalled = false;
  }

  function sync(ctx: ExtensionContext) {
    enabled = loadConfig(ctx.cwd).enabled;
    syncOwnedTools(pi, TOOLS, enabled ? TOOLS : []);
    if (!enabled) render(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    sync(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    sync(ctx);
    if (!enabled) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${GUIDE}` };
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!enabled) return;
    phase = "thinking";
    render(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return;
    if (isEditTool(event.toolName)) {
      const p = extractEditPath("input" in event ? event.input : undefined);
      if (p) edited.add(path.resolve(ctx.cwd, p));
    }
    const next = phaseOf(event.toolName, edited.size);
    if (next) {
      phase = next;
      render(ctx);
    }
  });

  // Small models skip the status tool unless reminded where they are looking: the tool result.
  pi.on("tool_result", async (event) => {
    if (!enabled || event.toolName === "status") return;
    sinceStatus++;
    if (sinceStatus < (statusCalled ? NUDGE_EVERY : FIRST_NUDGE)) return;
    sinceStatus = 0;
    statusCalled = true; // later reminders keep the longer interval
    return { content: [...event.content, { type: "text" as const, text: `\n\n${NUDGE}` }] };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!enabled) return;
    phase = "checking";
    render(ctx);
  });

  // Everything (gates, follow-ups) is over: the line goes until the next task.
  pi.on("agent_settled", async (_event, ctx) => {
    reset();
    render(ctx);
  });

  pi.registerTool({
    name: "status",
    label: "Status",
    description: "Update the one-line status the user sees: the step you are on (2-5 words) and, optionally, how far the whole task is.",
    promptSnippet: "Show the user which step you are on",
    parameters: Type.Object({
      step: Type.String({ description: "2-5 words, e.g. \"Implementing colour change\"." }),
      percent: Type.Number({ description: "Your estimate of how much of the whole task is done, 0-100." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      step = params.step.trim().slice(0, 60);
      sinceStatus = 0;
      statusCalled = true;
      if (typeof params.percent === "number" && Number.isFinite(params.percent)) {
        estimate = Math.max(0, Math.min(100, Math.round(params.percent)));
      }
      render(ctx);
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });

  pi.registerCommand("status", {
    description: "The status line above the editor — on | off",
    handler: async (args, ctx) => {
      const wanted = args.trim().toLowerCase();
      if (wanted !== "on" && wanted !== "off") {
        ctx.ui.notify(`Status line: ${enabled ? "on" : "off"}. /status on|off — saved for every project.`, "info");
        return;
      }
      const file = persistEnabled(wanted === "on");
      sync(ctx);
      render(ctx);
      ctx.ui.notify(`Status line: ${wanted} (saved to ${file}).`, "info");
    },
  });
}
