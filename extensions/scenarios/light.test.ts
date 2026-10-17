import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeMeter, changedLines, describeLimits, overLimit } from "./light.ts";
import { RepeatTracker } from "../shared/gate-messages.ts";

describe("light change size", () => {
  it("counts the larger of added and removed lines, whatever their order", () => {
    assert.equal(changedLines("a\nb\nc", "a\nB\nc"), 1);
    assert.equal(changedLines("a\nb", "b\na"), 0, "moved, not changed");
    assert.equal(changedLines(null, "x\ny"), 2, "new file");
    assert.equal(changedLines("a\nb\nc", "a"), 2);
  });

  it("measures code files from before their first edit; docs do not count", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "light-"));
    try {
      fs.writeFileSync(path.join(cwd, "a.css"), "a { color: red; }\n");
      const meter = new ChangeMeter();
      meter.snapshot(cwd, "a.css");
      meter.snapshot(cwd, "new.ts");
      meter.snapshot(cwd, "README.md");
      fs.writeFileSync(path.join(cwd, "a.css"), "a { color: blue; }\n");
      meter.snapshot(cwd, "a.css"); // later edits keep the first "before"
      fs.writeFileSync(path.join(cwd, "new.ts"), "export const x = 1;\n");
      fs.writeFileSync(path.join(cwd, "README.md"), "lots\nof\nnotes\n");
      assert.deepEqual(meter.measure(), { lines: 2, files: 2, newFiles: 1 });
      assert.ok(meter.covers(cwd, ["a.css", "README.md"]));
      assert.ok(!meter.covers(cwd, ["other.ts"]));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("each setting is looser than the last", () => {
    const size = { lines: 25, files: 2, newFiles: 0 };
    assert.equal(overLimit("strict", size), "25 lines (max 10), 2 files (max 1)");
    assert.equal(overLimit("standard", size), null);
    assert.equal(overLimit("loose", { lines: 90, files: 5, newFiles: 1 }), null);
    assert.match(overLimit("off", size)!, /off/);
    assert.equal(describeLimits("loose"), "up to 100 changed lines, up to 6 files, at most 1 new file");
  });

  it("the repeat tracker counts identical failures in a row", () => {
    const t = new RepeatTracker();
    t.repeated("fail A in 50ms");
    assert.equal(t.streak, 1);
    t.repeated("fail A in 120ms");
    t.repeated("fail A in 300ms");
    assert.equal(t.streak, 3);
    t.repeated("fail B");
    assert.equal(t.streak, 1);
    t.reset();
    assert.equal(t.streak, 0);
  });
});
