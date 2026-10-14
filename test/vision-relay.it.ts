import { describe, it } from "node:test";
import assert from "node:assert/strict";
import visionRelayExt from "../extensions/vision-relay/index";
import { createHarness, reply, writeProjectConfig } from "./harness";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("vision relay", () => {
  it("describes a pasted image with a vision model for a text-only session", async () => {
    const h = await createHarness({
      extensions: [visionRelayExt],
      extraModels: [{ id: "eyes", input: ["text", "image"] }],
    });
    try {
      const seen: string[] = [];
      h.faux.setResponses([
        (context, _opts, _state, model) => {
          seen.push(`${model.id}:${JSON.stringify(context.messages.at(-1)?.content)}`);
          return reply("SCREEN: login page\nMATCHES: no — button clipped\nBLANK: no\nPROBLEMS: submit button clipped\nDETAILS: -");
        },
        (context, _opts, _state, model) => {
          seen.push(`${model.id}:${JSON.stringify(context.messages.at(-1)?.content)}`);
          return reply("I will fix the clipped submit button.");
        },
      ]);
      await h.session.prompt("why is the submit button cut off?", {
        images: [{ type: "image", mimeType: "image/png", data: PIXEL }],
      });
      assert.equal(seen.length, 2);
      assert.match(seen[0]!, /^eyes:/, "first call goes to the vision model");
      assert.match(seen[0]!, /why is the submit button cut off/, "captioner sees what the user asked");
      assert.match(seen[1]!, /^small:/);
      assert.match(seen[1]!, /submit button clipped/, "session model gets the description");
      assert.doesNotMatch(seen[1]!, /"type":"image"/, "text-only model gets no image parts");
    } finally {
      h.dispose();
    }
  });

  it("tells a text-only model to ask the user when no relay is available", async () => {
    const h = await createHarness({ extensions: [visionRelayExt] });
    try {
      writeProjectConfig(h.cwd, "vision.config.json", { relayModel: "faux/missing" });
      let seen = "";
      h.faux.setResponses([
        (context) => {
          seen = JSON.stringify(context.messages.at(-1)?.content);
          return reply("What does the image show?");
        },
      ]);
      await h.session.prompt("what is wrong here?", {
        images: [{ type: "image", mimeType: "image/png", data: PIXEL }],
      });
      assert.match(seen, /Ask the user to describe what the image shows/);
      assert.doesNotMatch(seen, /confirm_visual_qa/, "no QA checklist for a pasted image");
    } finally {
      h.dispose();
    }
  });
});

