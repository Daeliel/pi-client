import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "./config";
import { addIdeas, applyMap, autoPick, emptyLedger, findIdea, loadLedger, parsePillars, saveLedger, setStatus } from "./ledger";
import { buildIdeasPrompt, parseFitReply } from "./procedure";

describe("ledger: pillars and map", () => {
  it("parses pillars split by ; | or newline and strips bullets", () => {
    assert.deepEqual(parsePillars("fast runs; build variety | readable danger"), ["fast runs", "build variety", "readable danger"]);
    assert.deepEqual(parsePillars("- a\n2. b"), ["a", "b"]);
  });
  it("replaces or merges the systems map by name", () => {
    const l = emptyLedger();
    applyMap(l, { systems: [{ name: "Weapons", kind: "pool", count: 12, summary: "melee only" }], gaps: ["0 ranged"] }, false);
    applyMap(l, { systems: [{ name: "weapons", kind: "pool", count: 14, summary: "melee + ranged" }, { name: "Combat", kind: "system", summary: "turns" }], gaps: ["no synergy"] }, true);
    assert.equal(l.map!.systems.length, 2);
    assert.equal(l.map!.systems[0]!.count, 14);
    assert.deepEqual(l.map!.gaps, ["0 ranged", "no synergy"]);
    applyMap(l, { systems: [{ name: "Combat", kind: "system", summary: "turns" }] }, false);
    assert.equal(l.map!.systems.length, 1);
    assert.deepEqual(l.map!.gaps, []);
  });
});

describe("ledger: ideas", () => {
  const base = () => ({ axis: "more" as const, gap: "g", size: "M" as const, fit: "medium" as const });
  it("refuses ideas that build on nothing, numbers the rest, remembers rejections", () => {
    const l = emptyLedger();
    const r = addIdeas(l, [
      { ...base(), title: "Add a shop", buildsOn: [] },
      { ...base(), title: "Antidote consumable", buildsOn: ["Consumables", "Poison"] },
      { ...base(), title: "Ranged weapons", buildsOn: ["Weapons"] },
    ]);
    assert.equal(r.refused.length, 1);
    assert.deepEqual(r.added.map((i) => i.n), [1, 2]);
    setStatus(findIdea(l, 1)!, "rejected");
    const again = addIdeas(l, [{ ...base(), title: "antidote consumable!", buildsOn: ["Poison"] }]);
    assert.equal(again.added.length, 0);
    assert.match(again.refused[0]!.why, /rejected as #1/);
    // Re-proposing an open idea updates rather than duplicates; numbers are never reused.
    addIdeas(l, [{ ...base(), title: "Ranged Weapons", buildsOn: ["Weapons"], fit: "high" }]);
    assert.equal(l.ideas.length, 2);
    assert.equal(findIdea(l, 2)!.fit, "high");
    assert.equal(addIdeas(l, [{ ...base(), title: "New", buildsOn: ["X"] }]).added[0]!.n, 3);
  });
  it("auto-picks by fit then size and never picks low fit", () => {
    const l = emptyLedger();
    addIdeas(l, [
      { ...base(), title: "A", buildsOn: ["x"], fit: "low", size: "S" },
      { ...base(), title: "B", buildsOn: ["x"], fit: "medium", size: "S" },
      { ...base(), title: "C", buildsOn: ["x"], fit: "high", size: "L" },
      { ...base(), title: "D", buildsOn: ["x"], fit: "high", size: "S" },
    ]);
    assert.deepEqual(autoPick(l, 2).map((i) => i.title), ["D", "C"]);
    assert.deepEqual(autoPick(l, 10).map((i) => i.title), ["D", "C", "B"]);
  });
  it("round-trips through disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expand-"));
    try {
      const l = emptyLedger();
      l.pillars = ["p"];
      addIdeas(l, [{ ...base(), title: "T", buildsOn: ["x"] }]);
      saveLedger(dir, ".pi/expand/ledger.json", l);
      const back = loadLedger(dir, ".pi/expand/ledger.json");
      assert.deepEqual(back.pillars, ["p"]);
      assert.equal(back.ideas[0]!.title, "T");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("procedure", () => {
  it("ideas prompt carries memory, focus and the cross rule for deeper", () => {
    const l = emptyLedger();
    addIdeas(l, [{ title: "Shop", axis: "more", buildsOn: ["Gold"], gap: "g", size: "S", fit: "low" }]);
    setStatus(findIdea(l, 1)!, "rejected");
    const p = buildIdeasPrompt({ ledger: l, axes: ["deeper"], focus: "early game", count: 4, autoBudget: null });
    assert.match(p, /Rejected before[\s\S]*Shop/);
    assert.match(p, /User focus: "early game"/);
    assert.match(p, /CROSS two existing/);
    assert.match(p, /no systems map yet/);
    assert.match(p, /Then STOP/);
    const auto = buildIdeasPrompt({ ledger: l, axes: ["more"], focus: "", count: 4, autoBudget: 2 });
    assert.match(auto, /AUTO MODE/);
  });
  it("parses fit critic replies", () => {
    assert.deepEqual(parseFitReply("FINDING: Reachable — not wired — add menu entry\nFINDING: Explained — no label — tooltip"), {
      findings: ["Reachable — not wired — add menu entry", "Explained — no label — tooltip"],
      none: false,
      unparsed: false,
    });
    assert.equal(parseFitReply("NONE: fits.").none, true);
    assert.equal(parseFitReply("Looks great!").unparsed, true);
  });
});

describe("config", () => {
  it("clamps numbers and keeps defaults", () => {
    const c = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), "expand-cfg-")));
    assert.equal(c.ideasPerPass, 6);
    assert.equal(c.fitPasses, 1);
    assert.equal(c.autoMax, 3);
  });
});
