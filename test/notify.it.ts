import { describe, it } from "node:test";
import assert from "node:assert/strict";
import notifyExt, { doneMessage, SETTLE_GRACE_MS, setSender, toastScript } from "../extensions/notify/index";
import playtestExt, { GOOD } from "../extensions/playtest/index";
import { setPlaytestSession } from "../extensions/shared/playtest";
import { call, createHarness, reply, writeProjectConfig } from "./harness";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function catchNotes(): Array<{ title: string; body: string }> {
  const sent: Array<{ title: string; body: string }> = [];
  setSender((title, body) => void sent.push({ title, body }));
  return sent;
}

describe("notify", () => {
  it("a long run that ends says what it did; a short one stays quiet", async () => {
    const sent = catchNotes();
    const h = await createHarness({ extensions: [notifyExt], ui: {} });
    try {
      writeProjectConfig(h.cwd, "notify.config.json", { minSeconds: 0 });
      h.faux.setResponses([reply("Renamed the save button.\n\nIt now reads Save game."), reply("Should the old saves be kept?")]);
      await h.session.prompt("rename the save button");
      await h.settle();
      await wait(SETTLE_GRACE_MS + 200);
      assert.equal(sent.length, 1);
      assert.match(sent[0]!.title, /^Pi · /);
      assert.equal(sent[0]!.body, "Done: Renamed the save button.");
      await h.session.prompt("and the saves?");
      await h.settle();
      await wait(SETTLE_GRACE_MS + 200);
      assert.equal(sent[1]!.body, "Has a question: Should the old saves be kept?");

      writeProjectConfig(h.cwd, "notify.config.json", { minSeconds: 60 });
      h.faux.setResponses([reply("ok")]);
      await h.session.prompt("thanks");
      await h.settle();
      await wait(SETTLE_GRACE_MS + 200);
      assert.equal(sent.length, 2, "a short run ends quietly");
    } finally {
      setSender(null);
      h.dispose();
    }
  });

  for (const order of ["notify first", "playtest first"]) {
    it(`a run that ends in a dialog: one notification, naming it (${order})`, async () => {
      const sent = catchNotes();
      const exts = order === "notify first" ? [notifyExt, playtestExt] : [playtestExt, notifyExt];
      const h = await createHarness({
        extensions: exts,
        ui: { select: (async () => (await wait(50), GOOD)) as never },
      });
      try {
        writeProjectConfig(h.cwd, "notify.config.json", { minSeconds: 0 });
        await h.session.prompt("/playtest on");
        h.faux.setResponses([
          call("write", { path: "a.app", content: "v1" }),
          call("hand_over", { did: ["a.app exists"], tryIt: ["open a.app"], watchFor: [] }),
          reply("Handed over."),
          reply("unused"),
        ]);
        await h.session.prompt("build a.app");
        await h.settle();
        await wait(SETTLE_GRACE_MS + 200);
        assert.deepEqual(
          sent.map((s) => s.body),
          ["Waiting for you: Ready to test"],
        );
      } finally {
        setPlaytestSession(false);
        setSender(null);
        h.dispose();
      }
    });
  }

  it("what a finished run comes down to", () => {
    assert.equal(doneMessage({ text: "", error: "429 rate limited" }, "none"), "Stopped with an error: 429 rate limited");
    assert.match(doneMessage({ text: "R-03 done" }, "ended"), /^Autopilot run ended/);
    assert.match(doneMessage({ text: "stuck" }, "running"), /^Autopilot stopped and is waiting/);
    assert.equal(doneMessage({ text: "## Summary\n- fixed it" }, "none"), "Done: Summary");
    assert.equal(doneMessage(null, "none"), "Done — ready for you.");
    assert.ok(doneMessage({ text: "x".repeat(300) }, "none").length <= 120);
  });

  it("the toast script survives quotes in the text and uses an app id Windows shows", () => {
    const s = toastScript("Pi · it's", "Done: don't panic");
    assert.match(s, /CreateTextNode\('Pi · it''s'\)/);
    assert.match(s, /CreateTextNode\('Done: don''t panic'\)/);
    assert.match(s, /CreateToastNotifier\('\{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7\}\\WindowsPowerShell\\v1\.0\\powershell\.exe'\)/);
  });
});
