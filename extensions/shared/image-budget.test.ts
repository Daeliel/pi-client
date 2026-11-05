import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DROPPED_NOTE, trimImages } from "./image-budget.ts";

let seq = 0;
/** A picture of n bytes; each call is a different picture. */
const img = (n: number) => {
  const tag = String(seq++).padStart(6, "0");
  return { type: "image", data: tag + "x".repeat(Math.max(0, n - tag.length)), mimeType: "image/png" };
};
const shot = (n: number) => ({ role: "toolResult", content: [{ type: "text", text: "shot" }, img(n)] });
const sent = (messages: { content: unknown }[]) => JSON.stringify(messages);

describe("image budget", () => {
  it("over the budget, drops the oldest images in one batch down to half of it", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "toolResult", content: [{ type: "text", text: "shot 1" }, img(600)] },
      { role: "toolResult", content: [{ type: "text", text: "shot 2" }, img(600)] },
      { role: "toolResult", content: [img(300), img(300)] },
    ];
    const r = trimImages(messages, 1300)!;
    assert.equal(r.dropped, 2);
    assert.equal(r.keptBytes, 600);
    assert.deepEqual(r.messages[1]!.content, [{ type: "text", text: "shot 1" }, { type: "text", text: DROPPED_NOTE }]);
    assert.equal(r.messages[3], messages[3], "the newest images go through, as the same object");
    assert.equal((messages[1]!.content[1] as { type: string }).type, "image", "the input is not changed");
  });

  it("keeps the start of the conversation the same while screenshots keep coming", () => {
    const dropped = new Set<string>();
    const messages: { role: string; content: unknown[] }[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    for (let i = 0; i < 4; i++) messages.push(shot(250));
    const first = trimImages(messages, 1000, dropped);
    assert.equal(first, null, "1000 bytes: nothing to drop yet");
    messages.push(shot(250)); // 1250 > 1000: one batch, down to 500
    const batch = trimImages(messages, 1000, dropped)!;
    assert.equal(batch.dropped, 3);
    const prefix = sent(batch.messages.slice(0, 5));
    let changes = 0;
    let last = prefix;
    for (let i = 0; i < 2; i++) {
      messages.push(shot(250));
      const next = trimImages(messages, 1000, dropped)!;
      const head = sent(next.messages.slice(0, 5));
      if (head !== last) changes++;
      last = head;
    }
    assert.equal(changes, 0, "two more screenshots under the budget change nothing already sent");
    // The old way dropped one more image each time, changing the start of every request.
  });

  it("an image left out stays out, even after the budget would let it back", () => {
    const dropped = new Set<string>();
    const messages = [shot(600), shot(600), shot(100)];
    trimImages(messages, 1000, dropped);
    const later = trimImages(messages.slice(1), 5000, dropped)!;
    assert.equal(later.dropped, 1, "the dropped picture is still left out");
  });

  it("the same picture is the same wherever it sits", () => {
    const dropped = new Set<string>();
    const pic = img(700);
    trimImages([{ role: "toolResult", content: [pic] }, shot(700)], 1000, dropped);
    const moved = trimImages([{ role: "user", content: [{ type: "text", text: "new start" }] }, { role: "toolResult", content: [pic] }, shot(10)], 1e6, dropped)!;
    assert.equal(moved.dropped, 1);
  });

  it("the same screenshot taken again is a new image: leaving out the old copy keeps the new one", () => {
    const pic = img(600);
    const same = () => ({ role: "toolResult", content: [{ type: "image", data: pic.data, mimeType: "image/png" }] });
    const r = trimImages([same(), same(), same()], 1000)!;
    assert.equal(r.dropped, 2);
    assert.equal((r.messages[2]!.content[0] as { type: string }).type, "image", "the newest copy is sent");
  });

  it("nothing to do: under budget, no images, or budget 0 (off)", () => {
    const messages = [{ role: "toolResult", content: [img(100)] }];
    assert.equal(trimImages(messages, 1000), null);
    assert.equal(trimImages([{ role: "user", content: "hi" }], 10), null);
    assert.equal(trimImages(messages, 0), null);
  });
});
