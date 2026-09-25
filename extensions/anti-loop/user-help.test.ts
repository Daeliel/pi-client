import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isEditTool,
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
    uniqueFingerprints: 6,
    editCount: 0,
    threshold: 6,
    alreadyNotified: false,
    userHelpActive: false,
  };

  it("notifies at the unique-tool threshold with no edits", () => {
    assert.equal(shouldNotifyApproachChurn(base), true);
  });

  it("does not notify when an edit already happened", () => {
    assert.equal(shouldNotifyApproachChurn({ ...base, editCount: 1 }), false);
  });

  it("does not notify twice or while user-help is active", () => {
    assert.equal(shouldNotifyApproachChurn({ ...base, alreadyNotified: true }), false);
    assert.equal(shouldNotifyApproachChurn({ ...base, userHelpActive: true }), false);
  });

  it("threshold 0 disables the notify", () => {
    assert.equal(shouldNotifyApproachChurn({ ...base, threshold: 0 }), false);
  });
});
