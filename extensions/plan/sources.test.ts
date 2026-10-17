import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addSource, checkSources, countWords, quoteInSource, readSources, textWords } from "./sources.ts";

const BP = ".pi/blueprint/BLUEPRINT.md";
const DESIGN = `# Leviathan

## 2. The cycle

| 1 | **Chart** — pick the next destination on a random map | AGREED |

### The route map
- **Branching goes up to 5 branches wide.** The map fans
  out, so the player is choosing a *route*, not just a next step.
`;

function project(fn: (cwd: string) => void) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sources-"));
  try {
    fs.writeFileSync(path.join(cwd, "DESIGN.md"), DESIGN);
    fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function points(cwd: string, text: string) {
  fs.mkdirSync(path.join(cwd, ".pi/blueprint"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi/blueprint/POINTS.md"), text);
}

describe("plan sources", () => {
  it("a quote must be the source's own words — markdown, line breaks and '…' do not matter, paraphrase does", () => {
    assert.ok(quoteInSource("Chart — pick the next destination on a random map", DESIGN));
    assert.ok(quoteInSource("Branching goes up to 5 branches wide. The map fans out, so the player is choosing a route", DESIGN), "bold, italics, line break");
    assert.ok(quoteInSource("Branching goes up to 5 branches wide … not just a next step.", DESIGN), "shortened with …");
    assert.ok(!quoteInSource("The player picks one road per cycle", DESIGN), "a paraphrase");
    assert.ok(!quoteInSource("not just a next step … Branching goes up", DESIGN), "pieces out of order");
  });

  it("registers the request verbatim and documents in place; re-adding records the new version", () => {
    project((cwd) => {
      const req = addSource(cwd, BP, { text: "Build me a game like Slay the Spire, but on a train." });
      assert.equal(req.source.id, "SRC-1");
      assert.equal(fs.readFileSync(path.join(cwd, req.source.file), "utf8").trim(), "Build me a game like Slay the Spire, but on a train.");
      const doc = addSource(cwd, BP, { file: "DESIGN.md" });
      assert.equal(doc.source.id, "SRC-2");
      assert.equal(doc.source.words, countWords(DESIGN));
      fs.appendFileSync(path.join(cwd, "DESIGN.md"), "\nCrane yards charge a fee.\n");
      const again = addSource(cwd, BP, { file: "DESIGN.md" });
      assert.ok(again.refreshed);
      assert.equal(readSources(cwd, BP).length, 2, "same file, same id");
      assert.equal(textWords(readSources(cwd, BP)), readSources(cwd, BP).reduce((n, s) => n + s.words, 0));
      assert.throws(() => addSource(cwd, BP, { file: "../outside.md" }), /outside the project|no such file/);
    });
  });

  it("every point quoted, every point accounted for", () => {
    project((cwd) => {
      addSource(cwd, BP, { file: "DESIGN.md" });
      points(
        cwd,
        `- S-01 (SRC-1 §2) "pick the next destination on a random map"
- S-02 (SRC-1 route map) "Branching goes up to 5 branches wide."
- S-03 (SRC-1 route map) "The player picks one road per cycle"
- S-04 (SRC-9) "anything"
- S-05 route map: no quotes here
`,
      );
      const r = checkSources(cwd, BP, new Set(["S-01", "S-07"]), new Set(["S-02"]));
      const text = r.problems.join("\n");
      assert.doesNotMatch(text, /S-01:/, "quoted and served");
      assert.doesNotMatch(text, /S-02:/, "quoted and listed as not covered");
      assert.match(text, /S-03: the quote is not in SRC-1/);
      assert.match(text, /S-03: not served by any item/);
      assert.match(text, /S-04: unknown source SRC-9/);
      assert.match(text, /POINTS\.md line 5: write/);
      assert.match(text, /S-07 is referenced in the blueprint but is not in POINTS\.md/);
    });
  });

  it("a changed source is noticed, and quotes that left it are flagged — not called paraphrases", () => {
    project((cwd) => {
      addSource(cwd, BP, { file: "DESIGN.md" });
      points(cwd, `- S-01 (SRC-1) "Branching goes up to 5 branches wide."\n`);
      assert.deepEqual(checkSources(cwd, BP, new Set(["S-01"]), new Set()).problems, []);

      fs.writeFileSync(path.join(cwd, "DESIGN.md"), DESIGN.replace("up to 5 branches", "up to 3 branches"));
      const r = checkSources(cwd, BP, new Set(["S-01"]), new Set());
      assert.equal(r.changed.length, 1);
      assert.deepEqual(r.staleQuotes.map((p) => p.id), ["S-01"]);
      assert.match(r.problems.join("\n"), /SRC-1 DESIGN\.md changed since its points were taken/);
      assert.match(r.problems.join("\n"), /S-01: its quote is no longer in SRC-1 \(changed\)/);
      assert.doesNotMatch(r.problems.join("\n"), /do not paraphrase/);
    });
  });

  it("no sources or no points: says exactly what to do first", () => {
    project((cwd) => {
      assert.match(checkSources(cwd, BP, new Set(), new Set()).problems[0]!, /No sources registered — call add_source/);
      addSource(cwd, BP, { file: "DESIGN.md" });
      assert.match(checkSources(cwd, BP, new Set(), new Set()).problems[0]!, /No \.pi\/blueprint\/POINTS\.md/);
    });
  });
});
