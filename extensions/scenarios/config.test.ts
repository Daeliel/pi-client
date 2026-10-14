import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, persistScenarioLevel, projectScenariosConfigPath } from "./config.ts";

describe("scenario level", () => {
  it("is thorough unless a project saves standard; nonsense falls back to thorough", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scenarios-level-"));
    try {
      assert.equal(loadConfig(cwd).level, "thorough");
      fs.mkdirSync(path.dirname(projectScenariosConfigPath(cwd)), { recursive: true });
      fs.writeFileSync(projectScenariosConfigPath(cwd), JSON.stringify({ level: "quick", housekeeping: { maxSpecsBeforeAudit: 15 } }));
      assert.equal(loadConfig(cwd).level, "thorough");
      persistScenarioLevel(cwd, "standard");
      const saved = JSON.parse(fs.readFileSync(projectScenariosConfigPath(cwd), "utf8"));
      assert.equal(saved.level, "standard");
      assert.equal(saved.housekeeping.maxSpecsBeforeAudit, 15, "other project settings are kept");
      assert.equal(loadConfig(cwd).level, "standard");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
