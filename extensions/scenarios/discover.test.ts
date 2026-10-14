import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { specPathKey, splitVanishedScenarios } from "./discover.ts";
import type { ScenarioDefinition } from "./types.ts";

function scenario(id: string, testFile: string): ScenarioDefinition {
  return { id, title: id, steps: "s", testFile, kind: "web" };
}

describe("splitVanishedScenarios", () => {
  it("drops a registered spec that was on disk and is gone, keeps never-written ones", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-discover-"));
    try {
      fs.mkdirSync(path.join(cwd, ".pi/scenarios"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi/scenarios/type-cycle.spec.ts"), "");

      const renamed = scenario("room-type-cycling", ".pi/scenarios/room-type-cycling.spec.ts");
      const current = scenario("type-cycle", ".pi/scenarios/type-cycle.spec.ts");
      const notYetWritten = scenario("save-load", ".pi/scenarios/save-load.spec.ts");
      // Seen spelled differently (backslashes, absolute) — still the same file.
      const seen = new Set([specPathKey(cwd, path.join(cwd, ".pi\\scenarios\\room-type-cycling.spec.ts"))]);

      const { kept, vanished } = splitVanishedScenarios(cwd, [renamed, current, notYetWritten], seen);
      assert.deepEqual(vanished.map((s) => s.id), ["room-type-cycling"]);
      assert.deepEqual(kept.map((s) => s.id), ["type-cycle", "save-load"]);
    } finally {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        // Windows may hold the dir briefly; leftovers in tmp are harmless.
      }
    }
  });
});
