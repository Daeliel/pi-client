import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withGateWorkingMessage } from "./working-status.ts";

function fakeCtx(messages: (string | undefined)[]): ExtensionContext {
  return { hasUI: true, ui: { setWorkingMessage: (m?: string) => messages.push(m) } } as unknown as ExtensionContext;
}

describe("withGateWorkingMessage", () => {
  it("shows the label with elapsed time, then the current step, then restores the default", async () => {
    const messages: (string | undefined)[] = [];
    const out = await withGateWorkingMessage(fakeCtx(messages), "Gate", async (status) => {
      status.step("Scenario 1/2: login");
      return 42;
    });
    assert.equal(out, 42);
    assert.deepEqual(messages, ["Gate · 0:00", "Gate — Scenario 1/2: login · 0:00", undefined]);
  });

  it("keeps ticking while a step runs long", async () => {
    const messages: (string | undefined)[] = [];
    await withGateWorkingMessage(fakeCtx(messages), "Gate", async (status) => {
      status.step("slow");
      // Past two ticks: under load a tick can land a hair before the second boundary.
      await new Promise((r) => setTimeout(r, 2200));
    });
    assert.ok(messages.some((m) => /^Gate — slow · 0:0[12]$/.test(m ?? "")), JSON.stringify(messages));
  });
});
