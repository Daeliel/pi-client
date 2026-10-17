import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import scenariosExt from "../extensions/scenarios/index";
import { APP_SCENARIO_SCRIPT, call, createHarness, NODE_SCENARIOS_CONFIG, reply, seenBy, writeProjectConfig } from "./harness";

const HOW = ["open a.app", "it says fixed"];
const notifications = (list: string[]) => ({ notify: ((m: string) => void list.push(m)) as never });
const many = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

describe("light changes", () => {
  it("a small change the model calls light skips the specs; the user gets how to check it", async () => {
    const notes: string[] = [];
    const h = await createHarness({ extensions: [scenariosExt], files: { "a.app": "broken\n" }, ui: notifications(notes) });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
      let tools: string[] = [];
      let system = "";
      h.faux.setResponses([
        (context) => {
          tools = seenBy(context).tools;
          system = seenBy(context).systemPrompt;
          return call("light_change", { why: "one word", howToCheck: HOW });
        },
        call("write", { path: "a.app", content: "fixed\n" }),
        reply("done"),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app say fixed");
      assert.ok(tools.includes("light_change"));
      assert.match(system, /## Light changes[\s\S]*up to 30 changed lines, up to 3 files, no new files/);
      assert.match(JSON.stringify(h.session.messages), /Accepted as a light change/);
      assert.equal(h.userMessages().filter((m) => /no acceptance scenarios/.test(m)).length, 0, "no specs demanded");
      assert.match(notes.join("\n"), /Light change \(1 changed line in 1 file\) — specs not run\.\nNot verified by specs — how to check:\n1\. open a\.app/);
      assert.equal(h.faux.getPendingResponseCount(), 1);
    } finally {
      h.dispose();
    }
  });

  it("a change that grows past the limit runs the specs as usual", async () => {
    const notes: string[] = [];
    const h = await createHarness({ extensions: [scenariosExt], files: { "a.app": "broken\n" }, ui: notifications(notes) });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", { ...NODE_SCENARIOS_CONFIG, maxFixAttempts: 1 });
      h.faux.setResponses([
        call("light_change", { why: "small", howToCheck: HOW }),
        call("write", { path: "a.app", content: many(40) }),
        reply("done"),
        reply("stopping"),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app say fixed");
      assert.match(notes.join("\n"), /grew past a standard light change \(40 lines \(max 30\)\) — running the specs/);
      assert.equal(h.userMessages().filter((m) => /no acceptance scenarios/.test(m)).length, 1);
    } finally {
      h.dispose();
    }
  });

  it("light_change is refused when the change is already too big for the setting", async () => {
    const h = await createHarness({ extensions: [scenariosExt], files: { "a.app": "broken\n" } });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", { ...NODE_SCENARIOS_CONFIG, light: "strict", maxFixAttempts: 1 });
      h.faux.setResponses([
        call("write", { path: "a.app", content: many(12) }),
        call("light_change", { why: "small", howToCheck: HOW }),
        reply("done"),
        reply("stopping"),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app say fixed");
      assert.match(JSON.stringify(h.session.messages), /Not a light change: 12 lines \(max 10\)\. This project allows up to 10 changed lines, 1 file, no new files \(strict\)/);
    } finally {
      h.dispose();
    }
  });

  it("off: no light_change tool and no Light changes section", async () => {
    const h = await createHarness({ extensions: [scenariosExt] });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", { ...NODE_SCENARIOS_CONFIG, light: "off" });
      let seen = { tools: [] as string[], systemPrompt: "" };
      h.faux.setResponses([
        (context) => {
          seen = seenBy(context);
          return reply("hi");
        },
      ]);
      await h.session.prompt("hello");
      assert.ok(!seen.tools.includes("light_change"));
      assert.doesNotMatch(seen.systemPrompt, /## Light changes/);
    } finally {
      h.dispose();
    }
  });
});

describe("ask the user to verify", () => {
  const scenario = { id: "app-fixed", title: "a.app says fixed", steps: "Given a.app, then fixed", testFile: ".pi/scenarios/app-fixed.js", kind: "script" };
  const setup = [
    call("define_scenarios", { scenarios: [scenario] }),
    call("write", { path: scenario.testFile, content: APP_SCENARIO_SCRIPT }),
    call("write", { path: "a.app", content: "green" }),
    reply("done"),
  ];

  it("after 2 identical failures the model may ask; yes counts as verified by user and closes the gate", async () => {
    const asked: string[] = [];
    const h = await createHarness({
      extensions: [scenariosExt],
      ui: { select: (async (title: string, options: string[]) => (asked.push(title), options[0])) as never },
    });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
      const tools: string[][] = [];
      h.faux.setResponses([
        ...setup,
        (context) => {
          tools.push(seenBy(context).tools);
          return reply("tried again");
        },
        (context) => {
          tools.push(seenBy(context).tools);
          return call("ask_user_to_verify", { what: "a.app looks green", howToLook: "open a.app" });
        },
        reply("You verified it, not the specs."),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app green");
      const failures = h.userMessages().filter((m) => m.startsWith("Acceptance scenarios failed"));
      assert.equal(failures.length, 2);
      assert.doesNotMatch(failures[0]!, /ask_user_to_verify/);
      assert.match(failures[1]!, /The same failure came 2 times in a row[\s\S]*call ask_user_to_verify/);
      assert.ok(!tools[0]!.includes("ask_user_to_verify"), "not offered after one failure");
      assert.ok(tools[1]!.includes("ask_user_to_verify"));
      assert.match(asked[0]!, /Please check: a\.app looks green\nHow to look: open a\.app/);
      assert.match(JSON.stringify(h.session.messages), /Recorded as verified by user \(failing spec\(s\): app-fixed\)/);
      const records = JSON.parse(fs.readFileSync(path.join(h.cwd, ".pi/scenarios/verified-by-user.json"), "utf8"));
      assert.equal(records[0].what, "a.app looks green");
      assert.deepEqual(records[0].specs, ["app-fixed"]);
      assert.equal(h.faux.getPendingResponseCount(), 1, "the gate does not run again");
    } finally {
      h.dispose();
    }
  });

  it("no: the user's note goes back to the model, and the specs run again after the fix", async () => {
    const h = await createHarness({
      extensions: [scenariosExt],
      ui: {
        select: (async (_t: string, options: string[]) => options[1]) as never,
        input: (async () => "it still says green, should say fixed") as never,
      },
    });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", { ...NODE_SCENARIOS_CONFIG, askUserAfter: 2 });
      h.faux.setResponses([
        ...setup,
        reply("tried again"),
        call("ask_user_to_verify", { what: "a.app is right", howToLook: "open a.app" }),
        call("write", { path: "a.app", content: "fixed" }),
        reply("fixed it"),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app right");
      const result = JSON.stringify(h.session.messages);
      assert.match(result, /says it is NOT right: \\"it still says green, should say fixed\\"/);
      assert.ok(!fs.existsSync(path.join(h.cwd, ".pi/scenarios/verified-by-user.json")));
      assert.equal(h.faux.getPendingResponseCount(), 1);
    } finally {
      h.dispose();
    }
  });

  it("ask-after 0 never offers it", async () => {
    const h = await createHarness({ extensions: [scenariosExt], ui: {} });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", { ...NODE_SCENARIOS_CONFIG, askUserAfter: 0, maxFixAttempts: 2 });
      h.faux.setResponses([...setup, reply("again"), reply("again"), reply("unused")]);
      await h.session.prompt("make a.app green");
      assert.ok(h.userMessages().every((m) => !/ask_user_to_verify/.test(m)));
    } finally {
      h.dispose();
    }
  });
});
