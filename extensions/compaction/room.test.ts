import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MIN_SUMMARY_OUTPUT, isContextOverflow, summaryRoom } from "./room";

describe("summary room", () => {
  it("the request that failed in practice is given a limit that fits", () => {
    // 524,288-token window, 131,072 output limit, 426,321 real input tokens — estimated ~2.5% short.
    const estimated = Math.round(426_321 / 1.025);
    const room = summaryRoom(524_288, 131_072, estimated);
    assert.equal(room.kind, "limit");
    if (room.kind !== "limit") return;
    assert.ok(426_321 + room.maxTokens <= 524_288, `real input + ${room.maxTokens} fits the window`);
    assert.ok(room.maxTokens >= 32_768, "still room for a real summary");
  });

  it("an ordinary output limit is left alone", () => {
    assert.deepEqual(summaryRoom(524_288, 32_768, 400_000), { kind: "fits" });
    assert.deepEqual(summaryRoom(131_072, 32_768, 80_000), { kind: "fits" });
  });

  it("no room at all is reported, not papered over", () => {
    assert.deepEqual(summaryRoom(131_072, 32_768, 125_000), { kind: "no-room" });
    const edge = summaryRoom(131_072, 32_768, 105_000);
    assert.ok(edge.kind === "no-room" || (edge.kind === "limit" && edge.maxTokens >= MIN_SUMMARY_OUTPUT));
  });

  it("a model without known limits is never touched", () => {
    assert.deepEqual(summaryRoom(0, 131_072, 400_000), { kind: "fits" });
    assert.deepEqual(summaryRoom(524_288, 0, 400_000), { kind: "fits" });
  });

  it("recognises context-overflow errors from different servers", () => {
    assert.ok(isContextOverflow(`Summarization failed: 400: {"message":"Requested token count exceeds the model's maximum context length of 524288 tokens."}`));
    assert.ok(isContextOverflow("prompt is too long: 210000 tokens > 200000 maximum"));
    assert.ok(isContextOverflow("This model's maximum context length is 131072 tokens"));
    assert.ok(!isContextOverflow("Already compacted"));
    assert.ok(!isContextOverflow("Nothing to compact (session too small)"));
    assert.ok(!isContextOverflow(undefined));
  });
});
