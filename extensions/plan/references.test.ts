import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { braveImageSearch, refImagesFor, saveReference } from "./references.ts";

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
