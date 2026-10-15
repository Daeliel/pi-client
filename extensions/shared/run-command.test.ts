import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "./run-command.ts";

describe("runCommand", () => {
  it("passes exit code and output through", async () => {
    const ok = await runCommand(`node -e "console.log('hi'); process.exit(3)"`, { cwd: os.tmpdir(), timeoutMs: 10000 });
    assert.equal(ok.code, 3);
    assert.equal(ok.out, "hi");
    assert.equal(ok.timedOut, false);
  });

  it("a timeout kills the whole tree, not only the shell", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-cmd-"));
    try {
      const r = await runCommand(`node -e "setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 1500)"`, { cwd: dir, timeoutMs: 300 });
      assert.equal(r.timedOut, true);
      assert.equal(r.code, 124);
      await new Promise((res) => setTimeout(res, 2000));
      assert.ok(!fs.existsSync(path.join(dir, "late.txt")), "the child survived the timeout");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an aborted signal returns aborted without running", async () => {
    const r = await runCommand("node -e 1", { cwd: os.tmpdir(), timeoutMs: 1000, signal: AbortSignal.abort() });
    assert.deepEqual(r, { code: 0, out: "", timedOut: false, aborted: true });
  });
});
