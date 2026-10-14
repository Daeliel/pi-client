import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "./config.ts";
import { formatScenarioProgress, runScenarios, type ScenarioProgress } from "./engine.ts";
import type { ScenarioDefinition } from "./types.ts";

describe("runScenarios progress", () => {
  it("reports each scenario before it runs, with the tally so far", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-engine-"));
    try {
      fs.mkdirSync(path.join(cwd, ".pi/scenarios"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi/scenarios/ok.js"), "process.exit(0);\n");
      fs.writeFileSync(path.join(cwd, ".pi/scenarios/bad.js"), "process.exit(1);\n");
      const scenarios: ScenarioDefinition[] = [
        { id: "bad", title: "bad", steps: "s", testFile: ".pi/scenarios/bad.js", kind: "script" },
        { id: "ok", title: "ok", steps: "s", testFile: ".pi/scenarios/ok.js", kind: "script" },
      ];
      const config = { ...DEFAULT_CONFIG, script: { command: "node {files}", probe: "node --version" } };

      const seen: ScenarioProgress[] = [];
      await runScenarios(cwd, scenarios, config, undefined, undefined, (p) => seen.push(p));

      assert.deepEqual(
        seen.map(formatScenarioProgress),
        ["Scenario 1/2: bad", "Scenario 2/2: ok (0 passed, 1 failed)"],
      );
    } finally {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        // Windows may hold the dir briefly; leftovers in tmp are harmless.
      }
    }
  });
});
