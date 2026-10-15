import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { budgetDecision, parseBudget } from "./budget.ts";
import { slugify } from "./checkpoints.ts";
import { braveImageSearch, refImagesFor, saveReference } from "./references.ts";

describe("budget", () => {
  const base = { usedMinutes: 0, budgetMinutes: 180, finished: 0, open: 5, replanAt: -1 };

  it("no limit always goes; an exhausted budget stops", () => {
    assert.equal(budgetDecision({ ...base, budgetMinutes: null, usedMinutes: 9999 }), "go");
    assert.equal(budgetDecision({ ...base, usedMinutes: 180 }), "stop");
  });

  it("stops at a boundary when not even half an average item fits", () => {
    // 4 items in 160 min = 40 min each; 15 min left < 20.
    assert.equal(budgetDecision({ ...base, usedMinutes: 165, finished: 4, open: 1 }), "stop");
    assert.equal(budgetDecision({ ...base, usedMinutes: 150, finished: 4, open: 1 }), "go");
  });

  it("asks for a re-plan once per finished item when the pace will not fit", () => {
    // 2 items in 60 min = 30 each; 5 open = 150 min > 120 left × 1.1.
    const behind = { ...base, usedMinutes: 60, finished: 2, open: 5 };
    assert.equal(budgetDecision(behind), "replan");
    assert.equal(budgetDecision({ ...behind, replanAt: 2 }), "go", "already asked at this count");
    assert.equal(budgetDecision({ ...behind, open: 3 }), "go", "3 × 30 fits in 120");
    assert.equal(budgetDecision({ ...base, usedMinutes: 30 }), "go", "no pace before the first item");
  });

  it("parses budgets", () => {
    assert.equal(parseBudget("90"), 90);
    assert.equal(parseBudget("90m"), 90);
    assert.equal(parseBudget("1.5h"), 90);
    assert.equal(parseBudget("2:30"), 150);
    assert.equal(parseBudget(""), null);
    assert.equal(parseBudget("soon"), "invalid");
  });
});

describe("checkpoint branch names", () => {
  it("keeps whole words", () => {
    assert.equal(slugify("Make a.app say fixed and b.app record the second step"), "make-a-app-say-fixed-and-b-app-record");
    assert.equal(slugify("!!!"), "run");
  });
});

describe("references", () => {
  it("copies a local image into refs, keeps one already there, refuses non-images", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-refs-"));
    try {
      fs.writeFileSync(path.join(cwd, "shot.PNG"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      fs.writeFileSync(path.join(cwd, "notes.txt"), "x");
      const saved = await saveReference(cwd, ".pi/blueprint/refs", "shot.PNG", "Game HUD");
      assert.equal(saved.file, ".pi/blueprint/refs/game-hud.png");
      assert.ok(fs.existsSync(path.join(cwd, saved.file)));
      const again = await saveReference(cwd, ".pi/blueprint/refs", saved.file, "ignored");
      assert.equal(again.file, saved.file, "already in refs: not copied twice");
      await assert.rejects(saveReference(cwd, ".pi/blueprint/refs", "notes.txt", "n"), /not an image/);
      await assert.rejects(saveReference(cwd, ".pi/blueprint/refs", "nope.png", "n"), /no such file/);

      const bp = "## References\n- **REF-01** refs/game-hud.png — HUD → R-02, R-03\n- **REF-02** refs/other.png — x → R-09\n";
      assert.deepEqual(refImagesFor(cwd, bp, "R-03").map((f) => path.basename(f)), ["game-hud.png"]);
      assert.deepEqual(refImagesFor(cwd, bp, "R-09"), [], "listed but missing on disk");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("image search without a key says so", async () => {
    const prev = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    try {
      await assert.rejects(braveImageSearch("x", 3, { fetchTimeoutMs: 1000 } as never), /NO_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.BRAVE_API_KEY = prev;
    }
  });
});
