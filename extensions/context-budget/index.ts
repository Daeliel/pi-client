import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { estimateTokens, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyBudget, budgetFor, SLACK, type Msg } from "./budget";
import { compactionFor, reconcileCompaction, type CompactionOverride } from "./settings";

/**
 * Keeps every request inside the model's window (see budget.ts), and gives small windows
 * compaction settings that can work (see settings.ts).
 */
const OUTPUT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export default function (pi: ExtensionAPI) {
  const stubbed = new Set<string>();
  const outputDir = path.join(os.tmpdir(), "pi-tool-output");
  let last: { tokens: number; window: number; capped: number; over: boolean } | null = null;
  let overNotified = false;

  function saveFull(toolCallId: string, text: string): string {
    const file = path.join(outputDir, `${toolCallId.replace(/[^\w.-]/g, "_")}.txt`);
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(file, text);
      }
    } catch {
      /* the note still says what was left out */
    }
    return file;
  }

  /** Tokens outside the messages: the last request's real size minus what its messages were estimated at. */
  function baseTokens(messages: Msg[], shaped: Msg[], ctx: ExtensionContext): number {
    for (let j = messages.length - 1; j >= 0; j--) {
      const u = messages[j].role === "assistant" ? (messages[j].usage as { input?: number; cacheRead?: number; cacheWrite?: number } | undefined) : undefined;
      const real = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
      if (real <= 0) continue;
      const est = Math.ceil(SLACK * shaped.slice(0, j).reduce((n, m) => n + estimateTokens(m as never), 0));
      return Math.max(0, real - est);
    }
    return Math.ceil((ctx.getSystemPrompt().length / 4) * SLACK) + 3000;
  }

  function showStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI || !last || last.window > 131_072) return;
    const k = (n: number) => `${Math.round(n / 1000)}K`;
    const parts = [`ctx ~${k(last.tokens)}/${k(last.window)}`];
    if (stubbed.size) parts.push(`${stubbed.size} old outputs shortened`);
    ctx.ui.setStatus("context-budget", parts.join(" · "));
  }

  pi.on("context", async (event, ctx) => {
    const window = ctx.model?.contextWindow ?? 0;
    if (!(window > 0)) return;
    const messages = event.messages as unknown as Msg[];
    const budget = budgetFor(window);
    const run = (base: number, set: Set<string>) => applyBudget({ messages, budget, base, stubbed: set, estimate: (m) => estimateTokens(m as never), saveFull });
    // Size the base from the request as it would be sent now (a dry run), then budget with it.
    const base = baseTokens(messages, run(0, new Set(stubbed)).messages, ctx);
    const before = stubbed.size;
    const result = run(base, stubbed);
    last = { tokens: result.tokens, window, capped: result.capped, over: result.over };
    if (stubbed.size > before && ctx.hasUI && before === 0) {
      ctx.ui.notify(`Context: ${Math.round(window / 1000)}K window — older tool outputs are now sent shortened (full text kept on disk) to leave room for replies.`, "info");
    }
    if (result.over && !overNotified && ctx.hasUI) {
      overNotified = true;
      ctx.ui.notify("Context: the window is nearly full even with old outputs shortened — Pi will compact the session.", "warning");
    }
    if (!result.over) overNotified = false;
    showStatus(ctx);
    return result.changed ? { messages: result.messages as never } : undefined;
  });

  /** What this extension wrote to settings.json, and the models the user said no for. Kept beside it. */
  type Record_ = { written?: Record<string, CompactionOverride>; declined?: string[] };
  const recordFile = () => path.join(getAgentDir(), "context-budget.json");
  const settingsFile = () => path.join(getAgentDir(), "settings.json");

  function readRecord(): Record_ {
    try {
      return JSON.parse(fs.readFileSync(recordFile(), "utf8")) as Record_;
    } catch {
      return {};
    }
  }

  /** settings.json, or null when it exists but cannot be read (then it is never overwritten). */
  function readSettings(): unknown {
    try {
      return JSON.parse(fs.readFileSync(settingsFile(), "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
    }
  }

  /** Bring this model's entry in line with its window; false when nothing was written. */
  function apply(ctx: ExtensionContext, key: string, wanted: CompactionOverride | null): boolean {
    const settings = readSettings();
    if (settings === null) return false;
    const record = readRecord();
    const next = reconcileCompaction(settings, key, wanted, record.written?.[key]);
    if (!next) return false;
    const written = { ...(record.written ?? {}) };
    if (next.mine) written[key] = next.mine;
    else delete written[key];
    try {
      fs.writeFileSync(settingsFile(), `${JSON.stringify(next.settings, null, 2)}\n`);
      fs.writeFileSync(recordFile(), `${JSON.stringify({ ...record, written }, null, 2)}\n`);
    } catch {
      return false;
    }
    if (ctx.hasUI) {
      ctx.ui.notify(
        wanted
          ? `Context: compaction for ${key} now keeps ${wanted.keepRecentTokens} recent tokens and starts ${wanted.reserveTokens} tokens early (settings.json). /reload or restart Pi to use it.`
          : `Context: ${key} no longer has a small window — removed its compaction setting (settings.json). /reload or restart Pi to use Pi's defaults.`,
        "info",
      );
    }
    return true;
  }

  /**
   * Small windows need compaction settings sized to them; Pi's defaults leave nothing to
   * summarize. Adding one to the user's settings.json is asked once per model (declined is
   * remembered). An entry this extension wrote follows the model's window afterwards — updated
   * or removed without asking; an entry the user wrote is never touched.
   */
  const asking = new Set<string>();
  function ensureCompaction(ctx: ExtensionContext) {
    const model = ctx.model;
    if (!model) return;
    const key = `${model.provider}/${model.id}`;
    const wanted = compactionFor(model.contextWindow);
    const record = readRecord();
    if (record.written?.[key]) {
      apply(ctx, key, wanted);
      return;
    }
    const settings = readSettings();
    if (!wanted || settings === null || !reconcileCompaction(settings, key, wanted, undefined)) return;
    if (!ctx.hasUI || record.declined?.includes(key) || asking.has(key)) return;
    asking.add(key);
    const k = `${Math.round(model.contextWindow / 1000)}K`;
    void ctx.ui
      .confirm(
        `Compaction for a ${k} window`,
        `${key} has a ${k} window. Pi's compaction defaults (keep the last 20K tokens) leave nothing to summarize on it, so a long session fills up and stops. ` +
          `Add a setting for this model to ~/.pi/agent/settings.json that keeps ${wanted.keepRecentTokens} recent tokens and compacts ${wanted.reserveTokens} tokens early? ` +
          `It is updated or removed if the window changes. Asked once.`,
      )
      .then(
        (yes) => {
          if (yes) apply(ctx, key, wanted);
          else {
            const r = readRecord();
            try {
              fs.writeFileSync(recordFile(), `${JSON.stringify({ ...r, declined: [...new Set([...(r.declined ?? []), key])] }, null, 2)}\n`);
            } catch {
              /* asked again next time */
            }
            if (ctx.hasUI) ctx.ui.notify(`Context: left settings.json alone. Long sessions on ${key} may stop when the window fills; /new starts fresh.`, "info");
          }
        },
        () => {},
      )
      .finally(() => asking.delete(key));
  }

  /** Full outputs saved for the model to read back are kept a week. */
  function pruneSavedOutputs() {
    const cutoff = Date.now() - OUTPUT_KEEP_MS;
    try {
      for (const name of fs.readdirSync(outputDir)) {
        const file = path.join(outputDir, name);
        try {
          if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
        } catch {
          /* in use or gone */
        }
      }
    } catch {
      /* no folder yet */
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    stubbed.clear();
    last = null;
    pruneSavedOutputs();
    ensureCompaction(ctx);
  });
  pi.on("model_select", async (_event, ctx) => ensureCompaction(ctx));
  pi.on("session_compact", async () => {
    stubbed.clear(); // the outputs it held are summarized now
  });

  pi.registerCommand("context", {
    description: "How full the context is and what the budget shortened",
    handler: async (_args, ctx) => {
      const window = ctx.model?.contextWindow ?? 0;
      if (!window) return ctx.ui.notify("Context: no model selected.", "info");
      const b = budgetFor(window);
      const lines = [
        `Window ${window.toLocaleString()} tokens · last request ~${(last?.tokens ?? 0).toLocaleString()}`,
        `One tool output at most ${b.cap.toLocaleString()} tokens (longer ones: start and end, full text in ${outputDir})`,
        b.rolling
          ? `Old outputs shortened above ${b.high.toLocaleString()} tokens, down to ${b.low.toLocaleString()} — ${stubbed.size} so far`
          : "Window large enough: old outputs are left to compaction",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
