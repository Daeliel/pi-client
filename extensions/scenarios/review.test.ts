import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "./config.ts";
import { auditScenarios } from "./housekeeping.ts";
import { alreadyReviewed, buildPendingReview, markReviewed, validateProposal } from "./review.ts";
import type { ScenarioDefinition } from "./types.ts";

function withProject(fn: (cwd: string, specs: ScenarioDefinition[]) => void) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-"));
  try {
    fs.mkdirSync(path.join(cwd, ".pi/scenarios"), { recursive: true });
    const specs = ["login", "login-v2", "save-load"].map((id) => {
      const testFile = `.pi/scenarios/${id}.spec.ts`;
      fs.writeFileSync(path.join(cwd, testFile), "");
      return { id, title: id, steps: "s", testFile, kind: "web" as const };
    });
    fn(cwd, specs);
  } finally {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      // Windows may hold the dir briefly; leftovers in tmp are harmless.
    }
  }
}

describe("scenario review", () => {
  it("waits for a new spec before reviewing the same set again", () => {
    withProject((cwd, specs) => {
      assert.equal(alreadyReviewed(cwd, DEFAULT_CONFIG, specs), false);
      markReviewed(cwd, DEFAULT_CONFIG, specs);
      assert.equal(alreadyReviewed(cwd, DEFAULT_CONFIG, specs), true);
      assert.equal(alreadyReviewed(cwd, DEFAULT_CONFIG, specs.slice(1)), true, "a deletion is not new");
      const added = { ...specs[0]!, id: "checkout", testFile: ".pi/scenarios/checkout.spec.ts" };
      assert.equal(alreadyReviewed(cwd, DEFAULT_CONFIG, [...specs, added]), false);
    });
  });

  it("accepts listed specs only, never the task's own", () => {
    withProject((cwd, specs) => {
      const audit = auditScenarios(cwd, DEFAULT_CONFIG, specs);
      const review = buildPendingReview(cwd, specs, audit, { login: "pass" }, [".pi/scenarios/save-load.spec.ts"]);
      assert.deepEqual(review.candidates.map((c) => c.id), ["login", "login-v2"]);
      assert.equal(review.candidates[1]?.group, "login");

      const { valid, rejected } = validateProposal(cwd, review, [
        { file: ".pi\\scenarios\\login-v2.spec.ts", reason: "copy of login" },
        { file: ".pi/scenarios/login-v2.spec.ts", reason: "duplicate entry" },
        { file: ".pi/scenarios/save-load.spec.ts", reason: "x" },
        { file: "src/app.ts", reason: "x" },
      ]);
      assert.deepEqual(valid, [{ file: ".pi/scenarios/login-v2.spec.ts", reason: "copy of login" }]);
      assert.equal(rejected.length, 2);
      assert.match(rejected[0]!, /task that just passed/);
      assert.match(rejected[1]!, /not in the review list/);
    });
  });
});
