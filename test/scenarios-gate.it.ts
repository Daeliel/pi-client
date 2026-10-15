import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import verifyExt from "../extensions/verify/index";
import scenariosExt from "../extensions/scenarios/index";
import {
  APP_SCENARIO_SCRIPT,
  APP_VERIFY_CONFIG,
  call,
  createHarness,
  NODE_SCENARIOS_CONFIG,
  reply,
  seenBy,
  writeProjectConfig,
} from "./harness";

const startsWith = (msgs: string[], prefix: string) => msgs.filter((m) => m.startsWith(prefix)).length;

const scenario = {
  id: "app-fixed",
  title: "a.app says fixed",
  steps: "Given a.app, then it contains fixed",
  testFile: ".pi/scenarios/app-fixed.js",
  kind: "script",
};

describe("scenarios gate", () => {
  it("does not demand scenarios for docs-only edits", async () => {
    const h = await createHarness({ extensions: [scenariosExt] });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
      h.faux.setResponses([call("write", { path: "README.md", content: "# hi" }), reply("done"), reply("unused")]);
      await h.session.prompt("write a readme");
      assert.equal(h.userMessages().length, 1, "no gate follow-up expected");
    } finally {
      h.dispose();
    }
  });

  it("asks for scenarios after a code edit, then passes once they are defined and green", async () => {
    const h = await createHarness({ extensions: [scenariosExt] });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
      h.faux.setResponses([
        call("write", { path: "a.app", content: "fixed" }),
        reply("done"),
        call("define_scenarios", { scenarios: [scenario] }),
        call("write", { path: scenario.testFile, content: APP_SCENARIO_SCRIPT }),
        reply("scenarios written"),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app");
      const users = h.userMessages();
      assert.equal(startsWith(users, "You changed code but no acceptance scenarios are defined"), 1);
      assert.equal(h.faux.getPendingResponseCount(), 1, "gate must go quiet once the scenario passes");
    } finally {
      h.dispose();
    }
  });

  it("verify owns the follow-up while it fails; scenarios run after verify is green", async () => {
    const h = await createHarness({ extensions: [verifyExt, scenariosExt] });
    try {
      writeProjectConfig(h.cwd, "verify.config.json", APP_VERIFY_CONFIG);
      writeProjectConfig(h.cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
      h.faux.setResponses([
        call("define_scenarios", { scenarios: [scenario] }),
        call("write", { path: scenario.testFile, content: APP_SCENARIO_SCRIPT }),
        call("write", { path: "a.app", content: "broken" }),
        reply("done"),
        call("write", { path: "a.app", content: "fixed" }),
        reply("fixed it"),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app");
      const users = h.userMessages();
      assert.equal(startsWith(users, "Verification failed"), 1);
      assert.equal(startsWith(users, "Acceptance scenarios failed"), 0, "scenarios must not pile on while verify is red");
      assert.equal(h.faux.getPendingResponseCount(), 1);
    } finally {
      h.dispose();
    }
  });

  it("drops a registered scenario whose spec was renamed instead of failing it as missing forever", async () => {
    const h = await createHarness({ extensions: [scenariosExt] });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
      const renamed = { ...scenario, id: "app-ok", testFile: ".pi/scenarios/app-ok.js" };
      h.faux.setResponses([
        call("define_scenarios", { scenarios: [scenario] }),
        call("write", { path: scenario.testFile, content: APP_SCENARIO_SCRIPT }),
        call("write", { path: "a.app", content: "broken" }),
        reply("done"),
        // Model renames the spec and fixes the app, but never re-registers.
        call("bash", {
          command: `node -e "require('fs').renameSync('${scenario.testFile}', '${renamed.testFile}')"`,
        }),
        call("write", { path: "a.app", content: "fixed" }),
        reply("done"),
        call("define_scenarios", { scenarios: [renamed] }),
        reply("re-registered"),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app");
      const users = h.userMessages();
      assert.equal(startsWith(users, "Acceptance scenarios failed"), 1, "only the real failure, no missing-file loop");
      assert.ok(!users.some((m) => m.includes("test file missing")), users.join("\n---\n"));
      assert.equal(startsWith(users, "You changed code but no acceptance scenarios are defined"), 1);
      assert.equal(h.faux.getPendingResponseCount(), 1);
    } finally {
      h.dispose();
    }
  });

  it("deletes scratch specs once the gate passes, not before", async () => {
    const h = await createHarness({ extensions: [scenariosExt] });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
      const scratch = path.join(h.cwd, ".pi/scenarios/__probe.spec.ts");
      let existedAfterFailure = false;
      h.faux.setResponses([
        call("define_scenarios", { scenarios: [scenario] }),
        call("write", { path: scenario.testFile, content: APP_SCENARIO_SCRIPT }),
        call("write", { path: ".pi/scenarios/__probe.spec.ts", content: "// throwaway" }),
        call("write", { path: "a.app", content: "broken" }),
        reply("done"),
        () => {
          existedAfterFailure = fs.existsSync(scratch);
          return call("write", { path: "a.app", content: "fixed" });
        },
        reply("done"),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app");
      assert.ok(existedAfterFailure, "scratch must survive a failing gate");
      assert.ok(!fs.existsSync(scratch), "scratch must be gone after the passing gate");
      assert.ok(fs.existsSync(path.join(h.cwd, scenario.testFile)), "real specs are kept");
    } finally {
      h.dispose();
    }
  });

  describe("levels", () => {
    // Three specs on disk, run by node: one for the code the model edits, a smoke spec,
    // and a failing spec for an area this change does not touch.
    const specs = {
      ".pi/scenarios/energy-charge.spec.ts": "process.exit(0);\n",
      ".pi/scenarios/smoke-loop.spec.ts": "process.exit(0);\n",
      ".pi/scenarios/travel-stage.spec.ts": "process.exit(1);\n",
    };
    const levelConfig = (level?: "standard") => ({
      ...NODE_SCENARIOS_CONFIG,
      ...(level ? { level } : {}),
      maxFixAttempts: 1,
      visionOnFailure: false,
      web: { command: "node {files}", probe: "node --version" },
    });
    const lastToolText = (c: { messages?: unknown[] }) => JSON.stringify(c.messages?.at(-1) ?? "");

    it("thorough (the default) runs every spec, so the unrelated failure blocks", async () => {
      const h = await createHarness({ extensions: [scenariosExt], files: specs });
      try {
        writeProjectConfig(h.cwd, "scenarios.config.json", levelConfig());
        h.faux.setResponses([call("write", { path: "src/energy.js", content: "x" }), reply("done"), reply("tried"), reply("unused")]);
        await h.session.prompt("tweak energy");
        const users = h.userMessages();
        assert.equal(startsWith(users, "Acceptance scenarios failed"), 1, users.join("\n---\n"));
        assert.match(users.find((m) => m.startsWith("Acceptance scenarios failed")) ?? "", /travel-stage/);
      } finally {
        h.dispose();
      }
    });

    it("standard runs the affected and smoke specs, and says what it left out", async () => {
      const notes: string[] = [];
      const h = await createHarness({
        extensions: [scenariosExt],
        files: specs,
        ui: { notify: ((message: string) => void notes.push(message)) as never },
      });
      try {
        writeProjectConfig(h.cwd, "scenarios.config.json", levelConfig("standard"));
        h.faux.setResponses([call("write", { path: "src/energy.js", content: "x" }), reply("done"), reply("unused")]);
        await h.session.prompt("tweak energy");
        assert.equal(startsWith(h.userMessages(), "Acceptance scenarios failed"), 0, "travel-stage is not this change's");
        assert.equal(h.faux.getPendingResponseCount(), 1);
        const note = notes.find((n) => n.startsWith("Standard level:")) ?? "";
        assert.match(note, /ran 2 of 3 spec\(s\)/);
        assert.match(note, /energy-charge \(name matches src\/energy\.js\)/);
        assert.match(note, /smoke-loop \(smoke\)/);
        assert.match(note, /all: true/);
      } finally {
        h.dispose();
      }
    });

    it("standard: run_scenarios all: true runs everything and finds the failure", async () => {
      const seen: string[] = [];
      const h = await createHarness({ extensions: [scenariosExt], files: specs });
      try {
        writeProjectConfig(h.cwd, "scenarios.config.json", levelConfig("standard"));
        h.faux.setResponses([
          call("write", { path: "src/energy.js", content: "x" }),
          call("run_scenarios", {}),
          (c: { messages?: unknown[] }) => {
            seen.push(lastToolText(c));
            return call("run_scenarios", { all: true });
          },
          (c: { messages?: unknown[] }) => {
            seen.push(lastToolText(c));
            return reply("done");
          },
          reply("unused"),
        ]);
        await h.session.prompt("tweak energy");
        assert.match(seen[0] ?? "", /Standard level: ran 2 of 3/, "without all, only the affected specs");
        assert.doesNotMatch(seen[0] ?? "", /travel-stage[^"]*FAIL|FAIL[^"]*travel-stage/i);
        assert.match(seen[1] ?? "", /travel-stage/);
        assert.doesNotMatch(seen[1] ?? "", /Standard level:/, "a full run has no level note");
        assert.match(seen[1] ?? "", /"isError":true|failed/i);
      } finally {
        h.dispose();
      }
    });
  });

  describe("model housekeeping review", () => {
    const reviewConfig = (modelReview: boolean) => ({
      ...NODE_SCENARIOS_CONFIG,
      web: { enabled: false }, // discovered .spec.ts files are listed, not run
      housekeeping: { auditOnAgentEnd: false, maxSpecsBeforeAudit: 1, modelReview },
    });
    const specs = {
      ".pi/scenarios/login.spec.ts": `test("user logs in", async () => {});`,
      ".pi/scenarios/login-v2.spec.ts": `test("user logs in", async () => {});`,
    };

    it("after a green gate the model proposes, the user confirms, the extension deletes", async () => {
      const dialogs: string[] = [];
      const h = await createHarness({
        extensions: [scenariosExt],
        files: specs,
        ui: {
          confirm: (async (_title: string, message: string) => {
            dialogs.push(message);
            return true;
          }) as never,
        },
      });
      try {
        writeProjectConfig(h.cwd, "scenarios.config.json", reviewConfig(true));
        h.faux.setResponses([
          call("define_scenarios", { scenarios: [scenario] }),
          call("write", { path: scenario.testFile, content: APP_SCENARIO_SCRIPT }),
          call("write", { path: "a.app", content: "fixed" }),
          reply("done"),
          // Review turn: deleting a spec directly is blocked; the proposal goes through.
          call("bash", { command: "rm .pi/scenarios/login-v2.spec.ts" }),
          call("propose_scenario_cleanup", {
            remove: [
              { file: ".pi/scenarios/login-v2.spec.ts", reason: "copy of login.spec.ts" },
              { file: scenario.testFile, reason: "trying to drop the task's own spec" },
            ],
          }),
          reply("cleaned up"),
          reply("unused"),
        ]);
        await h.session.prompt("make a.app");
        await h.settle();

        const users = h.userMessages();
        assert.equal(startsWith(users, "Scenario housekeeping review"), 1, users.join("\n---\n"));
        assert.match(users.find((m) => m.startsWith("Scenario housekeeping review"))!, /login-v2\.spec\.ts.*duplicate group: login/);
        assert.match(JSON.stringify(h.session.messages), /Scenario review: do not change spec files yourself/);
        assert.equal(dialogs.length, 1);
        assert.match(dialogs[0]!, /login-v2\.spec\.ts — copy of login\.spec\.ts/);
        assert.ok(!fs.existsSync(path.join(h.cwd, ".pi/scenarios/login-v2.spec.ts")), "confirmed spec deleted");
        assert.ok(fs.existsSync(path.join(h.cwd, ".pi/scenarios/login.spec.ts")), "unproposed spec kept");
        assert.ok(fs.existsSync(path.join(h.cwd, scenario.testFile)), "the task's own spec is protected");
        assert.equal(h.faux.getPendingResponseCount(), 1);
      } finally {
        h.dispose();
      }
    });

    it("the model can keep everything and propose a higher cap; the user confirms it", async () => {
      const confirms: string[] = [];
      const h = await createHarness({
        extensions: [scenariosExt],
        files: specs,
        ui: {
          confirm: (async (title: string) => {
            confirms.push(title);
            return true;
          }) as never,
        },
      });
      try {
        writeProjectConfig(h.cwd, "scenarios.config.json", reviewConfig(true));
        h.faux.setResponses([
          call("define_scenarios", { scenarios: [scenario] }),
          call("write", { path: scenario.testFile, content: APP_SCENARIO_SCRIPT }),
          call("write", { path: "a.app", content: "fixed" }),
          reply("done"),
          call("propose_scenario_cleanup", { remove: [], cap: { value: 20, reason: "broad game, one spec per mechanic" } }),
          reply("kept all, cap raised"),
          reply("unused"),
        ]);
        await h.session.prompt("make a.app");
        await h.settle();

        const review = h.userMessages().find((m) => m.startsWith("Scenario housekeeping review"));
        assert.match(review ?? "", /Spec cap: 2 spec\(s\) on disk, cap 1/);
        assert.deepEqual(confirms, ["Scenario cap"], "no removal dialog when nothing is proposed");
        const saved = JSON.parse(fs.readFileSync(path.join(h.cwd, ".pi/scenarios.config.json"), "utf8"));
        assert.equal(saved.housekeeping.maxSpecsBeforeAudit, 20);
        assert.equal(saved.housekeeping.modelReview, true, "other housekeeping settings are kept");
        assert.equal(fs.readdirSync(path.join(h.cwd, ".pi/scenarios")).filter((f) => f.endsWith(".spec.ts")).length, 2);
      } finally {
        h.dispose();
      }
    });

    it("/scenarios cap sets the project cap", async () => {
      const h = await createHarness({ extensions: [scenariosExt], ui: {} });
      try {
        writeProjectConfig(h.cwd, "scenarios.config.json", reviewConfig(false));
        await h.session.prompt("/scenarios cap 30");
        const saved = JSON.parse(fs.readFileSync(path.join(h.cwd, ".pi/scenarios.config.json"), "utf8"));
        assert.equal(saved.housekeeping.maxSpecsBeforeAudit, 30);
        assert.equal(h.calls(), 0, "a command, not a model turn");
      } finally {
        h.dispose();
      }
    });

    it("never runs while modelReview is off", async () => {
      const h = await createHarness({ extensions: [scenariosExt], files: specs, ui: {} });
      try {
        writeProjectConfig(h.cwd, "scenarios.config.json", reviewConfig(false));
        h.faux.setResponses([
          call("define_scenarios", { scenarios: [scenario] }),
          call("write", { path: scenario.testFile, content: APP_SCENARIO_SCRIPT }),
          call("write", { path: "a.app", content: "fixed" }),
          reply("done"),
          reply("unused"),
        ]);
        await h.session.prompt("make a.app");
        await h.settle();
        assert.equal(startsWith(h.userMessages(), "Scenario housekeeping review"), 0);
        assert.equal(h.faux.getPendingResponseCount(), 1);
      } finally {
        h.dispose();
      }
    });
  });

  describe("result bar", () => {
    const JOURNEY = `test("open the app and save a note @journey", async ({ page }) => {
  await page.keyboard.type("hello");
  await page.keyboard.press("Enter");
});
`;

    it("product: green specs are not enough until a @journey spec exists", async () => {
      const h = await createHarness({ extensions: [scenariosExt] });
      try {
        writeProjectConfig(h.cwd, "scenarios.config.json", { ...NODE_SCENARIOS_CONFIG, web: { enabled: false }, bar: "product" });
        h.faux.setResponses([
          call("define_scenarios", { scenarios: [scenario] }),
          call("write", { path: scenario.testFile, content: APP_SCENARIO_SCRIPT }),
          call("write", { path: "a.app", content: "fixed" }),
          reply("done"),
          call("write", { path: ".pi/scenarios/notes.spec.ts", content: JOURNEY }),
          reply("journey added"),
          reply("unused"),
        ]);
        await h.session.prompt("make a.app");
        const users = h.userMessages();
        assert.equal(startsWith(users, "Result bar is **product**, and no @journey spec exists"), 1, users.join("\n---\n"));
        assert.equal(h.faux.getPendingResponseCount(), 1, "quiet once a journey exists");
      } finally {
        h.dispose();
      }
    });

    it("unset: the model records the bar once; the tool then goes away and the procedure follows it", async () => {
      const h = await createHarness({ extensions: [scenariosExt] });
      try {
        writeProjectConfig(h.cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
        let before = { tools: [] as string[], system: "" };
        let after = { tools: [] as string[], system: "" };
        h.faux.setResponses([
          (context) => {
            const s = seenBy(context);
            before = { tools: s.tools, system: s.systemPrompt };
            return call("set_result_bar", { bar: "product", reason: "the user wants a game a person can play" });
          },
          reply("noted"),
          (context) => {
            const s = seenBy(context);
            after = { tools: s.tools, system: s.systemPrompt };
            return reply("ok");
          },
        ]);
        await h.session.prompt("build me a game");
        await h.session.prompt("go on");
        assert.ok(before.tools.includes("set_result_bar"));
        assert.match(before.system, /Result bar: \*\*not set\*\*/);
        assert.ok(!after.tools.includes("set_result_bar"), "set once");
        assert.match(after.system, /Result bar: \*\*product\*\*/);
        const saved = JSON.parse(fs.readFileSync(path.join(h.cwd, ".pi/scenarios.config.json"), "utf8"));
        assert.equal(saved.bar, "product");
      } finally {
        h.dispose();
      }
    });
  });

  it("scenario failures keep coming back until the scenario passes", async () => {
    const h = await createHarness({ extensions: [scenariosExt] });
    try {
      writeProjectConfig(h.cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
      h.faux.setResponses([
        call("define_scenarios", { scenarios: [scenario] }),
        call("write", { path: scenario.testFile, content: APP_SCENARIO_SCRIPT }),
        call("write", { path: "a.app", content: "broken" }),
        reply("done"),
        call("write", { path: "a.app", content: "still broken" }),
        reply("done"),
        call("write", { path: "a.app", content: "fixed" }),
        reply("done"),
        reply("unused"),
      ]);
      await h.session.prompt("make a.app");
      const failures = h.userMessages().filter((m) => m.startsWith("Acceptance scenarios failed"));
      assert.equal(failures.length, 2);
      assert.match(failures[1]!, /SAME FAILURE/);
      assert.equal(h.faux.getPendingResponseCount(), 1);
    } finally {
      h.dispose();
    }
  });
});
