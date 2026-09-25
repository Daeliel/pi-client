import { describe, it } from "node:test";
import assert from "node:assert/strict";
import verifyExt from "../extensions/verify/index";
import scenariosExt from "../extensions/scenarios/index";
import {
  APP_SCENARIO_SCRIPT,
  APP_VERIFY_CONFIG,
  call,
  createHarness,
  NODE_SCENARIOS_CONFIG,
  reply,
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
      assert.equal(startsWith(h.userMessages(), "Acceptance scenarios failed"), 2);
      assert.equal(h.faux.getPendingResponseCount(), 1);
    } finally {
      h.dispose();
    }
  });
});
