import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "./config";
import { allSkippedForMissingTools, isPlaceholderTestScript, verify } from "./engine";

function tempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-engine-"));
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
  return dir;
}

const nodeOnly = {
  ...DEFAULT_CONFIG,
  languages: { node: DEFAULT_CONFIG.languages.node },
};

describe("verify engine", () => {
  it("recognises the npm init placeholder test script", () => {
    assert.ok(isPlaceholderTestScript('echo "Error: no test specified" && exit 1'));
    assert.ok(!isPlaceholderTestScript("node --test"));
    assert.ok(!isPlaceholderTestScript(undefined));
  });

  it("skips (does not fail) npm test when the script is the placeholder", async () => {
    const cwd = tempProject({
      "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "a.js": "1",
    });
    try {
      const result = await verify(cwd, ["a.js"], nodeOnly, ["test"]);
      assert.equal(result.failed, false);
      assert.match(result.checks[0]?.reason ?? "", /placeholder/);
      assert.equal(allSkippedForMissingTools(result), false, "not-applicable is not a missing toolchain");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("skips eslint when the project has no ESLint config", async () => {
    const cwd = tempProject({ "package.json": "{}", "a.js": "1" });
    try {
      const result = await verify(cwd, ["a.js"], nodeOnly, ["lint"]);
      assert.equal(result.failed, false);
      assert.match(result.checks[0]?.reason ?? "", /no ESLint config/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("runs a real test script and reports failure with the end of the output kept", async () => {
    const script = `node -e "console.log('x'.repeat(6000)); console.error('SUMMARY: 1 failed'); process.exit(1)"`;
    const cwd = tempProject({ "package.json": JSON.stringify({ scripts: { test: script } }), "a.js": "1" });
    try {
      const result = await verify(cwd, ["a.js"], nodeOnly, ["test"]);
      assert.equal(result.failed, true);
      const { formatReport } = await import("./engine");
      assert.match(formatReport(result), /SUMMARY: 1 failed/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
