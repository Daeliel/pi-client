import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DROPPED_NOTE, trimImages } from "./image-budget.ts";

const img = (n: number) => ({ type: "image", data: "x".repeat(n), mimeType: "image/png" });

describe("image budget", () => {
  it("keeps the newest images within the budget and notes the dropped ones in their place", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "toolResult", content: [{ type: "text", text: "shot 1" }, img(600)] },
      { role: "toolResult", content: [{ type: "text", text: "shot 2" }, img(600)] },
      { role: "toolResult", content: [img(300), img(300)] },
    ];
    const r = trimImages(messages, 1300)!;
    assert.equal(r.dropped, 1);
    assert.equal(r.keptBytes, 1200);
    assert.deepEqual(r.messages[1]!.content, [{ type: "text", text: "shot 1" }, { type: "text", text: DROPPED_NOTE }]);
    assert.equal(r.messages[2], messages[2], "untouched messages are the same objects");
    assert.equal((messages[1]!.content[1] as { type: string }).type, "image", "the input is not changed");
  });

  it("nothing to do: under budget, no images, or budget 0 (off)", () => {
    const messages = [{ role: "toolResult", content: [img(100)] }];
    assert.equal(trimImages(messages, 1000), null);
    assert.equal(trimImages([{ role: "user", content: "hi" }], 10), null);
    assert.equal(trimImages(messages, 0), null);
  });
});
