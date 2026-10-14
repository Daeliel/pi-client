import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coversMatch, formatStandardNote, nameWords, parseCovers, pickStandard } from "./select.ts";
import type { ScenarioDefinition } from "./types.ts";

const CWD = "/repo";

function spec(id: string): ScenarioDefinition {
  return { id, title: id, steps: "s", testFile: `.pi/scenarios/${id}.spec.ts`, kind: "web" };
}

function pick(specs: ScenarioDefinition[], changed: string[], files: Record<string, string> = {}, focus: string[] = []) {
  return pickStandard(CWD, specs, changed, focus, (f) => files[f] ?? "");
}

describe("standard level: which specs a change runs", () => {
  it("splits file names into words, camelCase and plurals included", () => {
    assert.deepEqual(nameWords("src/world/craneYard.js"), ["crane", "yard"]);
    assert.deepEqual(nameWords(".pi/scenarios/room-energy-pool.spec.ts"), ["room", "energy", "pool"]);
    assert.deepEqual(nameWords("src/systems/units.js"), ["unit"]);
    assert.deepEqual(nameWords("src/main.js"), [], "main says nothing about what a spec covers");
  });

  it("reads @covers lines and matches files, folders and globs", () => {
    assert.deepEqual(parseCovers("// @covers: src/systems/energy.js, src/ui/**\n// @covers src/render/"), [
      "src/systems/energy.js",
      "src/ui/**",
      "src/render/",
    ]);
    assert.ok(coversMatch("src/ui/**", "src/ui/hud/bar.js"));
    assert.ok(coversMatch("src/render/", "src/render/rooms.js"));
    assert.ok(coversMatch("src/*.js", "src/main.js"));
    assert.ok(!coversMatch("src/*.js", "src/ui/main.js"));
    assert.ok(coversMatch("src/systems", "src/systems/energy.js"));
    assert.ok(!coversMatch("src/systems/energy.js", "src/systems/energyx.js"));
  });

  it("runs the specs the changed code belongs to, by name or by header", () => {
    const specs = [spec("energy-charge"), spec("travel-stage"), spec("route-map"), spec("hud")];
    const files = { ".pi/scenarios/hud.spec.ts": "// @covers: src/ui/**\ntest('hud', ...)" };
    const got = pick(specs, ["src/systems/energy.js", "src/ui/topBar.js"], files);
    assert.deepEqual(got.run.map((s) => s.id), ["energy-charge", "hud"]);
    assert.equal(got.reasons["energy-charge"], "name matches src/systems/energy.js");
    assert.equal(got.reasons.hud, "covers src/ui/topbar.js");
    assert.deepEqual(got.skipped.map((s) => s.id), ["travel-stage", "route-map"]);
    assert.deepEqual(got.uncovered, []);
  });

  it("a header replaces name matching, so a spec can opt out of loose matches", () => {
    const files = { ".pi/scenarios/energy-charge.spec.ts": "// @covers: src/systems/charge.js" };
    const got = pick([spec("energy-charge")], ["src/systems/energy.js"], files);
    assert.deepEqual(got.run, []);
    assert.deepEqual(got.uncovered, ["src/systems/energy.js"]);
  });

  it("always runs smoke specs and the task's own specs", () => {
    const specs = [spec("smoke-core-loop"), spec("cycle-full"), spec("wagon-train"), spec("blueprint")];
    const files = { ".pi/scenarios/cycle-full.spec.ts": "test('plays a whole cycle @smoke', ...)" };
    const got = pick(specs, ["src/main.js"], files, [".pi/scenarios/blueprint.spec.ts"]);
    assert.deepEqual(got.run.map((s) => s.id), ["smoke-core-loop", "cycle-full", "blueprint"]);
    assert.equal(got.reasons.blueprint, "this task");
    assert.equal(got.reasons["cycle-full"], "smoke");
    assert.deepEqual(got.uncovered, ["src/main.js"], "main.js matched nothing but smoke");
  });

  it("ignores docs and the spec files themselves when deciding what changed", () => {
    const got = pick([spec("energy-charge")], ["DESIGN.md", ".pi/scenarios/energy-charge.spec.ts"]);
    assert.deepEqual(got.run, []);
    assert.deepEqual(got.uncovered, []);
  });

  it("the note says what ran and how to run everything", () => {
    const got = pick([spec("energy-charge"), spec("travel-stage")], ["src/systems/energy.js", "src/main.js"]);
    const note = formatStandardNote(got);
    assert.match(note, /ran 1 of 2 spec\(s\) — energy-charge \(name matches src\/systems\/energy\.js\)/);
    assert.match(note, /No spec covers: src\/main\.js/);
    assert.match(note, /all: true/);
  });
});
