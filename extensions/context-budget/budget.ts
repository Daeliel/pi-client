/**
 * The context window as a budget. Small windows (32K of KV cache) fill up with tool output the
 * model read once and never needs again; Pi's compaction waits until the window is nearly full
 * and then asks the model for a summary, which on 32K comes too late and is the weakest step.
 * Instead, every request is kept inside the budget as it is built:
 *
 * 1. Intake: no single tool output takes more than CAP_SHARE of the window. A longer one is
 *    sent as its start and end, with the full text saved to a file the model can read.
 * 2. Working set: when the request passes HIGH of the window, the oldest tool outputs are
 *    replaced by a one-line stub (what ran, how much output, ok or failed, where the full text
 *    is) until it is back under LOW. The newest KEEP_FULL outputs are never stubbed, nor is
 *    anything the user or the model wrote. A stubbed output stays stubbed, so the start of the
 *    request does not change from one request to the next (prompt caches keep working).
 *
 * Only what is sent changes; the session keeps every output in full. All sizes scale with the
 * window, and the working set applies up to ROLLING_MAX_WINDOW — bigger windows are left to
 * compaction.
 */

export const CAP_SHARE = 0.08;
export const HIGH = 0.7;
export const LOW = 0.45;
export const KEEP_FULL = 3;
/** How much larger than estimated a request may really be (estimates count characters / 4). */
export const SLACK = 1.1;
export const ROLLING_MAX_WINDOW = 131_072;

export interface Budget {
  /** Most tokens one tool output may take. */
  cap: number;
  /** Request size (tokens) above which old outputs are stubbed... */
  high: number;
  /** ...down to this size. */
  low: number;
  rolling: boolean;
}

export function budgetFor(contextWindow: number): Budget {
  return {
    cap: Math.max(1024, Math.floor(contextWindow * CAP_SHARE)),
    high: Math.floor(contextWindow * HIGH),
    low: Math.floor(contextWindow * LOW),
    rolling: contextWindow <= ROLLING_MAX_WINDOW,
  };
}

/** The message fields this module reads; everything else is carried over untouched. */
export interface Msg {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
}

type Block = { type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };

export interface BudgetInput {
  messages: Msg[];
  budget: Budget;
  /** Tokens of the request outside `messages`: system prompt, tool declarations. */
  base: number;
  /** Tool call ids already stubbed by earlier requests; new ones are added. */
  stubbed: Set<string>;
  estimate: (m: Msg) => number;
  /** Saves a tool output in full and returns where; called only for outputs that are cut. */
  saveFull: (toolCallId: string, text: string) => string;
}

export interface BudgetResult {
  messages: Msg[];
  changed: boolean;
  /** Estimated request size after the budget, tokens. */
  tokens: number;
  /** Outputs cut to their start and end in this request. */
  capped: number;
  /** Still over `high` with nothing left to stub. */
  over: boolean;
}

const textOf = (content: unknown): string =>
  Array.isArray(content) ? (content as Block[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") : typeof content === "string" ? content : "";

const lineCount = (s: string) => (s ? s.split("\n").length : 0);

/** The start and end of `text` within `capTokens`, cut at line ends, with a note on what is left out. */
export function capText(text: string, capTokens: number, fullPath: string): string {
  const chars = capTokens * 4;
  if (text.length <= chars) return text;
  const headEnd = text.lastIndexOf("\n", Math.floor(chars * 0.4));
  const head = text.slice(0, headEnd > 0 ? headEnd : Math.floor(chars * 0.4));
  const tailStart = text.indexOf("\n", text.length - Math.floor(chars * 0.6));
  const tail = text.slice(tailStart > 0 ? tailStart + 1 : text.length - Math.floor(chars * 0.6));
  const left = text.slice(head.length, text.length - tail.length);
  return `${head}\n[… ${lineCount(left)} lines (${left.length} characters) not shown to save context — the full output is in ${fullPath}; read it with offset/limit if you need it …]\n${tail}`;
}

function briefArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const first = args.command ?? args.path ?? args.file_path ?? args.pattern ?? Object.values(args).find((v) => typeof v === "string");
  const s = (typeof first === "string" ? first : JSON.stringify(args)).replace(/\s+/g, " ").trim();
  return s.length > 100 ? `${s.slice(0, 97)}...` : s;
}

/** Long string arguments of an old call (a written file's content) are not repeated either. */
function shrinkArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" && v.length > 400 ? `[${lineCount(v)} lines, ${v.length} characters — not repeated to save context]` : v;
  }
  return out;
}

export function applyBudget(input: BudgetInput): BudgetResult {
  const { budget, base, stubbed, estimate, saveFull } = input;
  const calls = new Map<string, Block>();
  for (const m of input.messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) if (b.type === "toolCall" && b.id) calls.set(b.id, b);
  }
  const resultIds = input.messages.filter((m) => m.role === "toolResult" && m.toolCallId).map((m) => m.toolCallId!);
  const keep = new Set(resultIds.slice(-KEEP_FULL));

  const stubOf = (m: Msg): Msg => {
    const text = textOf(m.content);
    const where = text ? saveFull(m.toolCallId!, text) : "";
    const call = calls.get(m.toolCallId!);
    const what = [m.toolName, briefArgs(call?.arguments)].filter(Boolean).join(" ");
    const note = `[${what} — ${lineCount(text)} lines of output, ${m.isError ? "failed" : "ok"}; shortened to save context.${where ? ` Full output: ${where}` : ""}]`;
    return { ...m, content: [{ type: "text", text: note }] };
  };

  let capped = 0;
  const shaped = (m: Msg): Msg => {
    if (m.role === "toolResult" && m.toolCallId) {
      if (stubbed.has(m.toolCallId) && !keep.has(m.toolCallId)) return stubOf(m);
      const text = textOf(m.content);
      if (text.length > budget.cap * 4) {
        capped += 1;
        const images = Array.isArray(m.content) ? (m.content as Block[]).filter((b) => b.type !== "text") : [];
        return { ...m, content: [{ type: "text", text: capText(text, budget.cap, saveFull(m.toolCallId, text)) }, ...images] };
      }
      return m;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const blocks = m.content as Block[];
      if (!blocks.some((b) => b.type === "toolCall" && b.id && stubbed.has(b.id) && !keep.has(b.id))) return m;
      return {
        ...m,
        content: blocks.map((b) => (b.type === "toolCall" && b.id && stubbed.has(b.id) && !keep.has(b.id) && b.arguments ? { ...b, arguments: shrinkArgs(b.arguments) } : b)),
      };
    }
    return m;
  };

  const size = (ms: Msg[]) => base + Math.ceil(SLACK * ms.reduce((n, m) => n + estimate(m), 0));
  let out = input.messages.map(shaped);
  let tokens = size(out);

  if (budget.rolling && tokens > budget.high) {
    for (const id of resultIds) {
      if (tokens <= budget.low) break;
      if (keep.has(id) || stubbed.has(id)) continue;
      stubbed.add(id);
      capped = 0;
      out = input.messages.map(shaped);
      tokens = size(out);
    }
  }
  const changed = out.some((m, i) => m !== input.messages[i]);
  return { messages: out, changed, tokens, capped, over: tokens > budget.high };
}
