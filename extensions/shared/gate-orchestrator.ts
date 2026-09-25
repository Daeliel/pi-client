/**
 * Ensures only one foundation gate sends a follow-up per agent turn.
 * Extensions call resetGateClaim() on before_agent_start, then tryClaimGate()
 * on agent_end when they need to block finish. Later gates skip if claimed.
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

/** Call from every foundation extension's before_agent_start. */
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
