import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import autopilotExt from "../extensions/autopilot/index";
import planExt from "../extensions/plan/index";
import { addSource } from "../extensions/plan/sources";
import { APP_VERIFY_CONFIG, call, createHarness, reply, seenBy, writeProjectConfig } from "./harness";

const BLUEPRINT = ".pi/blueprint/BLUEPRINT.md";
const POINTS_FILE = ".pi/blueprint/POINTS.md";

/** The user's request, word for word — the plan's source. */
const REQUEST = "Make a.app say fixed, and make b.app record the second step.";
const POINTS = `- S-01 (SRC-1) "Make a.app say fixed"
- S-02 (SRC-1) "make b.app record the second step"
`;

/** Register the request as SRC-1 and its points, as a model following the procedure would. */
function seedSources(cwd: string) {
  addSource(cwd, BLUEPRINT, { text: REQUEST });
  fs.writeFileSync(path.join(cwd, POINTS_FILE), POINTS);
}

const BP = `# Blueprint: app

Goal: make a.app say fixed and b.app record the second step.
Bar: spec

## v1
- [ ] **R-01** a.app contains the word fixed when opened · serves: S-01 · proves: verify
- [ ] **R-02** b.app records that the second step is done · serves: S-02 · proves: verify
`;

/** UI that approves: Start, no time limit; confirms everything (git init, rollback). */
function approvingUi(log: string[] = []) {
  return {
    select: (async (title: string, options: string[]) => {
      log.push(title.split("\n")[0]!);
      if (title.startsWith("Autopilot")) return "Start";
      if (title === "Time budget") return "No time limit";
      return options[0];
    }) as never,
    confirm: (async (title: string) => {
      log.push(title);
      return true;
    }) as never,
  };
}

const startsWith = (msgs: string[], prefix: string) => msgs.filter((m) => m.startsWith(prefix)).length;

function readBp(cwd: string): string {
  return fs.readFileSync(path.join(cwd, BLUEPRINT), "utf8");
}

describe("autopilot", () => {
  it("writes a blueprint, asks once, builds item by item from evidence, and ignores ticked boxes", async () => {
    const dialogs: string[] = [];
    const h = await createHarness({ extensions: [planExt, autopilotExt], ui: approvingUi(dialogs) });
    try {
      writeProjectConfig(h.cwd, "verify.config.json", APP_VERIFY_CONFIG);
      writeProjectConfig(h.cwd, "autopilot.config.json", { checkpoints: false });
      const tampered = BP.replace("- [ ] **R-01**", "- [~] **R-01**").replace("- [ ] **R-02**", "- [x] **R-02**");
      h.faux.setResponses([
        call("start_autopilot", { goal: "app" }), // no blueprint yet -> procedure
        call("add_source", { text: REQUEST }),
        call("write", { path: POINTS_FILE, content: POINTS }),
        call("write", { path: BLUEPRINT, content: BP }),
        call("blueprint_check", {}),
        call("start_autopilot", { goal: "app" }), // approved -> brief for R-01
        call("write", { path: "a.app", content: "fixed" }),
        call("write", { path: BLUEPRINT, content: tampered }), // tries to tick R-02 itself
        reply("R-01 done"),
        call("write", { path: "b.app", content: "done" }),
        reply("R-02 done"),
        reply("unused"),
      ]);
      await h.session.prompt("build the app to spec and come back when it's all done");
      await h.settle();

      const users = h.userMessages();
      assert.equal(dialogs.filter((d) => d.startsWith("Autopilot")).length, 1, "one approval dialog");
      assert.equal(startsWith(users, "AUTOPILOT — next item R-02"), 1, "R-02 was built after all — the ticked box was reverted");
      const bp = readBp(h.cwd);
      assert.match(bp, /- \[x\] \*\*R-01\*\*/);
      assert.match(bp, /- \[x\] \*\*R-02\*\*/);
      const run = JSON.parse(fs.readFileSync(path.join(h.cwd, ".pi/blueprint/run.json"), "utf8"));
      assert.equal(run.status, "done");
      assert.equal(run.finished, 2);
      assert.equal(h.faux.getPendingResponseCount(), 1, "quiet once the scope is done");
    } finally {
      h.dispose();
    }
  });

  it("retries a failing item, blocks it at the attempt cap, and moves on", async () => {
    const h = await createHarness({ extensions: [planExt, autopilotExt], files: { [BLUEPRINT]: BP }, ui: approvingUi() });
    try {
      seedSources(h.cwd);
      writeProjectConfig(h.cwd, "verify.config.json", APP_VERIFY_CONFIG);
      writeProjectConfig(h.cwd, "autopilot.config.json", { checkpoints: false, itemAttempts: 2 });
      h.faux.setResponses([
        call("start_autopilot", { goal: "app" }),
        call("write", { path: "a.app", content: "broken" }),
        reply("done"),
        call("write", { path: "a.app", content: "still broken" }),
        reply("done"),
        // R-01 blocked; R-02 is next — and its proof (same suite) fails too, but it gets its own attempts
        call("write", { path: "b.app", content: "done" }),
        reply("done"),
        call("write", { path: "b.app", content: "done again" }),
        reply("done"),
        reply("unused"),
      ]);
      await h.session.prompt("build it all, don't stop");
      await h.settle();

      const users = h.userMessages();
      assert.equal(startsWith(users, "AUTOPILOT — R-01 is not proven yet (attempt 2/2)"), 1);
      assert.equal(startsWith(users, "AUTOPILOT — next item R-02"), 1, "moved on after blocking R-01");
      const bp = readBp(h.cwd);
      assert.match(bp, /- \[!\] \*\*R-01\*\*.*· blocked: /);
      assert.match(bp, /- \[!\] \*\*R-02\*\*/);
      assert.equal(h.faux.getPendingResponseCount(), 1);
    } finally {
      h.dispose();
    }
  });

  it("'Don't offer again this session' hides the tool; a stop without edits is nudged, then paused", async () => {
    const h = await createHarness({
      extensions: [planExt, autopilotExt],
      files: { [BLUEPRINT]: BP },
      ui: {
        select: (async (title: string) => (title.startsWith("Autopilot") ? "Don't offer again this session" : undefined)) as never,
      },
    });
    try {
      seedSources(h.cwd);
      let toolsAfter: string[] = [];
      h.faux.setResponses([
        call("start_autopilot", { goal: "app" }),
        reply("ok, normal mode"),
        (context) => {
          toolsAfter = seenBy(context).tools;
          return reply("next");
        },
      ]);
      await h.session.prompt("just build everything");
      await h.session.prompt("now something else");
      assert.ok(!toolsAfter.includes("start_autopilot"), toolsAfter.join(", "));
    } finally {
      h.dispose();
    }

    const h2 = await createHarness({ extensions: [planExt, autopilotExt], files: { [BLUEPRINT]: BP }, ui: approvingUi() });
    try {
      seedSources(h2.cwd);
      writeProjectConfig(h2.cwd, "verify.config.json", APP_VERIFY_CONFIG);
      writeProjectConfig(h2.cwd, "autopilot.config.json", { checkpoints: false, stallStops: 2 });
      h2.faux.setResponses([
        call("start_autopilot", { goal: "app" }),
        reply("Which colour should the app use?"), // a question, no edits
        reply("Still thinking."), // second stop without edits -> paused
        reply("unused"),
      ]);
      await h2.session.prompt("build all of it");
      await h2.settle();
      const users = h2.userMessages();
      assert.equal(startsWith(users, "AUTOPILOT — you stopped without changing anything (1/2)"), 1);
      assert.match(users.find((m) => m.startsWith("AUTOPILOT — you stopped"))!, /choose what you would recommend/);
      const run = JSON.parse(fs.readFileSync(path.join(h2.cwd, ".pi/blueprint/run.json"), "utf8"));
      assert.equal(run.status, "paused");
      assert.match(run.stopReason, /no progress on R-01/);
      assert.equal(h2.faux.getPendingResponseCount(), 1);
    } finally {
      h2.dispose();
    }
  });

  it("an early 'done' is checked, deferring takes an item out of the run", async () => {
    const h = await createHarness({ extensions: [planExt, autopilotExt], files: { [BLUEPRINT]: BP }, ui: approvingUi() });
    try {
      seedSources(h.cwd);
      writeProjectConfig(h.cwd, "verify.config.json", APP_VERIFY_CONFIG);
      writeProjectConfig(h.cwd, "autopilot.config.json", { checkpoints: false });
      h.faux.setResponses([
        call("start_autopilot", { goal: "app" }),
        call("write", { path: "a.app", content: "fixed" }),
        call("finish_autopilot", {}), // R-02 still open
        call("defer_items", { ids: ["R-02"], reason: "needs a design decision" }),
        call("finish_autopilot", {}),
        reply("done"),
        reply("unused"),
      ]);
      await h.session.prompt("build it all");
      await h.settle();

      const transcript = JSON.stringify(h.session.messages);
      assert.match(transcript, /Not done yet — open in this run:\\n {2}\[ \] R-02/);
      const bp = readBp(h.cwd);
      assert.match(bp, /- \[x\] \*\*R-01\*\*/);
      assert.match(bp, /- \[-\] \*\*R-02\*\*.*· deferred: needs a design decision/);
      const run = JSON.parse(fs.readFileSync(path.join(h.cwd, ".pi/blueprint/run.json"), "utf8"));
      assert.equal(run.status, "done");
      assert.equal(h.faux.getPendingResponseCount(), 1);
    } finally {
      h.dispose();
    }
  });

  it("/blueprint writes a plan only; headless pi gets no autopilot unless config allows it", async () => {
    const h = await createHarness({ extensions: [planExt, autopilotExt], ui: {} });
    try {
      h.faux.setResponses([reply("blueprint written")]);
      await h.session.prompt("/blueprint a todo app with tags");
      await h.settle();
      const ask = h.userMessages().find((m) => m.startsWith("a todo app with tags"));
      assert.match(ask ?? "", /BLUEPRINT — write the plan to \.pi\/blueprint\/BLUEPRINT\.md/);
      assert.match(ask ?? "", /show the user the Reading and the Walkthrough/);
    } finally {
      h.dispose();
    }

    for (const headless of ["deny", "allow"] as const) {
      const hh = await createHarness({ extensions: [planExt, autopilotExt] }); // no UI = print mode
      try {
        writeProjectConfig(hh.cwd, "autopilot.config.json", { headless });
        let tools: string[] = [];
        hh.faux.setResponses([
          (context) => {
            tools = seenBy(context).tools;
            return reply("ok");
          },
        ]);
        await hh.session.prompt("build everything");
        assert.equal(tools.includes("start_autopilot"), headless === "allow", `${headless}: ${tools.join(", ")}`);
      } finally {
        hh.dispose();
      }
    }
  });

  it("product bar: one playtest before finishing; what it finds becomes items and gets built", async () => {
    const PRODUCT = BP.replace("Bar: spec", "Bar: product").replace(
      "\n## v1\n",
      `
## Reading
### Interpretations
### Additions

## Walkthrough
### M-01 Open the apps
- Situation: two files, a.app and b.app
- Decision: none — the person checks both say what they should
- Needs to see: the contents of both files
- Does: opens them
- Feedback: the words are there
- Then: done
- Turns off: nothing
### Forgotten moments
- First launch / orientation: M-01
- Learning the controls: n/a — no controls
- Waiting / idle: n/a
- Failure and its feedback: n/a
- Cancel / undo: n/a
- End of the loop and starting again: n/a
- Switching modes or stages: n/a — one screen
- Saving and coming back: n/a

## v1
`,
    ).replace("· serves: S-01 · proves: verify", "· serves: S-01 · moment: M-01 · proves: verify");
    const h = await createHarness({ extensions: [planExt, autopilotExt], files: { [BLUEPRINT]: PRODUCT }, ui: approvingUi() });
    try {
      seedSources(h.cwd);
      writeProjectConfig(h.cwd, "verify.config.json", APP_VERIFY_CONFIG);
      writeProjectConfig(h.cwd, "autopilot.config.json", { checkpoints: false });
      const withFinding = PRODUCT.replace("- [ ] **R-01**", "- [x] **R-01**").replace("- [ ] **R-02**", "- [x] **R-02**") +
        "- [ ] **R-03** c.app explains what the second step did, so a person understands it · serves: added · proves: verify\n";
      h.faux.setResponses([
        call("start_autopilot", { goal: "app" }),
        call("write", { path: "a.app", content: "fixed" }),
        reply("R-01 done"),
        // R-01 completes moment M-01: it is checked as a whole before the run moves on
        call("moment_check", { moment: "M-01", narration: "a.app opens and says fixed", differences: [] }),
        reply("M-01 checked"),
        call("write", { path: "b.app", content: "done" }),
        reply("R-02 done"),
        // playtest turn: the model finds a gap and adds it as an item
        call("write", { path: BLUEPRINT, content: withFinding }),
        reply("playtest: added R-03"),
        call("write", { path: "c.app", content: "explained" }),
        reply("R-03 done"),
        reply("unused"),
      ]);
      await h.session.prompt("build it to spec and come back when it's done");
      await h.settle();

      const users = h.userMessages();
      assert.equal(startsWith(users, "MOMENT CHECK M-01 Open the apps"), 1, "the completed moment was checked once");
      const checks = JSON.parse(fs.readFileSync(path.join(h.cwd, ".pi/blueprint/checks.json"), "utf8"));
      assert.equal(checks["M-01"].state, "done");
      assert.equal(startsWith(users, "AUTOPILOT — playtest before finishing (result bar: product)"), 1, "exactly one playtest");
      assert.equal(startsWith(users, "AUTOPILOT — next item R-03"), 1, "the finding was built");
      assert.match(readBp(h.cwd), /- \[x\] \*\*R-03\*\*/);
      const run = JSON.parse(fs.readFileSync(path.join(h.cwd, ".pi/blueprint/run.json"), "utf8"));
      assert.equal(run.status, "done");
      assert.equal(run.playtested, true);
      assert.equal(h.faux.getPendingResponseCount(), 1);
      const saved = JSON.parse(fs.readFileSync(path.join(h.cwd, ".pi/scenarios.config.json"), "utf8"));
      assert.equal(saved.bar, "product", "the blueprint's bar became the project's");
    } finally {
      h.dispose();
    }
  });

  it("checkpoints: offers git init, commits per item on its own branch, rolls back from an item", async () => {
    const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    const dialogs: string[] = [];
    const h = await createHarness({ extensions: [planExt, autopilotExt], files: { [BLUEPRINT]: BP }, ui: approvingUi(dialogs) });
    try {
      seedSources(h.cwd);
      writeProjectConfig(h.cwd, "verify.config.json", APP_VERIFY_CONFIG);
      h.faux.setResponses([
        call("start_autopilot", { goal: "app" }),
        call("write", { path: "a.app", content: "fixed" }),
        reply("R-01 done"),
        call("write", { path: "b.app", content: "done" }),
        reply("R-02 done"),
        reply("unused"),
      ]);
      await h.session.prompt("build it to spec, come back when done");
      await h.settle();

      const gitOut = (...args: string[]) => execFileSync("git", args, { cwd: h.cwd, encoding: "utf8" }).trim();
      assert.ok(dialogs.includes("Autopilot checkpoints"), "asked to git init");
      assert.equal(gitOut("rev-parse", "--abbrev-ref", "HEAD"), "autopilot/make-a-app-say-fixed-and-b-app-record");
      const log = gitOut("log", "--format=%s");
      assert.match(log, /^autopilot R-02: .*\nautopilot R-01: /);

      await h.session.prompt("/autopilot rollback R-02");
      assert.ok(dialogs.includes("Autopilot rollback"));
      assert.match(gitOut("log", "-1", "--format=%s"), /^autopilot R-01: /);
      assert.ok(!fs.existsSync(path.join(h.cwd, "b.app")), "R-02's work is undone");
      const bp = readBp(h.cwd);
      assert.match(bp, /- \[x\] \*\*R-01\*\*/);
      assert.match(bp, /- \[ \] \*\*R-02\*\*/);
    } finally {
      h.dispose();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
