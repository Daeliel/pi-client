import { describe, it } from "node:test";
import assert from "node:assert/strict";
import compactionExt from "../extensions/compaction/index";
import { createHarness, reply } from "./harness";

// ~1K tokens per reply; Pi keeps the last 2K, so ~3K tokens go to the summary.
const step = (i: number) => reply(`Step ${i}: ` + Array.from({ length: 200 }, (_, k) => `line ${i}.${k} of the work`).join(" "));

/** Five steps on a 16K-window model that allows 12K of output, then /compact. */
async function compactWith(extensions: Parameters<typeof createHarness>[0]["extensions"]) {
  const notices: string[] = [];
  const asked: number[] = [];
  const h = await createHarness({
    extensions,
    limits: { contextWindow: 16_000, maxTokens: 12_000 },
    settings: { compaction: { enabled: false, keepRecentTokens: 2000 } },
    ui: { notify: ((msg: string) => notices.push(msg)) as never },
  });
  try {
    for (let i = 1; i <= 5; i++) {
      h.faux.setResponses([step(i)]);
      await h.session.prompt(`do step ${i}`);
    }
    // The model the summary was requested with: its output limit is what the provider trims.
    const summary = (_context: unknown, _options: unknown, _state: unknown, model: { maxTokens: number }) => {
      asked.push(model.maxTokens);
      return reply("## Goal\nFive steps of work.");
    };
    h.faux.setResponses([summary, summary]);
    await h.session.compact();
    return { asked, notices };
  } finally {
    h.dispose();
  }
}

describe("compaction", () => {
  it("a summary request that would not fit the window asks for less output, and compaction succeeds", async () => {
    // Without the guard the same summary asks for the model's full 12,000.
    const guarded = await compactWith([compactionExt]);
    assert.ok(guarded.asked.length > 0 && guarded.asked.every((n) => n > 0 && n < 12_000), `asked for ${guarded.asked}`);
    assert.ok(guarded.notices.some((n) => /summary limited to/.test(n)), guarded.notices.join(" | "));
  });
});
