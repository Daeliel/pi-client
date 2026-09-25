import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attemptNotes, RepeatTracker } from "./gate-messages";

describe("gate messages", () => {
  it("treats failures that differ only in timings and counts as the same", () => {
    const t = new RepeatTracker();
    assert.equal(t.repeated("FAIL test_login (0.31s) expected 3 got 2"), false);
    assert.equal(t.repeated("FAIL test_login (0.45s) expected 3 got 2"), true);
    assert.equal(t.repeated("FAIL test_login (0.52s) expected 3 got 1"), false, "a changed value is progress");
    assert.equal(t.repeated("FAIL test_signup expected 3 got 1"), false);
    assert.equal(t.repeated("a.py:42:7 NameError x"), false);
    assert.equal(t.repeated("a.py:45:7 NameError x"), true, "line numbers shift with edits");
  });

  it("warns on repeats and on the last attempt", () => {
    assert.equal(attemptNotes(1, 5, false), "");
    assert.match(attemptNotes(2, 5, true), /SAME FAILURE/);
    assert.match(attemptNotes(5, 5, false), /LAST ATTEMPT \(5\/5\)/);
  });
});
