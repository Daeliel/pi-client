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

describe("anti-loop user-help trigger", () => {
  it("lets ordinary mid-run steering through without aborting", async () => {
    const h = await createHarness({ extensions: [antiLoopExt], files: { "a.js": "a" } });
    try {
      let nextSystem = "";
      h.faux.setResponses([
        () => {
          void h.session.prompt("also make the button blue", { streamingBehavior: "steer" });
          return call("read", { path: "a.js" });
        },
        reply("done, and the button is blue"),
        (context) => {
          nextSystem = context.systemPrompt ?? "";
          return reply("next");
        },
      ]);
      await h.session.prompt("tweak the page");
      await h.settle();
      const aborted = h.session.messages.filter((m) => m.role === "assistant" && m.stopReason === "aborted");
      assert.equal(aborted.length, 0, "the in-flight response must not be aborted");
      assert.ok(h.userMessages().includes("also make the button blue"), "steer delivered");
      await h.session.prompt("next task");
      assert.doesNotMatch(nextSystem, /Anti-loop: user-help/, "no user-help for plain steering");
    } finally {
      h.dispose();
    }
  });

  it("diverts mid-run typing to user-help when the run is thrashing", async () => {
    const h = await createHarness({ extensions: [antiLoopExt], files: { "a.js": "a" } });
    try {
      let jumpIn = "";
      h.faux.setResponses([
        call("read", { path: "a.js" }),
        call("read", { path: "a.js" }),
        call("read", { path: "a.js" }), // blocked → recovery 1: the run is thrashing
        () => {
          void h.session.prompt("it breaks on the settings tab", { streamingBehavior: "steer" });
          return call("read", { path: "b.js" });
        },
        (context) => {
          jumpIn = JSON.stringify(context.messages.at(-1)?.content ?? "");
          return reply("Which button did you click?");
        },
        reply("unused"),
      ]);
      await h.session.prompt("fix the bug");
      await h.settle();
      assert.match(jumpIn, /it breaks on the settings tab/);
      assert.match(jumpIn, /ANTI-LOOP user-help/, "the reply to the jump-in message is in user-help mode");
    } finally {
      h.dispose();
    }
  });
});
