import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clipMiddle, stripAnsi } from "./output";

describe("output helpers", () => {
  it("strips colour codes", () => {
    assert.equal(stripAnsi("\u001b[31mFAIL\u001b[39m test.ts"), "FAIL test.ts");
  });

  it("keeps both ends when clipping", () => {
    const text = `START ${"x".repeat(5000)} 3 tests failed`;
    const out = clipMiddle(text, 400);
    assert.ok(out.startsWith("START"));
    assert.ok(out.endsWith("3 tests failed"));
    assert.ok(out.length < 500);
  });

  it("returns short text unchanged", () => {
    assert.equal(clipMiddle("  short  ", 400), "short");
  });
});
