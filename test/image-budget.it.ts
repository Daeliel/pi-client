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

describe("image budget per request", () => {
  it("older screenshots are left out of what is sent once the budget is reached; the session keeps them", async () => {
    const notes: string[] = [];
    const h = await createHarness({
      extensions: [shotExt, visionExt],
      extraModels: [{ id: "eyes", input: ["text", "image"] }],
      ui: { notify: ((m: string) => void notes.push(m)) as never },
    });
    try {
      // room for two of these screenshots
      writeProjectConfig(h.cwd, "vision.config.json", { maxImageBytesPerRequest: PIXEL.length * 2 });
      let sent = "";
      h.faux.setResponses([
        call("shot", {}),
        call("shot", {}),
        call("shot", {}),
        (context) => {
          sent = JSON.stringify(context.messages);
          return reply("done");
        },
      ]);
      await h.session.prompt("look three times");
      assert.equal(sent.split('"type":"image"').length - 1, 2, "the two newest are sent");
      assert.match(sent, /older image left out of this request/);
      assert.equal(JSON.stringify(h.session.messages).split('"type":"image"').length - 1, 3, "the session keeps all three");
      assert.equal(notes.filter((n) => /Left 1 older image\(s\) out of the request/.test(n)).length, 1);
    } finally {
      h.dispose();
    }
  });
});
