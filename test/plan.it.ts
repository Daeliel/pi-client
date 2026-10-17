import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import planExt from "../extensions/plan/index";
import scenariosExt from "../extensions/scenarios/index";
import verifyExt from "../extensions/verify/index";
import { addSource } from "../extensions/plan/sources";
import { APP_SCENARIO_SCRIPT, APP_VERIFY_CONFIG, call, createHarness, NODE_SCENARIOS_CONFIG, reply, seenBy, writeProjectConfig } from "./harness";

const BLUEPRINT = ".pi/blueprint/BLUEPRINT.md";
const REQUEST = "Make a.app say fixed, and make b.app record the second step.";

const BP = `# Blueprint: app

Goal: a.app says fixed; b.app records the second step
Bar: spec

## Walkthrough
### M-01 Check the files
- Situation: two files
- Decision: none
- Needs to see: both files
- Does: opens them
- Feedback: the words are there
- Then: done
- Turns off: nothing

## v1
- [ ] **R-01** a.app contains the word fixed when opened · serves: S-01 · moment: M-01 · proves: verify
- [ ] **R-02** b.app records that the second step is done · serves: S-02 · proves: verify
- [ ] **R-03** The app-fixed scenario proves the fix end to end · serves: S-01 · proves: app-fixed.js
`;

function seed(cwd: string) {
  fs.mkdirSync(path.join(cwd, ".pi/blueprint"), { recursive: true });
  fs.writeFileSync(path.join(cwd, BLUEPRINT), BP);
  addSource(cwd, BLUEPRINT, { text: REQUEST });
  fs.writeFileSync(path.join(cwd, ".pi/blueprint/POINTS.md"), `- S-01 (SRC-1) "Make a.app say fixed"\n- S-02 (SRC-1) "make b.app record the second step"\n`);
}

const bp = (cwd: string) => fs.readFileSync(path.join(cwd, BLUEPRINT), "utf8");

describe("plan in normal development", () => {
  it("the plan is in every prompt; plan_item gives the moment and the source's words; a green verify ticks only that item", async () => {
    const h = await createHarness({ extensions: [verifyExt, planExt] });
    try {
      writeProjectConfig(h.cwd, "verify.config.json", APP_VERIFY_CONFIG);
      seed(h.cwd);
      let system = "";
      h.faux.setResponses([
        (context) => {
          system = seenBy(context).systemPrompt;
          return call("plan_item", { id: "R-01" });
        },
        call("write", { path: "a.app", content: "fixed" }),
        reply("R-01 built"),
        reply("unused"),
      ]);
      await h.session.prompt("build the next item");
      assert.match(system, /## Plan\nThis project has a plan: \.pi\/blueprint\/BLUEPRINT\.md — a\.app says fixed/);
      assert.match(system, /Moments: M-01 Check the files 0\/1/);
      assert.match(system, /Next open: R-01 /);
      const item = JSON.stringify(h.session.messages);
      assert.match(item, /Moment M-01 Check the files/);
      assert.match(item, /S-01: \\"Make a\.app say fixed\\"/);
      assert.match(bp(h.cwd), /- \[x\] \*\*R-01\*\*/, "verify passed after plan_item R-01");
      assert.match(bp(h.cwd), /- \[ \] \*\*R-02\*\*/, "a green suite alone does not tick an item nobody built");
    } finally {
      h.dispose();
    }
  });

  it("a passing spec ticks the item it proves", async () => {
    const h = await createHarness({ extensions: [scenariosExt, planExt] });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
      seed(h.cwd);
      const scenario = { id: "app-fixed", title: "a.app says fixed", steps: "Given a.app, then fixed", testFile: ".pi/scenarios/app-fixed.js", kind: "script" };
      h.faux.setResponses([
        call("define_scenarios", { scenarios: [scenario] }),
        call("write", { path: scenario.testFile, content: APP_SCENARIO_SCRIPT }),
        call("write", { path: "a.app", content: "fixed" }),
        reply("done"),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app");
      assert.match(bp(h.cwd), /- \[x\] \*\*R-03\*\*/);
    } finally {
      h.dispose();
    }
  });

  it("a moment whose items are all built is checked: the model narrates, a look that sees only the screenshot answers", async () => {
    const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const h = await createHarness({
      extensions: [scenariosExt, planExt],
      extraModels: [{ id: "eyes", input: ["text", "image"] }],
      files: { "shot.png": Buffer.from(PIXEL, "base64").toString("latin1") },
    });
    try {
      fs.writeFileSync(path.join(h.cwd, "shot.png"), Buffer.from(PIXEL, "base64"));
      writeProjectConfig(h.cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
      seed(h.cwd);
      // only R-03 belongs to the moment here, proven by the scenario below
      const text = bp(h.cwd)
        .replace("· serves: S-01 · moment: M-01 · proves: verify", "· serves: S-01 · proves: verify")
        .replace("· serves: S-01 · proves: app-fixed.js", "· serves: S-01 · moment: M-01 · proves: app-fixed.js");
      fs.writeFileSync(path.join(h.cwd, BLUEPRINT), text);
      const scenario = { id: "app-fixed", title: "a.app says fixed", steps: "Given a.app, then fixed", testFile: ".pi/scenarios/app-fixed.js", kind: "script" };
      let eyesSaw = "";
      h.faux.setResponses([
        call("define_scenarios", { scenarios: [scenario] }),
        call("write", { path: scenario.testFile, content: APP_SCENARIO_SCRIPT }),
        call("write", { path: "a.app", content: "fixed" }),
        reply("done"),
        call("moment_check", { moment: "M-01", narration: "both files open; a.app says fixed", differences: ["b.app shows nothing yet"], screenshot: "shot.png" }),
        (context, _opts, _state, model) => {
          eyesSaw = `${model.id}:${JSON.stringify(context.messages.at(-1)?.content)}`;
          return reply("1. cannot tell\n2. cannot tell\n3. opening a file");
        },
        reply("added items for the gaps"),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app");
      await h.settle();

      assert.equal(h.userMessages().filter((m) => m.startsWith("MOMENT CHECK M-01 Check the files")).length, 1);
      assert.match(eyesSaw, /^eyes:/, "the screen look went to a model that sees images");
      assert.match(eyesSaw, /"type":"image"/);
      assert.match(eyesSaw, /Can you see both files\?/);
      assert.doesNotMatch(eyesSaw, /a\.app says fixed|narration|Situation/, "it sees the screen and the questions — nothing else");
      assert.match(JSON.stringify(h.session.messages), /Answers \(seeing only the screen\)/);
      const checks = JSON.parse(fs.readFileSync(path.join(h.cwd, ".pi/blueprint/checks.json"), "utf8"));
      assert.equal(checks["M-01"].state, "done");
      assert.equal(checks["M-01"].screen, "answered");
      assert.equal(h.faux.getPendingResponseCount(), 1);
    } finally {
      h.dispose();
    }
  });

  it("long sources get a fresh read: what it finds that the points lack is reported, not invented quotes", async () => {
    const h = await createHarness({ extensions: [planExt] });
    try {
      seed(h.cwd);
      // a long design doc (over the 1,500-word line) with one rule the points will miss
      const filler = Array.from({ length: 220 }, (_, i) => `Paragraph ${i} describes the setting in some detail.`).join("\n\n");
      fs.writeFileSync(path.join(h.cwd, "DESIGN.md"), `${filler}\n\nRearranging wagons only happens at crane yards.\n`);
      addSource(h.cwd, BLUEPRINT, { file: "DESIGN.md" });
      const freshAsks: string[] = [];
      const freshRead = (context: { messages: Array<{ content: unknown }> }) => {
        freshAsks.push(JSON.stringify(context.messages.at(-1)?.content));
        return reply('- "Rearranging wagons only happens at crane yards."\n- "Wagons can teleport anywhere."');
      };
      h.faux.setResponses([
        call("blueprint_check", {}),
        freshRead as never,
        freshRead as never,
        reply("will add the missing point"),
        reply("unused"),
      ]);
      await h.session.prompt("check the plan");
      assert.equal(freshAsks.length, 2, "a ~1,700-word doc is read in two sections");
      assert.doesNotMatch(freshAsks.join(), /Blueprint|POINTS|S-01/, "the fresh read sees only the source");
      const result = JSON.stringify(h.session.messages);
      assert.match(result, /A fresh read of the sources found 1 statement\(s\) POINTS\.md does not have/);
      assert.match(result, /crane yards/);
      assert.doesNotMatch(result, /teleport/, "a quote that is not in the source is dropped");
    } finally {
      h.dispose();
    }
  });

  it("propose_plan: offered when there is no plan; declined, it is never offered again in this project", async () => {
    const h = await createHarness({ extensions: [planExt], ui: { confirm: (async () => false) as never } });
    try {
      const seen: string[][] = [];
      h.faux.setResponses([
        (context) => {
          seen.push(seenBy(context).tools);
          return call("propose_plan", { reason: "a whole game from a design doc" });
        },
        reply("ok, no plan"),
        (context) => {
          seen.push(seenBy(context).tools);
          return reply("next");
        },
      ]);
      await h.session.prompt("build the game in DESIGN.md");
      await h.session.prompt("go on");
      assert.ok(seen[0]!.includes("propose_plan"));
      assert.ok(!seen[1]!.includes("propose_plan"));
      assert.match(JSON.stringify(h.session.messages), /declined a plan for this project/);
      const saved = JSON.parse(fs.readFileSync(path.join(h.cwd, ".pi/plan.config.json"), "utf8"));
      assert.equal(saved.offerDeclined, true);
    } finally {
      h.dispose();
    }
  });
});
