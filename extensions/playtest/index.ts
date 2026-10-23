import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractEditPath, isEditTool } from "../shared/edit-tools";
import { tryClaimGate } from "../shared/gate-orchestrator";
import { registerOnceModifier } from "../shared/once";
import { armPlaytestOnce, endPlaytestOnce, GATED_TOOLS, playtestOn, playtestSession, setPlaytestSession } from "../shared/playtest";
import { readBlueprint, setMark, writeBlueprint } from "../plan/blueprint";
import { loadConfig as loadPlanConfig } from "../plan/config";
import { activeItems, autopilotRunning, clearActive } from "../plan/marks";

/**
 * Playtest mode: no gates, no tests. The model builds what it is asked, then hands over —
 * what it did, how to try it, what to watch — and the user's verdict settles it:
 * Good = completed (plan items ticked, "tested by user"); Not right = their note is the next task.
 */

const STATE_TYPE = "pi-client-playtest";

const PROCEDURE =
  "## Playtest mode\n\n" +
  "The user tests your work themselves — there are no checks, specs or test runs. Build what they ask; " +
  "do not write tests or specs unless they ask for them.\n" +
  "When it is built, call hand_over: what you did (plain words, what the user will notice), how to try it " +
  "(where to go, what to do, step by step), and what to watch (what you are unsure of, where it might break). Then stop.\n" +
  "If the user says it is broken or not right, fix exactly that, then hand_over again.\n" +
  "How something looks or feels is the user's call: do not tune it yourself through rounds of screenshots. " +
  "Make your best version once, then hand_over and put what you are unsure of (too faint? too strong? wrong colour?) in watchFor.\n" +
  "Do not run the test suite or Playwright (npm test, npx playwright, throwaway debug specs) — the user tests it. " +
  "To find a bug, read the code, or add a log line and ask the user what they see.";

/** Shell commands that run tests or Playwright — the user is the test in playtest mode. */
export const TEST_COMMAND =
  /\b(?:npx|pnpm|yarn|bunx?)\s+(?:exec\s+)?playwright\b|\bplaywright\s+test\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnpm\s+t\b|\b(?:vitest|jest|pytest|mocha)\b|\bnode\s+--test\b|\b(?:go|cargo|dotnet)\s+test\b/i;

/** The user asks for tests in this request: then they may run. */
export const TEST_REQUEST =
  /\b(?:run|write|add|check|use)\b[^.\n]{0,30}\b(?:tests?|specs?|suite|playwright)\b|\bplaywright\b|\bnpm\s+test\b/i;

export interface Handover {
  did: string[];
  tryIt: string[];
  watchFor: string[];
}

export function formatHandover(h: Handover): string {
  const list = (items: string[], numbered = false) => items.map((s, i) => `${numbered ? `${i + 1}.` : "-"} ${s}`).join("\n");
  const parts = [`What I did:\n${list(h.did)}`, `Try it:\n${list(h.tryIt, true)}`];
  if (h.watchFor.length) parts.push(`Watch for:\n${list(h.watchFor)}`);
  return parts.join("\n\n");
}

export const GOOD = "Good — it's done";
export const NOT_RIGHT = "Not right — I'll say what";

export default function (pi: ExtensionAPI) {
  let handover: Handover | null = null;
  /** Something was edited this run (a run with nothing built needs no handover). */
  let edited = false;
  /** The handover reminder was sent this run. */
  let reminded = false;
  /** The user's request asked for tests: then the test commands are not blocked. */
  let testsAllowed = false;
  /** Gated tools taken out of the active list, to give back when playtest ends. */
  const hidden = new Set<string>();

  function syncTools() {
    const active = pi.getActiveTools();
    if (playtestOn()) {
      const keep = active.filter((t) => !GATED_TOOLS.has(t));
      for (const t of active) if (GATED_TOOLS.has(t)) hidden.add(t);
      if (!keep.includes("hand_over")) keep.push("hand_over");
      if (keep.length !== active.length || !active.includes("hand_over")) pi.setActiveTools(keep);
      return;
    }
    // Owners re-sync their own tools on their next input; verify's tool has no sync, so give everything back.
    const next = active.filter((t) => t !== "hand_over");
    for (const t of hidden) if (!next.includes(t)) next.push(t);
    hidden.clear();
    if (next.length !== active.length || next.some((t, i) => t !== active[i])) pi.setActiveTools(next);
  }

  function persist() {
    pi.appendEntry(STATE_TYPE, { session: playtestSession() });
  }

  registerOnceModifier({
    name: "playtest",
    description: "build it, then hand over for you to test — no checks or specs",
    owner: "playtest",
    apply: () => armPlaytestOnce(),
  });

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) {
        setPlaytestSession(Boolean((entry.data as { session?: boolean } | undefined)?.session));
      }
    }
    syncTools();
  });

  pi.on("input", async (event) => {
    // The user's own words decide; follow-ups from the harness keep the current answer,
    // except the "not right" note, which carries what the user typed.
    if (event.source !== "extension" || event.text.startsWith("I tested it")) testsAllowed = TEST_REQUEST.test(event.text);
    syncTools();
  });

  // The shell is not gated like the tools are: running the suite or a debug spec is checking.
  pi.on("tool_call", async (event) => {
    if (!playtestOn() || testsAllowed) return;
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const command = "input" in event && typeof (event.input as { command?: unknown }).command === "string" ? (event.input as { command: string }).command : "";
    if (!TEST_COMMAND.test(command)) return;
    return {
      block: true,
      reason:
        "PLAYTEST MODE: no test runs — the user is the test. Read the code and fix it, or add a log line and ask the user " +
        "what they see, then hand_over. (If the user asks for tests, they may run.)",
    };
  });

  pi.on("before_agent_start", async (event) => {
    edited = false;
    reminded = false;
    if (!playtestOn()) return;
    syncTools();
    return { systemPrompt: `${event.systemPrompt}\n\n${PROCEDURE}` };
  });

  pi.on("tool_result", async (event) => {
    if (playtestOn() && isEditTool(event.toolName) && !event.isError && extractEditPath(event.input)) edited = true;
  });

  // Built something but did not hand over: ask once.
  pi.on("agent_end", async (_event, ctx) => {
    if (!playtestOn() || handover || !edited || reminded || ctx.signal?.aborted) return;
    if (!tryClaimGate("playtest")) return;
    reminded = true;
    pi.sendUserMessage(
      "Playtest mode: you changed the code but did not hand over. Call hand_over now — what you did, how to try it, what to watch — then stop.",
      { deliverAs: "followUp" },
    );
  });

  // Everything is over: the user decides.
  pi.on("agent_settled", async (_event, ctx) => {
    if (!handover) return;
    const h = handover;
    handover = null;
    if (!ctx.hasUI) return;
    const choice = await ctx.ui.select(`Ready to test\n\n${formatHandover(h)}`, [GOOD, NOT_RIGHT]);
    if (choice === GOOD) {
      const ticked = tickPlanItems(ctx);
      endPlaytestOnce();
      syncTools();
      // Written now, right after the handover: as a nextTurn message it would land after the
      // user's next request and read as if that had been tested.
      pi.sendMessage({
        customType: STATE_TYPE,
        content: `The user tested it and says it is good — completed (tested by user)${ticked.length ? `; plan: ${ticked.join(", ")} done` : ""}.`,
        display: true,
      });
      ctx.ui.notify(`Completed — tested by you.${ticked.length ? ` Plan: ${ticked.join(", ")} done.` : ""}`, "info");
      return;
    }
    if (choice === NOT_RIGHT) {
      const note = (await ctx.ui.input("What is not right?", "e.g. it doesn't start; the button does nothing; too slow"))?.trim();
      if (!note) return;
      pi.sendUserMessage(`I tested it — not right yet: ${note}\n\nFix that, then hand_over again.`);
    }
  });

  function tickPlanItems(ctx: ExtensionContext): string[] {
    const ids = activeItems();
    if (ids.length === 0) return [];
    const config = loadPlanConfig(ctx.cwd);
    const bp = readBlueprint(ctx.cwd, config.blueprintPath);
    if (!bp) return [];
    let text = bp.text;
    const done: string[] = [];
    for (const id of ids) {
      if (!bp.parsed.items.some((i) => i.id === id)) continue;
      text = setMark(text, id, "x", "tested by user");
      done.push(id);
    }
    if (done.length) writeBlueprint(ctx.cwd, config.blueprintPath, text);
    clearActive();
    return done;
  }

  pi.registerTool({
    name: "hand_over",
    label: "Hand Over",
    description:
      "Playtest mode: hand the finished work to the user to test. Say what you did, how to try it and what to watch. Then stop — the user's verdict comes back to you.",
    promptSnippet: "Hand finished work to the user to test",
    parameters: Type.Object({
      did: Type.Array(Type.String(), { description: "What you did, in plain words — what the user will notice.", minItems: 1 }),
      tryIt: Type.Array(Type.String(), { description: "How to try it: where to go and what to do, step by step.", minItems: 1 }),
      watchFor: Type.Array(Type.String(), { description: "What to pay attention to: what you are unsure of, where it might break." }),
    }),
    async execute(_id, params) {
      handover = { did: params.did, tryIt: params.tryIt, watchFor: params.watchFor ?? [] };
      return {
        content: [{ type: "text", text: "Handed over. Stop now: end your turn with a one-line note — the user is testing it." }],
        details: {},
      };
    },
  });

  pi.registerCommand("playtest", {
    description: "Playtest mode — the model builds and hands over, you test; no gates or specs. on | off",
    handler: async (args, ctx) => {
      const wanted = args.trim().toLowerCase();
      if (wanted !== "on" && wanted !== "off") {
        ctx.ui.notify(
          `Playtest mode: ${playtestOn() ? "on" : "off"}.\n/playtest on|off — for this session. /once playtest <prompt> — for one request, until you say it's good.`,
          "info",
        );
        return;
      }
      if (wanted === "on" && autopilotRunning(ctx.cwd, loadPlanConfig(ctx.cwd).blueprintPath)) {
        ctx.ui.notify("Autopilot is running — /autopilot pause first; playtest mode has no gates for it to work with.", "warning");
        return;
      }
      setPlaytestSession(wanted === "on");
      persist();
      syncTools();
      ctx.ui.notify(
        wanted === "on"
          ? "Playtest mode on — no gates or specs. The model hands over when done; your Good or Not right settles it."
          : "Playtest mode off — the gates are back.",
        "info",
      );
    },
  });
}
