/** Tools that count as progress (not approach-churn). */
export { isEditTool } from "../shared/edit-tools";

export type RecoveryKind = "repeat" | "thinking" | "stuck" | "truncation" | "ghost";

/**
 * Last allowed recovery for approach-thrash (not truncation / ghost XML)
 * becomes user-help instead of "try one more different action".
 */
export function lastRecoveryUsesUserHelp(
  kind: RecoveryKind | undefined,
  recoveriesAfterThis: number,
  maxRecoveries: number,
): boolean {
  if (!kind) return false;
  if (kind === "truncation" || kind === "ghost") return false;
  return recoveriesAfterThis >= maxRecoveries;
}

/**
 * "Looks stuck" with no edits — notify only; do not enter user-help. Many reads that find
 * things are exploration; thrash is calls that keep coming back empty or failing. The
 * unique-call threshold is a high backstop for a run that reads forever without acting.
 */
export function shouldNotifyApproachChurn(opts: {
  uniqueFingerprints: number;
  fruitlessCalls: number;
  editCount: number;
  /** Backstop: distinct calls. 0 disables. */
  threshold: number;
  /** Fruitless calls. 0 disables. */
  fruitlessThreshold: number;
  alreadyNotified: boolean;
  userHelpActive: boolean;
}): boolean {
  if (opts.alreadyNotified || opts.userHelpActive) return false;
  if (opts.editCount > 0) return false;
  if (opts.fruitlessThreshold > 0 && opts.fruitlessCalls >= opts.fruitlessThreshold) return true;
  return opts.threshold > 0 && opts.uniqueFingerprints >= opts.threshold;
}

/** A call that found nothing: an error (failed command, grep without a match) or empty output. */
export function isFruitlessResult(isError: boolean, content: unknown): boolean {
  if (isError) return true;
  // A screenshot is a result even with no text beside it.
  if (Array.isArray(content) && content.some((c) => c && typeof c === "object" && (c as { type?: string }).type === "image")) return false;
  const text = Array.isArray(content)
    ? content
        .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
        .join("")
        .trim()
    : "";
  return text === "" || text === "(no output)";
}

export const USER_HELP_PROCEDURE = `## Anti-loop: user-help

The user is jumping in because you were spinning. You are not allowed to start a new investigation.

1. Stop. No new greps, reads, or theories unless the user just gave you a fact to apply.
2. If they already told you something (where it broke, what they clicked, a console error), do ONE action on that fact only.
3. If you still cannot act, ask 1–3 short questions about things you cannot observe: where it happened, exact click/path, expected vs actual, paste console, screenshot, open DevTools. Then wait.
4. Do not narrate a new plan. Do not retry a previous approach.`.trim();

export const USER_HELP_STEER = `ANTI-LOOP: Last recovery — stop trying new theories.

Ask the user 1–3 concrete questions about things you cannot observe (where the bug happened, what they clicked, console output, expected vs actual). Then wait. If they already answered, do ONE action on that fact. No more investigation.`;

/** Default prompt when the user types /stuck with no extra text. */
export const USER_HELP_PROMPT = `USER-HELP: I am here to help. Stop investigating.

Ask me 1–3 short questions about things you cannot observe (where it happened, what I clicked, console errors, expected vs actual). Then wait. Do not start a new theory.`;

/** Appended to what the user typed when they jump in on a thrashing run. */
export function withUserHelpNote(text: string): string {
  return `${text.trim()}

(ANTI-LOOP user-help: you were going in circles. Use what I just said for ONE concrete action, or ask me 1–3 short questions about what you cannot observe — where it happened, what I clicked, console output. No new investigation.)`;
}
