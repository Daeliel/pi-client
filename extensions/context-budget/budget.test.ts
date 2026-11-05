import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyBudget, budgetFor, capText, KEEP_FULL, type Msg } from "./budget";
import { compactionFor, reconcileCompaction } from "./settings";

const estimate = (m: Msg) => Math.ceil(JSON.stringify(m.content ?? "").length / 4);
const saved = new Map<string, string>();
const saveFull = (id: string, text: string) => {
  saved.set(id, text);
  return `/tmp/out/${id}.txt`;
};

/** A run of `n` tool calls, each returning `tokens` of output. */
function run(n: number, tokens: number): Msg[] {
  const ms: Msg[] = [{ role: "user", content: "fix the build" }];
  for (let i = 0; i < n; i++) {
    const id = `call${i}`;
    ms.push({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: `npm test -- part${i}` } }] });
    const body = Array.from({ length: Math.ceil((tokens * 4) / 20) }, (_, k) => `out ${i} line ${k} ok`).join("\n");
    ms.push({ role: "toolResult", toolCallId: id, toolName: "bash", isError: i % 4 === 3, content: [{ type: "text", text: body }] });
  }
  return ms;
}

const sent = (ms: Msg[]) => ms.map((m) => JSON.stringify(m.content)).join("\n");

describe("context budget", () => {
  it("a long run on a 32K window stays under budget; the newest outputs and every instruction stay whole", () => {
    const budget = budgetFor(32_768);
    const messages = run(20, 1200); // ~26K tokens of tool output alone
    const stubbed = new Set<string>();
    const r = applyBudget({ messages, budget, base: 7600, stubbed, estimate, saveFull });
    assert.ok(r.tokens <= budget.low, `request ~${r.tokens} tokens`);
    assert.ok(!r.over);
    for (const m of messages.slice(-2 * KEEP_FULL)) assert.ok(r.messages.includes(m), "the newest calls and outputs are sent as they are");
    assert.equal(r.messages[0], messages[0], "the user's message is never touched");
    const out = sent(r.messages);
    assert.match(out, /\[bash npm test -- part0 — \d+ lines of output, ok; shortened to save context\. Full output: \/tmp\/out\/call0\.txt\]/);
    assert.match(out, /part3 — \d+ lines of output, failed/);
    assert.equal(saved.get("call0"), (messages[2].content as { text: string }[])[0].text, "the full output is kept");
    assert.equal(messages.length, r.messages.length, "nothing is dropped, only shortened");
  });

  it("stubs stay stubbed, so the start of the request does not change between requests", () => {
    const budget = budgetFor(32_768);
    const stubbed = new Set<string>();
    const first = applyBudget({ messages: run(20, 1200), budget, base: 7600, stubbed, estimate, saveFull });
    const n = stubbed.size;
    const second = applyBudget({ messages: run(21, 1200), budget, base: 7600, stubbed, estimate, saveFull });
    assert.ok(stubbed.size >= n);
    assert.deepEqual(second.messages.slice(0, 2 * n), first.messages.slice(0, 2 * n), "same prefix");
  });

  it("an old call's long arguments (a written file) are not repeated once its output is stubbed", () => {
    const budget = budgetFor(32_768);
    const messages = run(20, 1200);
    (messages[1].content as { arguments: Record<string, unknown> }[])[0].arguments = { path: "src/game.js", content: "x\n".repeat(3000) };
    const r = applyBudget({ messages, budget, base: 7600, stubbed: new Set(), estimate, saveFull });
    const args = (r.messages[1].content as { arguments: Record<string, unknown> }[])[0].arguments;
    assert.equal(args.path, "src/game.js");
    assert.match(String(args.content), /^\[3001 lines, 6000 characters — not repeated/);
  });

  it("one huge output is sent as its start and end, with where to find the rest", () => {
    const budget = budgetFor(32_768);
    const messages = run(1, 9000);
    const r = applyBudget({ messages, budget, base: 7600, stubbed: new Set(), estimate, saveFull });
    assert.equal(r.capped, 1);
    const text = (r.messages[2].content as { text: string }[])[0].text;
    assert.ok(text.length <= budget.cap * 4 + 300, `${text.length} characters`);
    assert.ok(text.startsWith("out 0 line 0 ok"));
    assert.match(text, /out 0 line \d+ ok$/);
    assert.match(text, /lines \(\d+ characters\) not shown to save context — the full output is in \/tmp\/out\/call0\.txt/);
  });

  it("a big window is left alone", () => {
    const budget = budgetFor(524_288);
    assert.equal(budget.rolling, false);
    const messages = run(20, 1200);
    const r = applyBudget({ messages, budget, base: 7600, stubbed: new Set(), estimate, saveFull });
    assert.equal(r.changed, false);
  });

  it("capText keeps short text as it is", () => {
    assert.equal(capText("a\nb", 1024, "/x"), "a\nb");
  });
});

describe("compaction settings for small windows", () => {
  it("a 32K window keeps and reserves a quarter; big windows keep Pi's defaults", () => {
    assert.deepEqual(compactionFor(32_768), { reserveTokens: 8192, keepRecentTokens: 8192 });
    assert.equal(compactionFor(131_072), null);
    assert.equal(compactionFor(0), null);
  });

  const small = { reserveTokens: 8192, keepRecentTokens: 8192 };

  it("adds an override without touching other settings, and never replaces the user's own", () => {
    const settings = { defaultModel: "x", compaction: { enabled: true, modelOverrides: { "a/b": { reserveTokens: 1 } } } };
    const next = reconcileCompaction(settings, "lab/small", small, undefined)!;
    assert.deepEqual(next.settings, {
      defaultModel: "x",
      compaction: { enabled: true, modelOverrides: { "a/b": { reserveTokens: 1 }, "lab/small": small } },
    });
    assert.deepEqual(next.mine, small);
    assert.equal(reconcileCompaction(next.settings, "a/b", small, undefined), null, "the user's own entry");
    assert.equal(reconcileCompaction("nonsense", "lab/small", small, undefined), null);
  });

  it("its own entry follows the window: removed when the model grows to 1M, resized when it shrinks", () => {
    const at32k = reconcileCompaction({}, "lab/1bit", small, undefined)!;
    const at1m = reconcileCompaction(at32k.settings, "lab/1bit", compactionFor(1_048_576), at32k.mine!)!;
    assert.deepEqual(at1m.settings, { compaction: { modelOverrides: {} } });
    assert.equal(at1m.mine, null);
    const at16k = reconcileCompaction(at32k.settings, "lab/1bit", compactionFor(16_384), at32k.mine!)!;
    assert.deepEqual((at16k.settings.compaction as { modelOverrides: Record<string, unknown> }).modelOverrides["lab/1bit"], { reserveTokens: 4096, keepRecentTokens: 4096 });
  });

  it("an entry the user changed or removed stays as they left it", () => {
    const edited = { compaction: { modelOverrides: { "lab/1bit": { reserveTokens: 8192, keepRecentTokens: 4000 } } } };
    assert.equal(reconcileCompaction(edited, "lab/1bit", null, small), null);
    assert.equal(reconcileCompaction({}, "lab/1bit", small, small), null);
  });
});
