import { describe, it } from "node:test";
import assert from "node:assert/strict";
import antiLoopExt from "../extensions/anti-loop/index";
import { call, createHarness, fauxAssistantMessage, reply } from "./harness";

const truncated = (text = "Let me think about this very long plan") =>
  fauxAssistantMessage(text, { stopReason: "length" });

describe("anti-loop", () => {
  it("hard-stops a model that keeps getting truncated", async () => {
    const h = await createHarness({ extensions: [antiLoopExt] });
    try {
      h.faux.setResponses([truncated(), truncated(), truncated(), truncated(), truncated(), truncated()]);
      await h.session.prompt("do the thing");
      // 1 original + maxRecoveries (2) continuations, then the hard stop.
      assert.equal(h.calls(), 3);
    } finally {
      h.dispose();
    }
  });

  it("blocks the same read repeated without edits, even when calls alternate", async () => {
    const h = await createHarness({
      extensions: [antiLoopExt],
      files: { "a.js": "a", "b.js": "b" },
    });
    try {
      h.faux.setResponses([
        call("read", { path: "a.js" }),
        call("read", { path: "b.js" }),
        call("read", { path: "a.js" }),
        call("read", { path: "b.js" }),
        call("read", { path: "a.js" }),
        reply("ok"),
        reply("ok"),
        reply("ok"),
      ]);
      await h.session.prompt("look around");
      const toolResults = h.session.messages.filter((m) => m.role === "toolResult");
      const blocked = toolResults.filter((m) => JSON.stringify(m.content).includes("ANTI-LOOP"));
      assert.equal(blocked.length, 1, "third identical read of a.js should be blocked");
    } finally {
      h.dispose();
    }
  });

  it("does not hard-stop when each recovery is followed by real progress", async () => {
    const h = await createHarness({ extensions: [antiLoopExt] });
    try {
      h.faux.setResponses([
        truncated(),
        call("write", { path: "one.js", content: "1" }),
        truncated(),
        call("write", { path: "two.js", content: "2" }),
        truncated(),
        call("write", { path: "three.js", content: "3" }),
        reply("done"),
      ]);
      await h.session.prompt("write three files");
      assert.equal(h.faux.getPendingResponseCount(), 0, "all scripted steps should run");
    } finally {
      h.dispose();
    }
  });
});
