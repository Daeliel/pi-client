import { compact, estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROMPT_OVERHEAD, isContextOverflow, summaryRoom } from "./room";

/**
 * Compaction that fits. Before Pi summarizes the session, check that the summary request fits
 * the model's window with room for the token estimate running short (see room.ts). When it
 * would not, summarize with Pi's own compaction and a smaller output limit — same summary,
 * a request the server accepts. When compaction fails anyway, say why in plain words.
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    const { preparation } = event;
    const input =
      [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages].reduce((n, m) => n + estimateTokens(m), 0) +
      Math.ceil((preparation.previousSummary?.length ?? 0) / 4) +
      PROMPT_OVERHEAD;
    const room = summaryRoom(model.contextWindow, model.maxTokens, input);
    if (room.kind === "fits") return;
    if (room.kind === "no-room") {
      ctx.ui.notify(
        `Compaction: ~${Math.round(input / 1000)}K tokens to summarize leave no room for a summary in ${model.id}'s ${Math.round(model.contextWindow / 1000)}K window.`,
        "warning",
      );
      return;
    }
    const sized = { ...model, maxTokens: room.maxTokens };
    try {
      // Streamed through the registry, as Pi's own requests are: it resolves the provider and
      // its sign-in at request time, for built-in, models.json and extension providers alike.
      const compaction = await compact(
        preparation,
        sized,
        undefined,
        undefined,
        event.customInstructions,
        event.signal,
        pi.getThinkingLevel(),
        (m, context, options) => ctx.modelRegistry.streamSimple(m, context, options),
      );
      ctx.ui.notify(
        `Compaction: summary limited to ${room.maxTokens.toLocaleString()} tokens (${model.id} allows ${model.maxTokens.toLocaleString()}, which would not fit the window).`,
        "info",
      );
      return { compaction };
    } catch (error) {
      if (event.signal.aborted) return { cancel: true };
      ctx.ui.notify(`Compaction with a smaller summary failed (${String(error instanceof Error ? error.message : error).slice(0, 200)}); trying Pi's own.`, "warning");
      return;
    }
  });

  pi.on("session_compact_failed", async (event, ctx) => {
    if (event.aborted || !isContextOverflow(event.errorMessage)) return;
    ctx.ui.notify(
      "Compaction failed: the session is too large for the model to summarize. Start a fresh session (/new) with a short hand-over, or switch to a model with a larger window and /compact.",
      "error",
    );
  });
}
