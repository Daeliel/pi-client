import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import verifyExt from "../extensions/verify/index";
import scenariosExt from "../extensions/scenarios/index";
import { APP_VERIFY_CONFIG, call, createHarness, NODE_SCENARIOS_CONFIG, reply, writeProjectConfig } from "./harness";

/** Counts its runs; while slow.flag exists it takes 3 s, leaves survived.txt if not killed, and fails. */
const SLOW_SCRIPT = `const fs = require("fs");
fs.appendFileSync("runs.txt", "x");
if (fs.existsSync("slow.flag")) setTimeout(() => { fs.writeFileSync("survived.txt", "x"); process.exit(1); }, 3000);
`;

const scenario = { id: "slow", title: "slow flow", steps: "Given it runs", testFile: ".pi/scenarios/slow.js", kind: "script" };

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("/skip", () => {
  it("stops a running scenario gate, leaves no follow-up, tells the model, and the next change re-arms", async () => {
    const h = await createHarness({ extensions: [verifyExt, scenariosExt], ui: {}, files: { "slow.flag": "" } });
    try {
      writeProjectConfig(h.cwd, "verify.config.json", APP_VERIFY_CONFIG);
      writeProjectConfig(h.cwd, "scenarios.config.json", NODE_SCENARIOS_CONFIG);
      const runs = () => (fs.existsSync(path.join(h.cwd, "runs.txt")) ? fs.readFileSync(path.join(h.cwd, "runs.txt"), "utf8").length : 0);
      let sawNote = false;
      h.faux.setResponses([
        call("define_scenarios", { scenarios: [scenario] }),
        call("write", { path: scenario.testFile, content: SLOW_SCRIPT }),
        call("write", { path: "a.app", content: "fixed" }),
        reply("done"),
        // next user prompt: the model must be told the checks were skipped
        (context) => {
          sawNote = JSON.stringify(context.messages ?? []).includes("[gate skipped by the user]");
          return reply("noted");
        },
        // a later code change re-arms the gates
        call("write", { path: "a.app", content: "fixed again" }),
        reply("changed"),
        reply("unused"),
      ]);

      const started = Date.now();
      const build = h.session.prompt("make a.app");
      await waitFor(() => runs() === 1, 15000); // the gate is now inside the slow scenario
      await h.session.prompt("/skip");
      await build;
      await h.settle();
      assert.ok(Date.now() - started < 2900, "the slow scenario was stopped, not waited for");
      await new Promise((r) => setTimeout(r, 3500));
      assert.ok(!fs.existsSync(path.join(h.cwd, "survived.txt")), "the scenario process itself was killed, not just its shell");
      assert.equal(h.userMessages().filter((m) => m.startsWith("Acceptance scenarios failed")).length, 0, "no follow-up after /skip");

      await h.session.prompt("what's next?");
      assert.ok(sawNote, "the model is told the changes are unverified");

      fs.rmSync(path.join(h.cwd, "slow.flag"));
      await h.session.prompt("tweak a.app");
      await h.settle();
      assert.equal(runs(), 2, "the next code change ran the scenario again");
      assert.equal(h.faux.getPendingResponseCount(), 1);
    } finally {
      h.dispose();
    }
  });
});
