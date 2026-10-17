import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBlueprint, formatSummary, inScope, nextItem, parseBlueprint, setMark, tierCounts } from "./blueprint.ts";

const BP = `# Blueprint: pixel editor

Goal: a browser pixel-art editor.
Bar: spec

## v1 — core
- [x] **R-01** Canvas: create 32/64/128 px, zoom 1-16x, grid toggle · serves: S-01 · proves: canvas.spec.ts
- [~] **R-02** Pencil and eraser, 1-4 px, undo/redo 50 steps · serves: S-02 · proves: draw-undo.spec.ts
- [ ] **R-03** Palette with 16 swatches and a custom colour picker · serves: S-03 · proves: palette.spec.ts
- [!] **R-04** PNG export at 1x and 4x scale · serves: S-04 · proves: export.spec.ts · blocked: toBlob null

## v2
- [-] **R-10** Layers: add, hide and reorder layers · serves: S-05 · proves: layers.spec.ts · deferred: budget

## References
- **REF-01** refs/aseprite.png — tool strip left → R-02, R-03

## Assumptions
- A-01 (R-03): no palette import.
`;

describe("blueprint", () => {
  it("parses items, marks, tiers, evidence and notes; ignores REF/assumption lines", () => {
    const p = parseBlueprint(BP);
    assert.equal(p.goal, "a browser pixel-art editor.");
    assert.deepEqual(
      p.items.map((i) => [i.id, i.mark, i.tier, i.proves]),
      [
        ["R-01", "x", "v1", "canvas.spec.ts"],
        ["R-02", "~", "v1", "draw-undo.spec.ts"],
        ["R-03", " ", "v1", "palette.spec.ts"],
        ["R-04", "!", "v1", "export.spec.ts"],
        ["R-10", "-", "v2", "layers.spec.ts"],
      ],
    );
    assert.equal(p.items[3]!.fields.blocked, "toBlob null");
    assert.equal(p.items[0]!.title, "Canvas: create 32/64/128 px, zoom 1-16x, grid toggle");
    assert.deepEqual(checkBlueprint(p), []);
  });

  it("setMark rewrites only the mark and its note, keeping the rest of the line", () => {
    let t = setMark(BP, "R-03", "x");
    assert.match(t, /- \[x\] \*\*R-03\*\* Palette with 16 swatches and a custom colour picker · serves: S-03 · proves: palette\.spec\.ts\n/);
    t = setMark(t, "R-04", " ");
    assert.match(t, /- \[ \] \*\*R-04\*\* PNG export at 1x and 4x scale · serves: S-04 · proves: export\.spec\.ts\n/, "blocked note dropped");
    t = setMark(t, "R-01", "!", "spec\nfailed   twice");
    assert.match(t, /\*\*R-01\*\* Canvas.*· proves: canvas\.spec\.ts · blocked: spec failed twice/);
    assert.equal(setMark("a\r\n- [ ] **R-01** x · proves: verify\r\n", "R-01", "x"), "a\r\n- [x] **R-01** x · proves: verify\r\n", "keeps CRLF");
  });

  it("next item: the one in progress, else the first open one in scope", () => {
    const items = parseBlueprint(BP).items;
    assert.equal(nextItem(items, "v1")?.id, "R-02");
    const noProgress = parseBlueprint(setMark(BP, "R-02", "x")).items;
    assert.equal(nextItem(noProgress, "v1")?.id, "R-03");
    assert.deepEqual(inScope(items, "v1").map((i) => i.id), ["R-01", "R-02", "R-03", "R-04"]);
    assert.equal(inScope(items, "all").length, 5);
  });

  it("checkBlueprint names what to fix", () => {
    const bad = parseBlueprint(`# x

## v1
- [ ] **R-01** Canvas · proves: canvas.spec.ts
- [ ] **R-02** Pencil and eraser with sizes
- [ ] **R-02** Palette with sixteen swatches · proves: palette
- **R-03** Export to PNG at two sizes · proves: verify
`);
    const problems = checkBlueprint(bad).join("\n");
    assert.match(problems, /No `Goal: …` line/);
    assert.match(problems, /R-01: "Canvas" is too thin/);
    assert.match(problems, /R-02: missing `· proves:/);
    assert.match(problems, /R-02: duplicate id/);
    assert.match(problems, /proves "palette"/);
    assert.match(problems, /needs a checkbox/);
    assert.match(checkBlueprint(parseBlueprint("Goal: g\n")).join("\n"), /No items/);
  });

  it("product bar: every item a user does must say how they do it", () => {
    const bp = (bar: string) =>
      parseBlueprint(`Goal: a route-map game
Bar: ${bar}

## v1
- [ ] **R-01** Pick the next destination on the route map · serves: S-01 · proves: route-map.spec.ts
- [ ] **R-02** Route generation keeps 5-20 nodes per leg · serves: S-02 · proves: verify
- [ ] **R-03** The chart shows the risk of each branch · input: hover a node on the map · serves: S-03 · proves: chart.spec.ts
`);
    const product = checkBlueprint(bp("product")).join("\n");
    assert.match(product, /R-01: product bar — say how the user does it/);
    assert.doesNotMatch(product, /R-02/, "verify-proved rules need no input");
    assert.doesNotMatch(product, /R-03/, "has its input");
    assert.deepEqual(checkBlueprint(bp("spec")), [], "spec bar: no input required");
    assert.match(checkBlueprint(parseBlueprint("Goal: g\n\n## v1\n- [ ] **R-01** Something checkable here · proves: verify\n")).join(), /No `Bar: product` or `Bar: spec` line/);
  });

  it("summaries for the footer and the brief", () => {
    const items = parseBlueprint(BP).items;
    assert.equal(tierCounts(items), "v1 1/4 done (1 blocked) · v2 0/1 done (1 deferred)");
    assert.match(formatSummary(items, "v1"), /\[!\] R-04 PNG export.* — blocked: toBlob null/);
  });
});
