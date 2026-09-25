/**
 * Wording shared by the fix-loop gates (verify, scenarios, browser).
 * Small models need to be told plainly when a fix did not change anything, when
 * they are on their last try, and — after the gate gives up — that the task is
 * not done, or they will report success on the next turn.
 */

/**
 * Comparable form of failure output. Only noise is normalised — timings, line:column
 * positions (they shift with every edit) and long ids/ports. Values such as
 * "expected 3 got 2" stay, so a changed result is not reported as the same failure.
 */
export function failureSignature(report: string): string {
  return report
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds?)\b/gi, "#t")
    .replace(/:\d+(:\d+)?\b/g, ":#")
    .replace(/\b\d{4,}\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-2000);
}

/** Remembers the previous failure of one gate within a task. */
export class RepeatTracker {
  private last: string | null = null;

  /** True when this failure looks the same as the previous one. */
  repeated(report: string): boolean {
    const sig = failureSignature(report);
    const same = this.last !== null && this.last === sig;
    this.last = sig;
    return same;
  }

  reset(): void {
    this.last = null;
  }
}

/** Extra lines for a gate follow-up. Empty when there is nothing to add. */
export function attemptNotes(attempt: number, max: number, repeated: boolean): string {
  const lines: string[] = [];
  if (repeated) {
    lines.push(
      "SAME FAILURE as the previous attempt — your last change did not fix it. Do not repeat that change: re-read the error below and try a different fix.",
    );
  }
  if (attempt >= max) {
    lines.push(
      `LAST ATTEMPT (${attempt}/${max}). If you cannot fix it now, stop and tell the user exactly what still fails and why — do not claim it works.`,
    );
  }
  return lines.join("\n");
}

/** Message left for the model's next turn after a gate stops its fix loop. */
export function giveUpNote(gate: string, attempts: number, evidence: string): string {
  const first = evidence.split("\n").find((l) => l.trim())?.trim().slice(0, 300) ?? "";
  return (
    `[${gate}] Still failing after ${attempts} fix attempts — the fix loop stopped, the task is NOT done.` +
    (first ? `\nLast failure: ${first}` : "") +
    "\nTell the user this plainly if they ask about the task; do not say it works."
  );
}
