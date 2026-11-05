import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decode as decodePng } from "fast-png";
import { UNREADABLE_WEBP, convertWebpImages, isWebp, pngPart, webpToPng } from "./webp-to-png.ts";

/** 4x3 lossless WebP: red, with one blue pixel at the bottom right. */
const WEBP = "UklGRiAAAABXRUJQVlA4TBMAAAAvA4AAAA8Q87//8x8OfvAQ0f8YAA==";
const PNG_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("webp to png", () => {
  it("recognises WebP by its type or by its bytes", () => {
    assert.equal(isWebp({ mimeType: "image/webp", data: "" }), true);
    assert.equal(isWebp({ mimeType: "image/png", data: WEBP }), true, "a mislabelled WebP is still caught");
    assert.equal(isWebp({ mimeType: "image/png", data: PNG_PIXEL }), false);
  });

  it("turns a WebP into a PNG with the same pixels", async () => {
    const png = await webpToPng(WEBP);
    assert.ok(png);
    const image = decodePng(Buffer.from(png!, "base64"));
    assert.deepEqual([image.width, image.height], [4, 3]);
    const px = (x: number, y: number) => Array.from(image.data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
    assert.deepEqual(px(0, 0), [255, 0, 0, 255]);
    assert.deepEqual(px(3, 2), [0, 0, 255, 255]);
  });

  it("converts every WebP in the conversation and leaves the rest as they are", async () => {
    const pngMsg = { role: "toolResult", content: [{ type: "image", mimeType: "image/png", data: PNG_PIXEL }] };
    const messages = [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/webp", data: WEBP }] },
      pngMsg,
      { role: "assistant", content: "ok" },
    ];
    const r = (await convertWebpImages(messages))!;
    assert.equal(r.converted, 1);
    const part = (r.messages[0]!.content as { type: string; mimeType?: string }[])[1]!;
    assert.equal(part.mimeType, "image/png");
    assert.equal(r.messages[1], pngMsg, "a message without WebP is the same object");
    assert.equal((messages[0]!.content as { mimeType?: string }[])[1]!.mimeType, "image/webp", "the session keeps the original");
    assert.equal(await convertWebpImages([pngMsg]), null);
  });

  it("a WebP that cannot be decoded becomes a note instead of breaking the request", async () => {
    const out = await pngPart({ type: "image", mimeType: "image/webp", data: "UklGRiAAAABXRUJQnotreally" });
    assert.deepEqual(out, { type: "text", text: UNREADABLE_WEBP });
  });

  it("the same picture is converted once", async () => {
    const t0 = performance.now();
    await webpToPng(WEBP);
    assert.ok(performance.now() - t0 < 5, "the second time is a lookup");
  });
});
