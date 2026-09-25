/**
 * Ensures only one foundation gate sends a follow-up per agent run.
 * Extensions call resetGateClaim() on agent_start (see registerGateReset), then
 * tryClaimGate() on agent_end when they need to block finish. Later gates skip if claimed.
 *
 * Why agent_start and not before_agent_start: a gate's follow-up is queued from
 * agent_end and runs as agent.continue() — a new low-level run that fires agent_start
 * but NOT before_agent_start. Resetting only on before_agent_start left the claim set
 * for the whole chain, so after the first fix follow-up no gate ever fired again.
 *
 * Expected package.json order: verify → scenarios → browser-console → polish.
 * "polish" only claims when nothing else did (all gates green), so it is always last.
 */

export type GateLane = "verify" | "scenarios" | "browser" | "qa" | "polish" | "expand";

/**
 * pi loads every extension through its own jiti instance with moduleCache off, so a
 * module-level variable here would be a separate copy per extension and no gate would
 * ever see another gate's claim. The state must live on globalThis to be shared.
 */
const STATE_KEY = Symbol.for("pi-client.gate-orchestrator");
interface GateState {
  claimedLane: GateLane | null;
  turnSerial: number;
}
type GlobalWithGate = typeof globalThis & { [STATE_KEY]?: GateState };

function state(): GateState {
  const g = globalThis as GlobalWithGate;
  if (!g[STATE_KEY]) g[STATE_KEY] = { claimedLane: null, turnSerial: 0 };
  return g[STATE_KEY];
}

/** Reset the claim for a new run. Safe to call more than once per run. */
export function resetGateClaim(): void {
  const s = state();
  s.claimedLane = null;
  s.turnSerial += 1;
}

/** True if another gate already queued a fix follow-up this turn. */
export function isGateClaimed(): boolean {
  return state().claimedLane !== null;
}

/**
 * Claim the single follow-up slot for this turn.
 * Returns true if this lane owns the follow-up; false if another lane already claimed.
 */
export function tryClaimGate(lane: GateLane): boolean {
  const s = state();
  if (s.claimedLane !== null) return false;
  s.claimedLane = lane;
  return true;
}

/** Which lane claimed (for tests / diagnostics). */
export function getClaimedGate(): GateLane | null {
  return state().claimedLane;
}

/** Current turn serial (increments on each reset). */
export function getGateTurnSerial(): number {
  return state().turnSerial;
}

/**
 * Re-arm the single follow-up slot at the start of every low-level run, including
 * the continuation runs that deliver gate follow-ups. Call once from each gate
 * extension's factory; repeated resets within one run are harmless.
 */
export function registerGateReset(pi: { on(event: "agent_start", handler: () => void): void }): void {
  pi.on("agent_start", () => {
    resetGateClaim();
  });
}
