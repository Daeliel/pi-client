import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { syncOwnedTools } from "./tool-activation";

function fakePi(active: string[]) {
  const calls: string[][] = [];
  return {
    calls,
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      calls.push(names);
      active = names;
    },
  };
}

describe("syncOwnedTools", () => {
  it("only adds and removes the tools an extension owns", () => {
    const pi = fakePi(["read", "bash", "release_build", "web_search"]);
    syncOwnedTools(pi, ["release_doctor", "release_build"], []);
    assert.deepEqual(pi.getActiveTools(), ["read", "bash", "web_search"]);
    syncOwnedTools(pi, ["release_doctor", "release_build"], ["release_doctor"]);
    assert.deepEqual(pi.getActiveTools(), ["read", "bash", "web_search", "release_doctor"]);
  });

  it("does not call setActiveTools when nothing changes", () => {
    const pi = fakePi(["read", "verify"]);
    syncOwnedTools(pi, ["verify"], ["verify"]);
    assert.equal(pi.calls.length, 0);
  });
});
