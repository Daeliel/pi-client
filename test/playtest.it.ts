import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import verifyExt from "../extensions/verify/index";
import scenariosExt from "../extensions/scenarios/index";
import planExt from "../extensions/plan/index";
import onceExt from "../extensions/once/index";
import playtestExt, { GOOD, NOT_RIGHT } from "../extensions/playtest/index";
import { setPlaytestSession } from "../extensions/shared/playtest";
import { APP_VERIFY_CONFIG, call, createHarness, NODE_SCENARIOS_CONFIG, reply, seenBy, writeProjectConfig } from "./harness";

const HANDOVER = { did: ["a.app now says broken"], tryIt: ["open a.app"], watchFor: ["the word may be wrong"] };

function gated(cwd: string) {
  writeProjectConfig(cwd, "verify.config.json", APP_VERIFY_CONFIG);
  writeProjectConfig(cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
}

describe("playtest mode", () => {
  it("no gates, no checking tools: the model builds, hands over, and the user's Good settles it", async () => {
    const asked: string[] = [];
    const notes: string[] = [];
    const h = await createHarness({
      extensions: [verifyExt, scenariosExt, playtestExt],
      ui: {
        select: (async (title: string) => (asked.push(title), GOOD)) as never,
        notify: ((m: string) => void notes.push(m)) as never,
      },
    });
    try {
      gated(h.cwd);
      await h.session.prompt("/playtest on");
      let seen = { tools: [] as string[], systemPrompt: "" };
      h.faux.setResponses([
        (context) => {
          seen = seenBy(context);
          return call("write", { path: "a.app", content: "broken" });
        },
        call("hand_over", HANDOVER),
        reply("Handed over — try it."),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app say something");
      await h.settle();
      assert.ok(seen.tools.includes("hand_over"));
      for (const t of ["verify", "run_scenarios", "define_scenarios", "light_change"]) assert.ok(!seen.tools.includes(t), t);
      assert.match(seen.systemPrompt, /## Playtest mode/);
      assert.doesNotMatch(seen.systemPrompt, /Acceptance scenarios \(prove behaviour\)/);
      assert.deepEqual(h.userMessages(), ["make a.app say something"], "no gate follow-ups (a.app would fail verify)");
      assert.match(asked[0]!, /Ready to test\n\nWhat I did:\n- a\.app now says broken\n\nTry it:\n1\. open a\.app\n\nWatch for:\n- the word may be wrong/);
      assert.ok(notes.some((n) => /Completed — tested by you/.test(n)));
      assert.equal(h.faux.getPendingResponseCount(), 1);
    } finally {
      setPlaytestSession(false);
      h.dispose();
    }
  });

  it("not right: the user's note is the next task; built without a handover, the model is asked once", async () => {
    const answers = [NOT_RIGHT, GOOD];
    const h = await createHarness({
      extensions: [playtestExt],
      ui: {
        select: (async () => answers.shift()) as never,
        input: (async () => "it doesn't even start") as never,
      },
    });
    try {
      await h.session.prompt("/playtest on");
      h.faux.setResponses([
        call("write", { path: "a.app", content: "v1" }),
        reply("done"), // forgot to hand over
        call("hand_over", HANDOVER),
        reply("try it"),
        call("write", { path: "a.app", content: "v2" }),
        call("hand_over", { ...HANDOVER, did: ["it starts now"] }),
        reply("try again"),
        reply("unused"),
      ]);
      await h.session.prompt("build a.app");
      await h.settle();
      const msgs = h.userMessages();
      assert.equal(msgs.filter((m) => /did not hand over/.test(m)).length, 1);
      assert.ok(msgs.some((m) => m.startsWith("I tested it — not right yet: it doesn't even start")));
      assert.equal(answers.length, 0, "asked twice: after each handover");
      assert.equal(fs.readFileSync(path.join(h.cwd, "a.app"), "utf8"), "v2");
    } finally {
      setPlaytestSession(false);
      h.dispose();
    }
  });

  it("/once playtest lasts until Good; then the gates and their tools are back. Good ticks the plan item", async () => {
    const h = await createHarness({
      extensions: [verifyExt, scenariosExt, planExt, onceExt, playtestExt],
      ui: { select: (async () => GOOD) as never },
    });
    try {
      gated(h.cwd);
      fs.mkdirSync(path.join(h.cwd, ".pi/blueprint"), { recursive: true });
      const bpFile = path.join(h.cwd, ".pi/blueprint/BLUEPRINT.md");
      fs.writeFileSync(bpFile, "# Blueprint: app\n\nGoal: x\n\n## v1\n- [ ] **R-01** a.app exists · proves: verify\n");
      const tools: string[][] = [];
      h.faux.setResponses([
        (context) => {
          tools.push(seenBy(context).tools);
          return call("plan_item", { id: "R-01" });
        },
        call("write", { path: "a.app", content: "broken" }),
        call("hand_over", HANDOVER),
        reply("try it"),
        (context) => {
          tools.push(seenBy(context).tools);
          return reply("hello");
        },
      ]);
      await h.session.prompt("/once playtest build R-01");
      await h.settle();
      assert.ok(!tools[0]!.includes("verify") && tools[0]!.includes("hand_over"));
      assert.match(fs.readFileSync(bpFile, "utf8"), /- \[x\] \*\*R-01\*\*.*tested by user/);
      await h.session.prompt("hi");
      const order = h.session.messages.map((m) =>
        m.role === "custom" ? "verdict" : m.role === "user" ? JSON.stringify(m.content) : m.role,
      );
      const verdict = order.indexOf("verdict");
      const next = order.findIndex((m) => m.includes('"hi"'));
      assert.ok(verdict >= 0 && verdict < next, `the verdict sits before the next request: ${order.join(" | ")}`);
      assert.ok(tools[1]!.includes("verify"), "verify's tool is given back");
      assert.ok(tools[1]!.includes("run_scenarios"));
      assert.ok(!tools[1]!.includes("hand_over"));
    } finally {
      setPlaytestSession(false);
      h.dispose();
    }
  });
});
