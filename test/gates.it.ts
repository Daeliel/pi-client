import { describe, it } from "node:test";
import assert from "node:assert/strict";
import verifyExt from "../extensions/verify/index";
import { call, createHarness, reply, APP_VERIFY_CONFIG, writeProjectConfig } from "./harness";

const verifyFollowUps = (msgs: string[]) => msgs.filter((m) => m.startsWith("Verification failed"));

describe("gate follow-ups re-arm on every run", () => {
  it("verify keeps firing until the checks pass", async () => {
    const h = await createHarness({ extensions: [verifyExt] });
    try {
      writeProjectConfig(h.cwd, "verify.config.json", APP_VERIFY_CONFIG);
      h.faux.setResponses([
        call("write", { path: "a.app", content: "broken" }),
        reply("done"),
        call("write", { path: "a.app", content: "still broken" }),
        reply("done again"),
        call("write", { path: "a.app", content: "fixed" }),
        reply("really done"),
      ]);
      await h.session.prompt("make a.app");
      assert.equal(verifyFollowUps(h.userMessages()).length, 2);
      assert.equal(h.faux.getPendingResponseCount(), 0, "model should have been asked to continue until green");
    } finally {
      h.dispose();
    }
  });

  it("verify gives up after maxFixAttempts", async () => {
    const h = await createHarness({ extensions: [verifyExt] });
    try {
      writeProjectConfig(h.cwd, "verify.config.json", { ...APP_VERIFY_CONFIG, maxFixAttempts: 2 });
      h.faux.setResponses([
        call("write", { path: "a.app", content: "broken" }),
        reply("done"),
        reply("still done"),
        reply("still done"),
        reply("never reached"),
      ]);
      await h.session.prompt("make a.app");
      const followUps = verifyFollowUps(h.userMessages());
      assert.equal(followUps.length, 2);
      assert.doesNotMatch(followUps[0]!, /SAME FAILURE/);
      assert.match(followUps[1]!, /SAME FAILURE/, "unchanged failure is called out");
      assert.match(followUps[1]!, /LAST ATTEMPT \(2\/2\)/);
      assert.equal(h.faux.getPendingResponseCount(), 1);

      // After giving up, the next turn is told the task is not done.
      let context = "";
      h.faux.setResponses([(c) => ((context = JSON.stringify(c.messages)), reply("It is still failing."))]);
      await h.session.prompt("is it done?");
      assert.match(context, /\[verify\] Still failing after 2 fix attempts/);
    } finally {
      h.dispose();
    }
  });
});
