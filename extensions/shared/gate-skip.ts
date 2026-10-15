import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * /skip — "move on for now". Stops a gate check that is running, makes the gates forget
 * the checks pending for the current changes (so they do not fire again on the next
 * message), and tells the model those changes are unverified. The next code change arms
 * the gates again as usual — it is not a mode.
 *
 * State lives on globalThis: pi loads each extension through its own module instance,
 * and every gate has to see the same skip.
 */

export type SkipLane = "verify" | "scenarios" | "browser" | "qa";
/** Order matters: qa reads the changed files that scenarios then clears. */
export const SKIP_LANES: SkipLane[] = ["verify", "browser", "qa", "scenarios"];

const LANE_LABEL: Record<SkipLane, string> = {
  verify: "lint/build/tests",
  scenarios: "acceptance scenarios",
  browser: "browser console",
  qa: "visual QA",
};

/** Clears the lane's pending checks; returns what was dropped, or null when nothing was pending. */
export type SkipHandler = () => string | null;

interface SkipState {
  handlers: Map<SkipLane, SkipHandler>;
  controllers: Map<SkipLane, AbortController>;
  /** Per lane: the skip count at its last skip (gates compare against what they saw). */
  lastSkip: Map<SkipLane, number>;
  serial: number;
}

const KEY = Symbol.for("pi-client.gate-skip");
type GlobalWithSkip = typeof globalThis & { [KEY]?: SkipState };

function state(): SkipState {
  const g = globalThis as GlobalWithSkip;
  if (!g[KEY]) g[KEY] = { handlers: new Map(), controllers: new Map(), lastSkip: new Map(), serial: 0 };
  return g[KEY];
}

/** Each gate registers how to drop its pending checks (the newest registration wins). */
export function registerSkipHandler(lane: SkipLane, handler: SkipHandler): void {
  state().handlers.set(lane, handler);
}

/** Take at the start of a gate run; pass to skippedSince before acting on the result. */
export function skipMark(): number {
  return state().serial;
}

/** True when the lane was skipped after `mark` — the gate must not send its follow-up. */
export function skippedSince(mark: number, lane: SkipLane): boolean {
  return (state().lastSkip.get(lane) ?? -1) > mark;
}

/** The gate's own signal plus "this lane was skipped": long checks stop on /skip too. */
export function skipAwareSignal(lane: SkipLane, signal?: AbortSignal): AbortSignal {
  const s = state();
  let controller = s.controllers.get(lane);
  if (!controller || controller.signal.aborted) {
    controller = new AbortController();
    s.controllers.set(lane, controller);
  }
  return signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
}

/** Skip the given lanes now. Returns what each dropped (lanes with nothing pending are left out). */
export function requestSkip(lanes: SkipLane[]): Array<{ lane: SkipLane; what: string }> {
  const s = state();
  s.serial += 1;
  const dropped: Array<{ lane: SkipLane; what: string }> = [];
  for (const lane of SKIP_LANES.filter((l) => lanes.includes(l))) {
    s.lastSkip.set(lane, s.serial);
    s.controllers.get(lane)?.abort();
    s.controllers.delete(lane);
    const what = s.handlers.get(lane)?.();
    if (what) dropped.push({ lane, what });
  }
  return dropped;
}

export function parseSkipLanes(args: string): { lanes: SkipLane[]; unknown: string[] } {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.includes("all")) return { lanes: [...SKIP_LANES], unknown: [] };
  const alias: Record<string, SkipLane> = {
    verify: "verify",
    lint: "verify",
    tests: "verify",
    scenarios: "scenarios",
    scenario: "scenarios",
    browser: "browser",
    console: "browser",
    qa: "qa",
  };
  const lanes: SkipLane[] = [];
  const unknown: string[] = [];
  for (const w of words) {
    const lane = alias[w];
    if (!lane) unknown.push(w);
    else if (!lanes.includes(lane)) lanes.push(lane);
  }
  return { lanes, unknown };
}

/** The note the model gets on its next turn, so it never claims skipped checks passed. */
export function skipNote(dropped: Array<{ lane: SkipLane; what: string }>): string {
  return (
    `[gate skipped by the user] The user chose to move on without these checks: ` +
    dropped.map((d) => `${LANE_LABEL[d.lane]} (${d.what})`).join("; ") +
    `. Those changes are UNVERIFIED — do not say they pass or were verified, and do not re-run them unless the user asks.`
  );
}

/** Registered once, by the verify extension (pi suffixes duplicate command names). */
export function registerSkipCommand(pi: ExtensionAPI): void {
  pi.registerCommand("skip", {
    description: "Move on without the pending checks for the current changes: /skip [verify|scenarios|browser|qa] (default: all)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const { lanes, unknown } = parseSkipLanes(args);
      if (unknown.length > 0) {
        ctx.ui.notify(`Unknown gate(s): ${unknown.join(", ")}. Use: /skip [verify|scenarios|browser|qa]`, "warning");
        return;
      }
      const dropped = requestSkip(lanes);
      if (!ctx.isIdle()) ctx.abort();
      if (dropped.length === 0) {
        ctx.ui.notify("Nothing pending to skip — no gate is waiting on the current changes.", "info");
        return;
      }
      pi.sendMessage({ customType: "foundation-gate", content: skipNote(dropped), display: true }, { deliverAs: "nextTurn" });
      ctx.ui.notify(
        `Skipped: ${dropped.map((d) => `${LANE_LABEL[d.lane]} — ${d.what}`).join("; ")}.\n` +
          "The next code change runs the gates again. Run them now any time: /verify, /scenarios run.",
        "info",
      );
    },
  });
}
