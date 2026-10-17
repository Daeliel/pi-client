import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "./config.ts";
import { covered, rereadDue, rereadProblems, sections } from "./reread.ts";
import { addSource } from "./sources.ts";

describe("fresh read", () => {
  it("splits long text into paragraph-aligned sections a small model can hold", () => {
    const para = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const parts = sections([para(700), para(700), para(700)].join("\n\n"));
    assert.equal(parts.length, 3, "a section never splits a paragraph");
    assert.equal(sections("short text").length, 1);
  });

  it("a fresh statement counts as covered when a listed point says the same", () => {
    const listed = ["Branching goes up to 5 branches wide.", "Chart — pick the next destination on a random map"];
    assert.ok(covered("branching goes up to 5 branches wide", listed), "same words");
    assert.ok(covered("pick the next destination", listed), "contained");
    assert.ok(!covered("Rearranging wagons only happens at crane yards", listed), "new");
  });

  it("due only for long sources, until re-read in this version; findings stay until a point covers them", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-reread-"));
    try {
      const config = { ...DEFAULT_CONFIG, rereadAboveWords: 50 };
      fs.writeFileSync(path.join(cwd, "short.md"), "Build me a game.");
      addSource(cwd, config.blueprintPath, { file: "short.md" });
      assert.equal(rereadDue(cwd, config), false, "under the threshold");

      fs.writeFileSync(path.join(cwd, "DESIGN.md"), `${"filler words here ".repeat(30)}\n\nRearranging wagons only happens at crane yards.\n`);
      const src = addSource(cwd, config.blueprintPath, { file: "DESIGN.md" }).source;
      assert.equal(rereadDue(cwd, config), true);
      assert.match(rereadProblems(cwd, config)[0]!, /a fresh read is due/);

      const dir = path.join(cwd, ".pi/blueprint/sources");
      const shas = Object.fromEntries([[src.id, src.sha], ["SRC-1", addSource(cwd, config.blueprintPath, { file: "short.md" }).source.sha]]);
      fs.writeFileSync(path.join(dir, "REREAD.json"), JSON.stringify({ shas, at: "now", found: [{ source: src.id, quote: "Rearranging wagons only happens at crane yards." }] }));
      assert.equal(rereadDue(cwd, config), false);
      assert.match(rereadProblems(cwd, config)[0]!, /found 1 statement\(s\) POINTS\.md does not have[\s\S]*crane yards/);

      fs.writeFileSync(path.join(cwd, ".pi/blueprint/POINTS.md"), `- S-01 (${src.id}) "Rearranging wagons only happens at crane yards."\n`);
      assert.deepEqual(rereadProblems(cwd, config), [], "covered now");

      fs.appendFileSync(path.join(cwd, "DESIGN.md"), "\nA new rule.\n");
      addSource(cwd, config.blueprintPath, { file: "DESIGN.md" });
      assert.equal(rereadDue(cwd, config), true, "a changed source is read fresh again");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
