import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildScenariosProcedure, LEVEL_TEXT, SCENARIOS_CORE } from "./procedure.ts";

describe("scenarios procedure tiers", () => {
  it("core alone is short and has no flutter canvas block", () => {
    const text = buildScenariosProcedure({ includeWeb: false, includeFlutter: false });
    assert.ok(text.includes("Lane A"));
    assert.ok(!text.includes("two browsers"));
    assert.ok(!text.includes("flutter build web"));
    assert.ok(text.length < SCENARIOS_CORE.length + LEVEL_TEXT.thorough.length + 80);
  });

  it("says where tests go at every level, and how much each level runs", () => {
    const thorough = buildScenariosProcedure({ includeWeb: false, includeFlutter: false });
    const standard = buildScenariosProcedure({ includeWeb: false, includeFlutter: false, level: "standard" });
    for (const text of [thorough, standard]) {
      assert.match(text, /One spec file per area/);
      assert.match(text, /@covers/);
      assert.match(text, /unit tests/);
    }
    assert.match(thorough, /every spec runs on every code change/, "thorough is the default");
    assert.match(standard, /all: true/);
  });

  it("web adds two-browser table without requiring flutter", () => {
    const text = buildScenariosProcedure({ includeWeb: true, includeFlutter: false });
    assert.match(text, /two browsers/i);
    assert.ok(!text.includes("After Dart edits"));
  });

  it("flutter adds rebuild guidance", () => {
    const text = buildScenariosProcedure({
      includeWeb: true,
      includeFlutter: true,
      stackSummary: "Stack: flutter (web UI).",
    });
    assert.match(text, /flutter build web/i);
    assert.match(text, /Stack: flutter/);
  });
});
