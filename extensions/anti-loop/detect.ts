/** Stable fingerprint for toolName + args (order-independent keys). */
export function toolFingerprint(toolName: string, input: unknown): string {
  return `${toolName}::${stableStringify(input)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

const STUCK_PHRASES = [
  /i'?m stuck in a loop/i,
  /stuck in a loop/i,
  /let me try a different approach/i,
  /keep(?:ing)? (?:doing|trying) the same/i,
  /going in circles/i,
];

/** True if assistant text looks like a verbal thrash loop. */
export function hasStuckPhrase(text: string): boolean {
  if (!text.trim()) return false;
  return STUCK_PHRASES.some((re) => re.test(text));
}

/** Count how many times the same stuck phrase cluster appears (weak models paste the block). */
export function stuckPhraseRepeatCount(text: string): number {
  const needle = "stuck in a loop";
  const lower = text.toLowerCase();
  let count = 0;
  let from = 0;
  while (true) {
    const idx = lower.indexOf(needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

const MIN_LOOP_LINE_LEN = 40;

/** Normalize a reasoning line for repeat matching. */
function normalizeLoopLine(line: string): string {
  return line.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Max times any substantial line repeats in thinking/text.
 * Catches "try different port / kill node / different approach" cycles.
 */
export function repeatedLineCount(text: string): number {
  if (!text.trim()) return 0;
  const counts = new Map<string, number>();
  let max = 0;
  for (const raw of text.split(/\n+/)) {
    const key = normalizeLoopLine(raw);
    if (key.length < MIN_LOOP_LINE_LEN) continue;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > max) max = n;
  }
  return max;
}

/**
 * True when reasoning is cycling the same plan lines (or named stuck phrases).
 * Default: same ≥40-char line appears 3+ times.
 */
export function isThinkingLoop(text: string, minRepeats = 3): boolean {
  if (!text.trim()) return false;
  if (repeatedLineCount(text) >= minRepeats) return true;
  if (stuckPhraseRepeatCount(text) >= 2) return true;
  if (hasStuckPhrase(text) && repeatedLineCount(text) >= 2) return true;
  return false;
}

export interface AssistantStopInfo {
  stopReason?: string;
  errorMessage?: string;
}

const TRUNCATION_ERROR =
  /maximum output token|max(?:imum)? (?:output )?tokens?|response may be incomplete|output token limit|finish_reason.*length|length limit/i;

/** Truncated by max output tokens (stopReason length, or error text). */
export function isOutputTruncated(info: AssistantStopInfo): boolean {
  if (info.stopReason === "length") return true;
  if (info.stopReason === "error" && info.errorMessage && TRUNCATION_ERROR.test(info.errorMessage)) {
    return true;
  }
  if (info.errorMessage && TRUNCATION_ERROR.test(info.errorMessage)) return true;
  return false;
}

export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as { role?: string; content?: unknown };
  if (msg.role !== "assistant") return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** Reasoning / thinking channel — where weak models often dump Hermes-style tool XML. */
export function extractAssistantThinking(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as { role?: string; content?: unknown };
  if (msg.role !== "assistant") return "";
  const content = msg.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; thinking?: string };
    if (b.type === "thinking" && typeof b.thinking === "string") parts.push(b.thinking);
  }
  return parts.join("\n");
}

export function hasToolCallBlock(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const msg = message as { role?: string; content?: unknown };
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return false;
  return msg.content.some(
    (block) =>
      !!block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "toolCall",
  );
}

export function extractStopInfo(message: unknown): AssistantStopInfo {
  if (!message || typeof message !== "object") return {};
  const msg = message as { role?: string; stopReason?: string; errorMessage?: string };
  if (msg.role !== "assistant") return {};
  return {
    stopReason: typeof msg.stopReason === "string" ? msg.stopReason : undefined,
    errorMessage: typeof msg.errorMessage === "string" ? msg.errorMessage : undefined,
  };
}

/** Hermes/Qwen text tool syntax that Pi does not execute. */
const GHOST_HERMES =
  /<tool_call>\s*<function=([A-Za-z0-9_.-]+)>/i;
const GHOST_JSON_NAME =
  /<tool_call>\s*\{[\s\S]*?"name"\s*:\s*"([A-Za-z0-9_.-]+)"/i;
/** Other wrappers small models emit as plain text: <function_call>, Mistral [TOOL_CALLS], <|tool_call|>. */
const GHOST_WRAPPED =
  /(?:<function_call>|\[TOOL_CALLS\]|<\|tool_call\|>)\s*\[?\s*\{[\s\S]*?"name"\s*:\s*"([A-Za-z0-9_.-]+)"/i;
/** A bare JSON call object: {"name": "read", "arguments": {...}} (also "parameters"). */
const GHOST_BARE_JSON =
  /\{\s*"name"\s*:\s*"([A-Za-z0-9_.-]+)"\s*,\s*"(?:arguments|parameters)"\s*:/gi;

export interface GhostToolInfo {
  toolName: string;
}

/**
 * Model wrote tool syntax in thinking/text but emitted no native toolCall.
 * Pi only executes native tool calls — these "ghost" calls never run.
 *
 * Wrapped syntax (<tool_call>, <function_call>, [TOOL_CALLS]) is unambiguous. A bare
 * JSON object is only treated as a call when it names a tool that really exists
 * (`knownTools`), so JSON the model shows as an example is not flagged.
 */
export function findGhostToolCall(message: unknown, knownTools?: Iterable<string>): GhostToolInfo | null {
  const stop = extractStopInfo(message);
  if (stop.stopReason === "toolUse") return null;
  if (hasToolCallBlock(message)) return null;

  const blob = [extractAssistantThinking(message), extractAssistantText(message)]
    .filter(Boolean)
    .join("\n");
  if (!blob) return null;

  const wrapped = blob.match(GHOST_HERMES) ?? blob.match(GHOST_JSON_NAME) ?? blob.match(GHOST_WRAPPED);
  if (wrapped?.[1]) return { toolName: wrapped[1] };

  if (knownTools) {
    const known = new Set(knownTools);
    for (const m of blob.matchAll(GHOST_BARE_JSON)) {
      if (m[1] && known.has(m[1])) return { toolName: m[1] };
    }
  }
  return null;
}

export const REPEAT_STEER = `ANTI-LOOP: You already ran that exact tool call. Do NOT repeat it.

Pick ONE different next step:
1. Change the code (edit/write) based on evidence you already have, OR
2. Restart the running server/dev process if code changed but the process is stale, OR
3. Run a different check (test/scenario) that proves the bug, OR
4. Ask the user one concrete question if you are blocked.

One action only. Short reply. No replaying the same investigation.`;

export const TRUNCATION_STEER = `ANTI-LOOP: Your previous response was cut off (max output tokens). The reply is incomplete.

Continue from where you stopped:
- One short plan line
- One tool call only
- Writing a large file? Write the first part with write, then add the rest with edit in smaller pieces. Do not resend the whole file.
- Do not restate the whole investigation
- Do not dump long reasoning`;

export const STUCK_STEER = `ANTI-LOOP: You are repeating the same stuck-loop reasoning. Stop replaying that monologue.

Do ONE concrete action you have not done yet (edit code, restart server, or run a different test). If you cannot, tell the user what is blocking you in 2 sentences.`;

export const THINKING_LOOP_STEER = `ANTI-LOOP: Your thinking is looping — the same plan lines keep repeating (e.g. "try another port" / "kill node" / "different approach"). That burns tokens and does nothing.

STOP narrating. Do ONE real tool call you have not done yet, or tell the user you are blocked in 2 sentences. No more reasoning cycles.`;

export function ghostToolSteer(toolName: string): string {
  return `ANTI-LOOP: Your previous <tool_call>/<function=${toolName}> was NOT executed. That XML in thinking/text is ignored.

Call the tool through the harness API (native tool use) — do not write <tool_call> or <function=...> tags.
One real tool call only. Short reply. No replaying the XML.`;
}

export const HARD_STOP_MSG = `ANTI-LOOP: Hard stop — agent aborted after repeated thrash/truncation.

The harness aborted the run so the GPU is not burned. Your next prompt enters user-help: ask what you cannot observe, or act on what the user types. /stuck off to skip.`;
