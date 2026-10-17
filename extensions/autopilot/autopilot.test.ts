import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { budgetDecision, parseBudget } from "./budget.ts";
import { slugify } from "./checkpoints.ts";

describe("budget", () => {
  const base = { usedMinutes: 0, budgetMinutes: 180, finished: 0, open: 5, replanAt: -1 };

  it("no limit always goes; an exhausted budget stops", () => {
    assert.equal(budgetDecision({ ...base, budgetMinutes: null, usedMinutes: 9999 }), "go");
    assert.equal(budgetDecision({ ...base, usedMinutes: 180 }), "stop");
  });

  it("stops at a boundary when not even half an average item fits", () => {
    // 4 items in 160 min = 40 min each; 15 min left < 20.
    assert.equal(budgetDecision({ ...base, usedMinutes: 165, finished: 4, open: 1 }), "stop");
    assert.equal(budgetDecision({ ...base, usedMinutes: 150, finished: 4, open: 1 }), "go");
  });

  it("asks for a re-plan once per finished item when the pace will not fit", () => {
    // 2 items in 60 min = 30 each; 5 open = 150 min > 120 left × 1.1.
    const behind = { ...base, usedMinutes: 60, finished: 2, open: 5 };
    assert.equal(budgetDecision(behind), "replan");
    assert.equal(budgetDecision({ ...behind, replanAt: 2 }), "go", "already asked at this count");
    assert.equal(budgetDecision({ ...behind, open: 3 }), "go", "3 × 30 fits in 120");
    assert.equal(budgetDecision({ ...base, usedMinutes: 30 }), "go", "no pace before the first item");
  });

  it("parses budgets", () => {
    assert.equal(parseBudget("90"), 90);
    assert.equal(parseBudget("90m"), 90);
    assert.equal(parseBudget("1.5h"), 90);
    assert.equal(parseBudget("2:30"), 150);
    assert.equal(parseBudget(""), null);
    assert.equal(parseBudget("soon"), "invalid");
  });
});

describe("checkpoint branch names", () => {
  it("keeps whole words", () => {
    assert.equal(slugify("Make a.app say fixed and b.app record the second step"), "make-a-app-say-fixed-and-b-app-record");
    assert.equal(slugify("!!!"), "run");
  });
});
