import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBlueprint } from "./blueprint.ts";
import { checkExperience, itemContext, parseExperience } from "./walkthrough.ts";

const FORGOTTEN = `### Forgotten moments
- First launch / orientation: M-03
- Learning the controls: M-03
- Waiting / idle: n/a — turn-based
- Failure and its feedback: n/a — v2
- Cancel / undo: M-04 (pick another insertion point)
- End of the loop and starting again: n/a — v2
- Switching modes or stages: every moment's Turns off
- Saving and coming back: n/a — later
`;

const BP = `# Blueprint: Leviathan

Goal: a train-sized machine you keep alive across a route map
Bar: product

## Reading
### Interpretations
- I-01 (S-08) "pick the next destination" — I read it as: select ONE reachable node; it is shown and can be changed; it takes effect when Travel starts. Not: walking the route by clicking.
### Additions
- A-01 The legacy room-capture rules are off once the Leviathan cycle is on.

## Walkthrough
### M-03 Chart the next leg
- Situation: the route map for this leg; the current node marked; reachable nodes lit
- Decision: which road — easy (forgo prizes) or hard (risk for better rewards)
- Needs to see: which nodes are reachable; each node's kind and risk; what is selected
- Does: click a reachable node (click another to change)
- Feedback: the node and its road highlight; "Next: <destination> — starts at Travel"
- Then: Travel moves the Leviathan to the chosen node
- Turns off: room charging, Q/E room cycling
### M-04 Blueprint the new wagon
- Situation: the whole train, insertion points marked between wagons
- Decision: where the new wagon goes and how long it is
- Needs to see: the train as it is now; the cost of each length
- Does: click an insertion point, then a length
- Feedback: a ghost wagon at that point
${FORGOTTEN}
## v1
- [ ] **R-11** Select the next leg on the route map · serves: S-07, S-08 · moment: M-03 · input: click a reachable node · proves: chart.spec.ts
- [ ] **R-12** Route generation: 5-20 nodes, up to 5 branches · serves: S-07 · proves: verify
- [ ] **R-13** Legacy rules off under the cycle · serves: A-01 · moment: M-03 · input: n/a · proves: verify
- [ ] **R-14** Place the wagon on the train · serves: A-02 · proves: blueprint.spec.ts
`;

const POINTS = [
  { id: "S-07", source: "SRC-1", where: "§2", quote: "Branching goes up to 5 branches wide.", line: 0 },
  { id: "S-08", source: "SRC-1", where: "§2", quote: "Chart — pick the next destination on a random map", line: 1 },
];

describe("plan walkthrough", () => {
  it("parses interpretations, additions, moments and the forgotten-moments answers", () => {
    const exp = parseExperience(BP);
    assert.deepEqual(exp.interpretations.map((i) => [i.id, i.points]), [["I-01", ["S-08"]]]);
    assert.deepEqual(exp.additions.map((a) => a.id), ["A-01"]);
    assert.deepEqual(exp.moments.map((m) => m.id), ["M-03", "M-04"]);
    assert.equal(exp.moments[0]!.fields["Needs to see"], "which nodes are reachable; each node's kind and risk; what is selected");
    assert.equal(exp.forgotten.size, 8);
  });

  it("product: incomplete moments, unbuilt moments, items without a moment and unknown additions are named", () => {
    const parsed = parseBlueprint(BP);
    const text = checkExperience(parsed, parseExperience(BP), new Set(["S-07", "S-08"])).join("\n");
    assert.match(text, /M-04 Blueprint the new wagon: missing Then, Turns off/);
    assert.match(text, /M-04 Blueprint the new wagon: no item builds this moment/);
    assert.match(text, /R-14: say which moment it belongs to/);
    assert.match(text, /R-14: serves A-02, but there is no A-02/);
    assert.doesNotMatch(text, /R-11|R-12|R-13|M-03/, "complete moment, its items, a verify rule");
  });

  it("product without a walkthrough or forgotten moments is told what to write; spec is not asked for one", () => {
    const bare = BP.slice(0, BP.indexOf("## Walkthrough")) + BP.slice(BP.indexOf("## v1"));
    const text = checkExperience(parseBlueprint(bare), parseExperience(bare), new Set()).join("\n");
    assert.match(text, /Product bar: no `## Walkthrough`/);
    const noChecklist = BP.replace(FORGOTTEN, "");
    assert.match(checkExperience(parseBlueprint(noChecklist), parseExperience(noChecklist), new Set()).join("\n"), /Forgotten moments` must answer each/);
    const spec = bare.replace("Bar: product", "Bar: spec");
    assert.deepEqual(checkExperience(parseBlueprint(spec), parseExperience(spec), new Set(["S-07", "S-08"])).filter((p) => !/A-02/.test(p)), []);
  });

  it("the brief for an item carries its moment, the source's own words and how they were read", () => {
    const parsed = parseBlueprint(BP);
    const ctx = itemContext(parsed.items.find((i) => i.id === "R-11")!, parseExperience(BP), POINTS);
    assert.match(ctx, /Moment M-03 Chart the next leg/);
    assert.match(ctx, /Then: Travel moves the Leviathan to the chosen node/);
    assert.match(ctx, /S-08: "Chart — pick the next destination on a random map"/);
    assert.match(ctx, /I-01: .*takes effect when Travel starts/);
    assert.equal(itemContext(parsed.items.find((i) => i.id === "R-12")!, parseExperience(BP), POINTS).includes("Moment"), false);
  });
});
