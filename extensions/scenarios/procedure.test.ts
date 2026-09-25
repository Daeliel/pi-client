import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildScenariosProcedure, SCENARIOS_CORE } from "./procedure.ts";

describe("scenarios procedure tiers", () => {
  it("core alone is short and has no flutter canvas block", () => {
    const text = buildScenariosProcedure({ includeWeb: false, includeFlutter: false });
    assert.ok(text.includes("Lane A"));
    assert.ok(!text.includes("two browsers"));
    assert.ok(!text.includes("flutter build web"));
    assert.ok(text.length < SCENARIOS_CORE.length + 80);
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
