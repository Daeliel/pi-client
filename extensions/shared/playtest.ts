/**
 * Playtest mode: the model builds what it is asked and hands over to the user, who is the
 * only check. While it is on, the gates (verify, scenarios, browser console, QA, polish,
 * autopilot, moment checks) and their procedures stay out of the way, and their tools are
 * hidden. Helpers (anti-loop, vision relay, research, status line) keep working.
 *
 * State lives on globalThis: every extension gets its own module instance.
 */

const KEY = Symbol.for("pi-client.playtest");

interface PlaytestState {
  /** /playtest on — for the session. */
  session: boolean;
  /** /once playtest — until the user says the work is good. */
  once: boolean;
}

function state(): PlaytestState {
  const g = globalThis as typeof globalThis & { [KEY]?: PlaytestState };
  if (!g[KEY]) g[KEY] = { session: false, once: false };
  return g[KEY];
}

export function playtestOn(): boolean {
  const s = state();
  return s.session || s.once;
}

export function setPlaytestSession(on: boolean): void {
  state().session = on;
  if (!on) state().once = false;
}

export function playtestSession(): boolean {
  return state().session;
}

export function armPlaytestOnce(): void {
  state().once = true;
}

export function endPlaytestOnce(): void {
  state().once = false;
}

/**
 * Autopilot needs its gates: starting or resuming a run turns playtest off (session and once).
 * True when it was on. The playtest extension notices and saves the change on its next sync.
 */
export function turnOffPlaytest(): boolean {
  const was = playtestOn();
  setPlaytestSession(false);
  return was;
}

/** Tools that check or gate work — hidden while playtest is on. */
export const GATED_TOOLS = new Set([
  "verify",
  "scaffold_scenario",
  "define_scenarios",
  "run_scenarios",
  "capture_page_screenshot",
  "play",
  "play_save_spec",
  "confirm_visual_qa",
  "set_result_bar",
  "propose_scenario_cleanup",
  "light_change",
  "ask_user_to_verify",
  "polish_report",
  "polish_surfaces",
  "start_autopilot",
  "defer_items",
  "finish_autopilot",
  "moment_check",
]);
