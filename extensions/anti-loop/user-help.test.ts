import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isEditTool,
  isFruitlessResult,
  lastRecoveryUsesUserHelp,
  shouldNotifyApproachChurn,
} from "./user-help";

describe("isEditTool", () => {
  it("counts write/edit as progress", () => {
    assert.equal(isEditTool("edit"), true);
    assert.equal(isEditTool("write"), true);
  });

  it("does not count read/grep/bash", () => {
    assert.equal(isEditTool("read"), false);
    assert.equal(isEditTool("bash"), false);
    assert.equal(isEditTool("grep"), false);
  });
});

describe("lastRecoveryUsesUserHelp", () => {
  it("uses user-help on the last repeat/thinking/stuck recovery", () => {
    assert.equal(lastRecoveryUsesUserHelp("repeat", 2, 2), true);
    assert.equal(lastRecoveryUsesUserHelp("thinking", 2, 2), true);
    assert.equal(lastRecoveryUsesUserHelp("stuck", 2, 2), true);
  });

  it("keeps earlier recoveries on the original steer", () => {
    assert.equal(lastRecoveryUsesUserHelp("repeat", 1, 2), false);
  });

  it("does not swap truncation or ghost recoveries", () => {
    assert.equal(lastRecoveryUsesUserHelp("truncation", 2, 2), false);
    assert.equal(lastRecoveryUsesUserHelp("ghost", 2, 2), false);
  });
});

describe("shouldNotifyApproachChurn", () => {
  const base = {
    uniqueFingerprints: 8,
    fruitlessCalls: 0,
    editCount: 0,
    threshold: 30,
    fruitlessThreshold: 5,
    alreadyNotified: false,
    userHelpActive: false,
  };

  it("reading code that finds things is exploring, not thrashing", () => {
    assert.equal(shouldNotifyApproachChurn(base), false, "8 productive reads, no edit yet");
  });

  it("notifies after enough calls that found nothing", () => {
    assert.equal(shouldNotifyApproachChurn({ ...base, fruitlessCalls: 5 }), true);
    assert.equal(shouldNotifyApproachChurn({ ...base, fruitlessCalls: 4 }), false);
  });

  it("a high backstop catches a run that reads forever without acting", () => {
    assert.equal(shouldNotifyApproachChurn({ ...base, uniqueFingerprints: 30 }), true);
    assert.equal(shouldNotifyApproachChurn({ ...base, uniqueFingerprints: 30, threshold: 0 }), false, "0 disables");
  });

  it("does not notify once an edit happened, twice, or while user-help is active", () => {
    const stuck = { ...base, fruitlessCalls: 9 };
    assert.equal(shouldNotifyApproachChurn({ ...stuck, editCount: 1 }), false);
    assert.equal(shouldNotifyApproachChurn({ ...stuck, alreadyNotified: true }), false);
    assert.equal(shouldNotifyApproachChurn({ ...stuck, userHelpActive: true }), false);
  });
});

describe("isFruitlessResult", () => {
  const text = (t: string) => [{ type: "text", text: t }];
  it("errors and empty output found nothing; content and screenshots did", () => {
    assert.equal(isFruitlessResult(true, text("Command exited with code 1")), true, "failed command / grep without a match");
    assert.equal(isFruitlessResult(false, text("(no output)")), true);
    assert.equal(isFruitlessResult(false, text("   ")), true);
    assert.equal(isFruitlessResult(false, text("1218:  y: padY + ((i + 0.5) / col.length) * usableH,")), false);
    assert.equal(isFruitlessResult(false, [{ type: "image", data: "x", mimeType: "image/png" }]), false);
  });
});
