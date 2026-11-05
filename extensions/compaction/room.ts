/**
 * Room for a compaction summary. The summary request sends most of the session and asks for
 * up to the model's output limit back; the provider trims that limit to the window minus an
 * *estimate* of the input and a fixed 4K margin. The estimate (characters / 4) runs short of
 * real tokenizers — 2.5% short on a 426K-token request in practice — so on a big window with
 * a big output limit the trimmed request still overflows, and compaction can never succeed.
 *
 * The fix is model-agnostic: assume the input is up to ESTIMATE_SLACK larger than estimated,
 * and ask for no more output than then still fits.
 */

/** How much larger than the estimate the real input may be. */
export const ESTIMATE_SLACK = 0.1;
/** The provider's own margin when it trims the output limit to the window. */
const PROVIDER_MARGIN = 4096;
/** The summary prompt and its wrapping around the conversation text. */
export const PROMPT_OVERHEAD = 2048;
/** Below this the summary itself would be cut short: not worth trying. */
export const MIN_SUMMARY_OUTPUT = 2048;

export type SummaryRoom =
  | { kind: "fits" }
  | { kind: "limit"; maxTokens: number }
  | { kind: "no-room" };

/**
 * Whether a summary request with `inputTokens` (estimated) fits `contextWindow` when it asks
 * for `maxTokens` back — and if not, the output limit that does fit.
 */
export function summaryRoom(contextWindow: number, maxTokens: number, inputTokens: number): SummaryRoom {
  if (!(contextWindow > 0) || !(maxTokens > 0)) return { kind: "fits" };
  const room = Math.floor(contextWindow - inputTokens * (1 + ESTIMATE_SLACK) - PROVIDER_MARGIN);
  if (maxTokens <= room) return { kind: "fits" };
  if (room < MIN_SUMMARY_OUTPUT) return { kind: "no-room" };
  return { kind: "limit", maxTokens: room };
}

const OVERFLOW = /context length|context window|maximum context|too many tokens|prompt is too long|exceeds? .*(?:limit|length|tokens)|reduce the (?:number of tokens|length)/i;

/** A provider error that says the request did not fit the model's context. */
export function isContextOverflow(message: string | undefined): boolean {
  return !!message && OVERFLOW.test(message);
}
