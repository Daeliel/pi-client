import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import visionExt from "../extensions/vision-relay/index";
import { call, createHarness, reply, writeProjectConfig } from "./harness";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A tool that returns one screenshot, like a scenario run with vision on failure. */
function shotExt(pi: ExtensionAPI) {
  pi.registerTool({
    name: "shot",
    label: "Shot",
    description: "Take a screenshot.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "screenshot:" }, { type: "image", data: PIXEL, mimeType: "image/png" }], details: {} };
    },
  });
}

const WEBP = "UklGRiAAAABXRUJQVlA4TBMAAAAvA4AAAA8Q87//8x8OfvAQ0f8YAA==";

/** A tool that returns a WebP picture, as a .webp file read would. */
function webpExt(pi: ExtensionAPI) {
  pi.registerTool({
    name: "webp",
    label: "WebP",
    description: "Show a WebP picture.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "image", data: WEBP, mimeType: "image/webp" }], details: {} };
    },
  });
}

describe("webp in a request", () => {
  it("goes to the model as PNG; the session keeps the WebP", async () => {
    const h = await createHarness({
      extensions: [webpExt, visionExt],
      input: ["text", "image"],
    });
    try {
      let sent = "";
      h.faux.setResponses([
        call("webp", {}),
        (context) => {
          sent = JSON.stringify(context.messages);
          return reply("done");
        },
      ]);
      await h.session.prompt("show it");
      assert.match(sent, /"mimeType":"image\/png"/);
      assert.doesNotMatch(sent, /image\/webp/);
      assert.match(JSON.stringify(h.session.messages), /image\/webp/, "the session file keeps the original");
    } finally {
      h.dispose();
    }
  });
});

describe("image budget per request", () => {
  it("older screenshots are left out in one batch once the budget is reached, and what was sent stays the same", async () => {
    const notes: string[] = [];
    const h = await createHarness({
      extensions: [shotExt, visionExt],
      extraModels: [{ id: "eyes", input: ["text", "image"] }],
      ui: { notify: ((m: string) => void notes.push(m)) as never },
    });
    try {
      // room for four of these screenshots
      writeProjectConfig(h.cwd, "vision.config.json", { maxImageBytesPerRequest: PIXEL.length * 4 });
      const requests: unknown[][] = [];
      const take = (context: { messages: unknown[] }) => void requests.push(JSON.parse(JSON.stringify(context.messages)));
      h.faux.setResponses([
        ...Array.from({ length: 6 }, () => (context: { messages: unknown[] }) => (take(context), call("shot", {}))),
        (context: { messages: unknown[] }) => (take(context), reply("done")),
      ] as never);
      await h.session.prompt("look six times");
      const images = (r: unknown[]) => JSON.stringify(r).split('"type":"image"').length - 1;
      // Request 6 carries five screenshots: over four, so the three oldest go at once.
      assert.equal(images(requests[5]!), 2);
      assert.equal(images(requests[6]!), 3, "the next screenshot drops nothing more");
      const sentBefore = JSON.stringify(requests[5]!);
      assert.equal(JSON.stringify(requests[6]!.slice(0, requests[5]!.length)), sentBefore, "everything already sent is unchanged");
      assert.equal(JSON.stringify(h.session.messages).split('"type":"image"').length - 1, 6, "the session keeps all six");
      assert.equal(notes.filter((n) => /Left 3 older image\(s\) out of the request/.test(n)).length, 1);
    } finally {
      h.dispose();
    }
  });
});
