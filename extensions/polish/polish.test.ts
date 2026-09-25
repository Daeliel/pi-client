import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferLevel, isVagueImprovePrompt, parseLevelPrefix } from "./infer";
import {
  addSurfaceFiles,
  emptyInventory,
  isSameWeakness,
  pickNextSurface,
  recordWeaknesses,
  seedFromScenarios,
  surfacesMentioned,
  surfacesTouchingFiles,
  upsertSurface,
} from "./inventory";
import { parseCriticReply } from "./procedure";
import { levelAtLeast, loadConfig } from "./config";
import { clearOnceModifiers, parseOnceArgs, registerOnceModifier } from "../shared/once";

describe("parseLevelPrefix", () => {
  it("strips +level and polish:level prefixes", () => {
    assert.deepEqual(parseLevelPrefix("+showcase build a snake game"), { level: "showcase", text: "build a snake game" });
    assert.deepEqual(parseLevelPrefix("polish:off rename foo"), { level: "off", text: "rename foo" });
  });
  it("ignores unknown words and bash-style bangs", () => {
    assert.equal(parseLevelPrefix("+foo do it"), null);
    assert.equal(parseLevelPrefix("!ls"), null);
    assert.equal(parseLevelPrefix("build a game"), null);
  });
});

describe("inferLevel", () => {
  it("picks standard for user-facing prompts", () => {
    assert.equal(inferLevel("build me a snake game with a main menu", false).level, "standard");
  });
  it("picks off for maintenance prompts", () => {
    assert.equal(inferLevel("fix the crash in the parser", false).level, "off");
    assert.equal(inferLevel("write a script that renames files", true).level, "off");
  });
  it("picks basic when UI is mentioned but it reads like a fix", () => {
    assert.equal(inferLevel("fix the bug in the settings page", false).level, "basic");
  });
  it("treats vague improvement in a UI project as standard", () => {
    assert.equal(inferLevel("make it look nicer", true).level, "standard");
    assert.equal(isVagueImprovePrompt("the menu still looks meh"), true);
    assert.equal(isVagueImprovePrompt("make the menu buttons 20px taller"), false);
  });
});

describe("weakness matching", () => {
  it("recognises the same weakness worded differently", () => {
    assert.equal(
      isSameWeakness(
        "Menu buttons — flat grey rectangles with no hover — rounded accent buttons with hover lift",
        "Main menu buttons — still flat grey, no hover state — add accent colour and hover",
      ),
      true,
    );
  });
  it("keeps different weaknesses apart", () => {
    assert.equal(
      isSameWeakness("Title — default serif font — use the display font", "Footer — cramped spacing — double the padding"),
      false,
    );
  });
  it("counts namings, clears unnamed ones, and flags exhaustion", () => {
    const inv = emptyInventory();
    const s = upsertSurface(inv, "Main menu", "/");
    let r = recordWeaknesses(s, ["Buttons — flat grey — accent + hover", "Title — default font — display font"], 3);
    assert.equal(r.fresh.length, 2);
    r = recordWeaknesses(s, ["Buttons — still flat grey with no hover — accent + hover"], 3);
    assert.equal(r.repeated.length, 1);
    assert.equal(r.resolved.length, 1);
    assert.equal(r.exhausted.length, 0);
    r = recordWeaknesses(s, ["Buttons — flat grey, no hover — accent + hover"], 3);
    assert.equal(r.exhausted.length, 1);
    assert.equal(r.exhausted[0]!.namings, 3);
  });
});

describe("inventory", () => {
  it("seeds web scenarios only, never duplicates, remembers the spec file", () => {
    const inv = emptyInventory();
    const { added, touched } = seedFromScenarios(inv, [
      { title: "Main menu", kind: "web", testFile: ".pi/scenarios/main-menu.spec.ts" },
      { title: "API health", kind: "api" },
      { title: "main menu", kind: "web" },
    ]);
    assert.equal(added.length, 1);
    assert.equal(touched.length, 2);
    assert.equal(inv.surfaces.length, 1);
    assert.deepEqual(inv.surfaces[0]!.files, [".pi/scenarios/main-menu.spec.ts"]);
  });
  it("attributes files to surfaces and scopes the picker", () => {
    const inv = emptyInventory();
    const dungeon = upsertSurface(inv, "Dungeon", "/dungeon");
    const menu = upsertSurface(inv, "Main menu", "/");
    addSurfaceFiles(dungeon, ["src/dungeon/doors.ts", ".pi/scenarios/ignored.spec.ts"]);
    assert.deepEqual(dungeon.files, ["src/dungeon/doors.ts"]);
    const hits = surfacesTouchingFiles(inv, ["D:\\proj\\src\\Dungeon\\Doors.ts"]);
    assert.deepEqual(hits.map((s) => s.id), [dungeon.id]);
    // Scope limited to Dungeon: the raw menu is never picked, even though raw-first would prefer it.
    assert.equal(pickNextSurface(inv, "ultimate", new Set(), new Set([dungeon.id]))?.id, dungeon.id);
    dungeon.status = "polished";
    assert.equal(pickNextSurface(inv, "standard", new Set(), new Set([dungeon.id])), undefined);
    assert.equal(pickNextSurface(inv, "ultimate", new Set(), new Set([dungeon.id]))?.id, dungeon.id);
    assert.equal(menu.status, "raw");
  });
  it("finds surfaces mentioned in a prompt", () => {
    const inv = emptyInventory();
    upsertSurface(inv, "Main menu");
    upsertSurface(inv, "Settings");
    const hits = surfacesMentioned(inv, "The main menu still looks meh");
    assert.deepEqual(hits.map((s) => s.name), ["Main menu"]);
  });
  it("picks raw first; polished only at ultimate", () => {
    const inv = emptyInventory();
    const a = upsertSurface(inv, "A");
    const b = upsertSurface(inv, "B");
    a.status = "polished";
    assert.equal(pickNextSurface(inv, "standard", new Set())?.id, b.id);
    b.status = "polished";
    assert.equal(pickNextSurface(inv, "standard", new Set()), undefined);
    assert.equal(pickNextSurface(inv, "ultimate", new Set())?.id, a.id);
    assert.equal(pickNextSurface(inv, "ultimate", new Set([a.id, b.id])), undefined);
  });
});

describe("parseCriticReply", () => {
  it("parses WEAKNESS lines and caps at three", () => {
    const r = parseCriticReply("WEAKNESS: a — b — c\n- WEAKNESS: d — e — f\nWEAKNESS: g\nWEAKNESS: h");
    assert.equal(r.weaknesses.length, 3);
    assert.equal(r.none, false);
    assert.equal(r.unparsed, false);
  });
  it("recognises NONE and flags unparsable replies", () => {
    assert.equal(parseCriticReply("NONE: it holds up").none, true);
    assert.equal(parseCriticReply("Looks great overall!").unparsed, true);
  });
});

describe("/once parsing", () => {
  it("peels known modifiers off the front and keeps the rest as the prompt", () => {
    clearOnceModifiers();
    let applied: string[] = [];
    for (const name of ["ultimate", "research"]) {
      registerOnceModifier({ name, description: name, owner: "test", apply: () => applied.push(name) });
    }
    const p = parseOnceArgs("ultimate research build me a snake game");
    assert.deepEqual(p.modifiers.map((m) => m.name), ["ultimate", "research"]);
    assert.equal(p.prompt, "build me a snake game");
    assert.equal(p.unknownFirst, null);
    for (const m of p.modifiers) m.apply();
    assert.deepEqual(applied, ["ultimate", "research"]);

    const bad = parseOnceArgs("shiny build me a game");
    assert.equal(bad.modifiers.length, 0);
    assert.equal(bad.unknownFirst, "shiny");

    const noPrompt = parseOnceArgs("ultimate");
    assert.equal(noPrompt.modifiers.length, 1);
    assert.equal(noPrompt.prompt, "");
    clearOnceModifiers();
  });
});

describe("config", () => {
  it("has sane defaults and level ordering", () => {
    const cfg = loadConfig("Z:\\definitely\\not\\a\\project");
    assert.equal(cfg.passes.off, 0);
    assert.equal(cfg.passes.standard >= 1, true);
    assert.equal(levelAtLeast("showcase", "standard"), true);
    assert.equal(levelAtLeast("basic", "standard"), false);
  });
});
