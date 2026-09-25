/**
 * Per-extension tool activation. Small models choose tools far less reliably from a
 * long list, so each extension only exposes the tools that can matter right now
 * (a release tool in a project that cannot build a release is pure noise).
 *
 * Call from the `input` event: it runs before Pi builds the prompt for the turn, and
 * setActiveTools rebuilds the tool section of the system prompt synchronously — so the
 * prompt and the tool list stay in step. Each extension only touches the tools it owns.
 */
export interface ToolActivationApi {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export function syncOwnedTools(pi: ToolActivationApi, owned: readonly string[], wanted: Iterable<string>): void {
  const want = new Set(wanted);
  const active = pi.getActiveTools();
  const next = active.filter((name) => !owned.includes(name) || want.has(name));
  for (const name of owned) {
    if (want.has(name) && !next.includes(name)) next.push(name);
  }
  if (next.length === active.length && next.every((n, i) => n === active[i])) return;
  pi.setActiveTools(next);
}
