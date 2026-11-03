import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cutRunaway, runawayKind } from "./runaway";

const here = path.dirname(fileURLToPath(import.meta.url));
const readme = fs.readFileSync(path.join(here, "..", "..", "README.md"), "utf8");
const code = fs.readFileSync(path.join(here, "index.ts"), "utf8");
const healthy = "The journey failed at the relic pickup, so the walk helper overshoots. Let me look at walkTo.\n\n";

describe("runaway output", () => {
  it("a symbol, a phrase or a passage repeating — whatever the model's tags", () => {
    for (const open of ["", "<think>", "<mm:think>", "[reasoning] "]) {
      assert.equal(runawayKind(open + healthy + "✗ ".repeat(3000)), "low-variety", `symbols after ${JSON.stringify(open)}`);
      assert.ok(runawayKind(open + healthy + "hmm, wait — ".repeat(600)), `a phrase after ${JSON.stringify(open)}`);
    }
    const passage =
      "Let me try clicking on the Progress tab icon directly. The icon is a line chart with an upward arrow. " +
      "Actually, the role might not be button, so let me use a different selector for it.\n\n";
    assert.equal(runawayKind(healthy + passage.repeat(6)), "repeated-passage");
    assert.equal(runawayKind(healthy + "进度标签找不到，让我换一个选择器再试一次。".repeat(400)), "low-variety", "no spaces needed");
  });

  it("ordinary long output is not a runaway", () => {
    assert.equal(runawayKind(readme), null, "prose");
    assert.equal(runawayKind(code), null, "code");
    const list = Array.from({ length: 300 }, (_, i) => `- [x] R-${i} item number ${i} passes its spec (${(i * 7) % 13} ms)`).join("\n");
    assert.equal(runawayKind(list), null, "a long list of similar lines");
    assert.equal(runawayKind("short ✗ ✗ ✗ ✗"), null, "too little to judge");
  });

  it("the repeated part is cut from the reply; the reasoning before it stays", () => {
    const text = healthy.repeat(1) + readme.slice(0, 3000) + "✗ ".repeat(8000);
    const cut = cutRunaway(text)!;
    assert.ok(cut.startsWith(healthy + readme.slice(0, 2000)), "the healthy start is kept");
    assert.ok(cut.length < 7000, `most of the run is gone (${cut.length})`);
    assert.match(cut, /\[anti-loop: \d+ characters of repeated output removed\]$/);
    assert.equal(cutRunaway(readme), null);
  });
});
