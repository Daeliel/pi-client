import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resetGateClaim,
  tryClaimGate,
  isGateClaimed,
  getClaimedGate,
} from "./gate-orchestrator.ts";

describe("gate-orchestrator", () => {
  it("allows only one claim per turn", () => {
    resetGateClaim();
    assert.equal(isGateClaimed(), false);
    assert.equal(tryClaimGate("verify"), true);
    assert.equal(getClaimedGate(), "verify");
    assert.equal(tryClaimGate("scenarios"), false);
    assert.equal(tryClaimGate("browser"), false);
    assert.equal(isGateClaimed(), true);
  });

  it("resets between turns", () => {
    resetGateClaim();
    tryClaimGate("scenarios");
    resetGateClaim();
    assert.equal(isGateClaimed(), false);
    assert.equal(tryClaimGate("browser"), true);
    assert.equal(getClaimedGate(), "browser");
  });
});
