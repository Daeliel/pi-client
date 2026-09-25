import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyScenarioFailure,
  classifyVerifyFailure,
  formatClassifiedFailure,
  LABEL_TRUST_WARNING,
} from "./failure-classify.ts";

describe("failure-classify", () => {
  it("labels stale flutter build from preflight", () => {
    const c = classifyScenarioFailure({
      report: "[FAIL] x — exit 1\nsome assert",
      preflightWarnings: ["WARNING: Stale web build — lib/**/*.dart is newer than build/web."],
    });
    assert.equal(c.label, "stale_build");
    assert.match(c.next, /flutter build web/i);
  });

  it("labels connection refused as server_down", () => {
    const c = classifyScenarioFailure({
      report: "[FAIL] home: load — exit 1\nError: net::ERR_CONNECTION_REFUSED at http://localhost:5173",
    });
    assert.equal(c.label, "server_down");
  });

  it("labels weak spec blocking", () => {
    const c = classifyScenarioFailure({
      report: "WEAK SPEC PATTERNS\nFAIL: Playwright exited 0 but spec proof is too weak",
      weakSpecBlocking: true,
    });
    assert.equal(c.label, "weak_spec");
  });

  it("labels missing test files", () => {
    const c = classifyScenarioFailure({
      report: "Missing test files",
      missingFiles: [".pi/scenarios/foo.spec.ts"],
    });
    assert.equal(c.label, "missing_test_file");
  });

  it("labels assert failures", () => {
    const c = classifyScenarioFailure({
      report: "[FAIL] hist: empty — exit 1\nError: expect(locator).toBeVisible() failed\nExpected: visible",
    });
    assert.equal(c.label, "assert_fail");
  });

  it("format includes trust warning", () => {
    const c = classifyScenarioFailure({ report: "[FAIL] x — exit 1\nExpected something" });
    const text = formatClassifiedFailure(c, "Intro.");
    assert.match(text, /LABEL:/);
    assert.ok(text.includes(LABEL_TRUST_WARNING));
    assert.match(text, /EVIDENCE:/);
    assert.match(text, /RAW:/);
  });

  it("classifies verify lint vs test", () => {
    assert.equal(classifyVerifyFailure("[FAIL] python lint\nruff check: E501").label, "lint_fail");
    assert.equal(
      classifyVerifyFailure("[FAIL] node test\nnpm test\nAssertionError: boom").label,
      "test_fail",
    );
  });
});
