import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import antiLoopExt from "../extensions/anti-loop/index";
import budgetExt from "../extensions/context-budget/index";
import * as fs from "node:fs";
import * as path from "node:path";
import { call, createHarness, fauxAssistantMessage, reply } from "./harness";

/** A tool whose every run prints ~1,200 tokens, like a test run or a long listing. */
const noisy = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "run",
    label: "Run",
    description: "Run one step of the build and print its log.",
    parameters: Type.Object({ step: Type.Number() }),
    async execute(_id, p) {
      const log = Array.from({ length: 240 }, (_, k) => `step ${p.step} log line ${k} ok`).join("\n");
      return { content: [{ type: "text", text: log }], details: {} };
    },
  });
};

/** Tokens of what the model reads (characters / 4): text, thinking and call arguments, no metadata. */
const tokensSent = (context: { messages?: unknown[] }) => {
  let chars = 0;
  for (const m of (context.messages ?? []) as { content?: unknown }[]) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : ((m.content ?? []) as Record<string, unknown>[]);
    for (const b of blocks) chars += String(b.text ?? b.thinking ?? "").length + (b.arguments ? JSON.stringify(b.arguments).length : 0);
  }
  return Math.ceil(chars / 4);
};

describe("context budget", () => {
  it("a long tool-heavy run on a 32K window always leaves room for the reply", async () => {
    const notices: string[] = [];
    const h = await createHarness({
      extensions: [noisy, budgetExt],
      limits: { contextWindow: 32_768, maxTokens: 32_768 },
      settings: { compaction: { enabled: false } },
      ui: { notify: ((msg: string) => notices.push(msg)) as never },
    });
    try {
      const steps = 30; // ~36K tokens of output in one run: more than the whole window
      const sizes: number[] = [];
      let lastSeen = "";
      h.faux.setResponses([
        ...Array.from({ length: steps }, (_, i) => (context: { messages?: unknown[] }) => {
          sizes.push(tokensSent(context));
          return call("run", { step: i });
        }),
        (context: { messages?: unknown[] }) => {
          sizes.push(tokensSent(context));
          lastSeen = JSON.stringify(context.messages ?? []);
          return reply("all steps done");
        },
      ]);
      await h.session.prompt("run all the build steps");
      assert.equal(h.faux.getPendingResponseCount(), 0, "every step ran");
      const most = Math.max(...sizes);
      assert.ok(most < 32_768 * 0.75, `largest request ~${most} tokens of 32,768`);
      assert.match(lastSeen, /step 29 log line 239 ok/, "the newest output is sent whole");
      assert.match(lastSeen, /run \{\\"step\\":0\} — 240 lines of output, ok; shortened to save context\. Full output: /);
      assert.match(lastSeen, /run all the build steps/, "the task itself is never shortened");
      const full = h.session.messages.filter((m) => m.role === "toolResult");
      assert.equal(full.length, steps);
      assert.ok(full.every((m) => JSON.stringify(m.content).includes("log line 239")), "the session keeps every output in full");
      assert.ok(notices.some((n) => /older tool outputs are now sent shortened/.test(n)), notices.join(" | "));
    } finally {
      h.dispose();
    }
  });

  it("a reply with no room left is not told to continue: the session is compacted and the task picks up", async () => {
    const notices: string[] = [];
    const h = await createHarness({
      extensions: [antiLoopExt],
      limits: { contextWindow: 8_000, maxTokens: 8_000 },
      settings: { compaction: { enabled: false, keepRecentTokens: 500 } },
      ui: { notify: ((msg: string) => notices.push(msg)) as never },
    });
    try {
      const page = (i: number) => `Notes part ${i}: ` + "the level layout uses a grid of tiles. ".repeat(220);
      for (let i = 1; i <= 3; i++) {
        h.faux.setResponses([reply(`noted ${i}`)]);
        await h.session.prompt(page(i));
      }
      h.faux.setResponses([
        fauxAssistantMessage("We", { stopReason: "length" }), // ~6.7K of 8K in: no room
        reply("## Goal\nLevel notes."), // the summary
        reply("Continuing with the layout."),
        reply("Continuing with the layout."),
      ]);
      await h.session.prompt("now build the level");
      await h.settle();
      assert.ok(notices.some((n) => /no room left for a reply/.test(n)), notices.join(" | "));
      assert.ok(!h.userMessages().some((m) => /Continue from where you stopped/.test(m)), "no truncation steer");
      assert.ok(!notices.some((n) => /hard stop|could not make room/.test(n)), notices.join(" | "));
      assert.ok(h.userMessages().some((m) => /The context was full/.test(m)), "the task picks up after compaction");
      const lastReply = h.session.messages.filter((m) => m.role === "assistant").at(-1) as { stopReason?: string } | undefined;
      assert.equal(lastReply?.stopReason, "stop", "and the model answers");
    } finally {
      h.dispose();
    }
  });

  it("asks once before adding compaction settings for a small window; yes writes them, no is remembered", async () => {
    for (const answer of [true, false]) {
      const asked: string[] = [];
      const h = await createHarness({
        extensions: [budgetExt],
        limits: { contextWindow: 32_768, maxTokens: 8_192 },
        ui: { confirm: (async (title: string) => (asked.push(title), answer)) as never },
      });
      try {
        await h.settle();
        const agentDir = path.join(h.home, ".pi", "agent");
        const read = (f: string) => (fs.existsSync(path.join(agentDir, f)) ? JSON.parse(fs.readFileSync(path.join(agentDir, f), "utf8")) : {});
        assert.deepEqual(asked, ["Compaction for a 33K window"]);
        const override = read("settings.json").compaction?.modelOverrides?.["faux/small"];
        if (answer) assert.deepEqual(override, { reserveTokens: 8192, keepRecentTokens: 8192 });
        else {
          assert.equal(override, undefined, "settings.json left alone");
          assert.deepEqual(read("context-budget.json").declined, ["faux/small"]);
        }
      } finally {
        h.dispose();
      }
    }
  });
});
