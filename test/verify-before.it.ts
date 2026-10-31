import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import verifyExt from "../extensions/verify/index";
import { call, createHarness, reply, writeProjectConfig } from "./harness";

/** A suite that was already red before the model came: a.app has an old bug. */
const CHECK = `const fs = require("fs");
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const failed = [];
if (read("a.app").includes("bug")) failed.push("FAILED tests/test_app.py::test_old_feature - AssertionError");
if (read("b.app").includes("broken")) failed.push("FAILED tests/test_app.py::test_new_feature - AssertionError");
if (failed.length) { console.log(failed.join("\\n")); process.exit(1); }
`;

const CONFIG = {
  verifyOnEdit: false,
  languages: {
    python: { enabled: false },
    node: { enabled: false },
    csharp: { enabled: false },
    app: { enabled: true, extensions: [".app"], test: "node check.js" },
  },
};

const followUps = (msgs: string[]) => msgs.filter((m) => m.startsWith("Verification failed"));

async function project(notes: string[]) {
  const h = await createHarness({
    extensions: [verifyExt],
    files: { "check.js": CHECK, "a.app": "old bug here" },
    ui: { notify: ((msg: string) => void notes.push(msg)) as never },
  });
  writeProjectConfig(h.cwd, "verify.config.json", CONFIG);
  return h;
}

describe("verify judges the change, not the project", () => {
  it("a failure that was there before the change does not block, and the user is told", async () => {
    const notes: string[] = [];
    const h = await project(notes);
    try {
      h.faux.setResponses([call("write", { path: "b.app", content: "works" }), reply("done"), reply("unused")]);
      await h.session.prompt("add b.app");
      await h.settle();
      assert.equal(followUps(h.userMessages()).length, 0, h.userMessages().join("\n---\n"));
      assert.ok(notes.some((n) => /1 failure was already there before this change — not blocking: tests\/test_app\.py::test_old_feature/.test(n)), notes.join("\n"));
      assert.equal(fs.readFileSync(path.join(h.cwd, "b.app"), "utf8"), "works", "the model's file is back after the check");
      assert.ok(!fs.existsSync(path.join(h.cwd, ".pi/verify/before.json")), "settled: originals dropped");
      assert.ok(!fs.existsSync(path.join(h.cwd, ".pi/verify/swap.json")));
    } finally {
      h.dispose();
    }
  });

  it("a failure the change caused blocks, with the old ones named as not the model's", async () => {
    const h = await project([]);
    try {
      h.faux.setResponses([
        call("write", { path: "b.app", content: "broken" }),
        reply("done"),
        call("write", { path: "b.app", content: "works" }),
        reply("fixed"),
        reply("unused"),
      ]);
      await h.session.prompt("add b.app");
      await h.settle();
      const [msg, ...rest] = followUps(h.userMessages());
      assert.equal(rest.length, 0);
      assert.match(msg!, /CAUSED BY THIS CHANGE — fix these:\n {2}tests\/test_app\.py::test_new_feature\n/);
      assert.match(msg!, /ALREADY FAILING BEFORE THIS CHANGE — not yours, leave them alone:\n {2}tests\/test_app\.py::test_old_feature/);
      assert.equal(fs.readFileSync(path.join(h.cwd, "a.app"), "utf8"), "old bug here", "nobody touched the old bug");
      assert.equal(h.faux.getPendingResponseCount(), 1);
    } finally {
      h.dispose();
    }
  });

  it("a change made through bash is checked and judged too", async () => {
    const h = await project([]);
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: h.cwd, stdio: "ignore" });
      git("init", "-q");
      git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start");
      h.faux.setResponses([
        call("bash", { command: `node -e "require('fs').writeFileSync('b.app','broken')"` }),
        reply("done"),
        reply("unused"),
      ]);
      await h.session.prompt("add b.app");
      await h.settle();
      const [msg] = followUps(h.userMessages());
      assert.ok(msg, "the bash change reached the gate");
      assert.match(msg!, /CAUSED BY THIS CHANGE — fix these:\n {2}tests\/test_app\.py::test_new_feature/);
      assert.equal(fs.readFileSync(path.join(h.cwd, "b.app"), "utf8"), "broken", "the model's file is back after the check");
    } finally {
      h.dispose();
    }
  });
});
