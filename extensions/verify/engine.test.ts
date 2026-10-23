import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "./config";
import { allSkippedForMissingTools, isPlaceholderTestScript, loadDependent, partitionScopes, playwrightFailures, verify } from "./engine";
import { classifyVerifyFailure } from "../shared/failure-classify";

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

  it("a whole-project run skips C# when the folder has no .csproj or .sln", async () => {
    const cwd = tempProject({ "package.json": "{}" });
    try {
      const csharpOnly = { ...DEFAULT_CONFIG, languages: { csharp: DEFAULT_CONFIG.languages.csharp! } };
      const result = await verify(cwd, [], csharpOnly, ["build", "test"]);
      assert.equal(result.failed, false);
      assert.equal(result.checks.length, 2);
      for (const c of result.checks) assert.match(c.reason ?? "", /not applicable: no \.csproj or \.sln/);
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

describe("verify scopes", () => {
  function tree(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-scopes-"));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
  }
  const summary = (dir: string, files: string[]) =>
    partitionScopes(dir, files, true).map((s) => `${s.label || "(root)"}: ${s.relFiles.join(",")}`);

  it("a file in src/ of a root package.json project is verified at the root", () => {
    const dir = tree({ "package.json": "{}", "src/main.ts": "", "src/ui/hud.ts": "" });
    try {
      assert.deepEqual(summary(dir, ["src/main.ts", "src/ui/hud.ts"]), ["(root): src/main.ts,src/ui/hud.ts"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("real subprojects keep their own scope; loose files fall back to the root", () => {
    const dir = tree({ "app-a/package.json": "{}", "app-a/src/x.ts": "", "app-b/pyproject.toml": "", "app-b/y.py": "", "notes/todo.ts": "" });
    try {
      assert.deepEqual(summary(dir, ["app-a/src/x.ts", "app-b/y.py", "notes/todo.ts"]).sort(), [
        "(root): notes/todo.ts",
        "app-a/: src/x.ts",
        "app-b/: y.py",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tests that fail only under load", () => {
  const RUN = [
    String.raw`  [90/93] .pi\scenarios\wagon-guns.spec.ts:45:3 › wagon guns › hold fire`,
    "  2 failed",
    String.raw`    [chromium] › .pi\scenarios\convoy.spec.ts:45:3 › convoy › bends behind the head`,
    String.raw`    [chromium] › .pi\scenarios\follow.spec.ts:12:7 › follow › settles`,
    "  91 passed (1.2m)",
  ].join("\n");

  it("reads the failed tests from Playwright's summary, not the progress lines", () => {
    assert.deepEqual(playwrightFailures(RUN), [".pi/scenarios/convoy.spec.ts:45", ".pi/scenarios/follow.spec.ts:12"]);
    assert.deepEqual(playwrightFailures("FAIL src/a.test.ts\n  ✕ adds"), [], "not Playwright: nothing to rerun");
  });

  it("passing alone means load-dependent; failing alone too means a real failure", async () => {
    const cwd = os.tmpdir();
    let asked: string[] = [];
    const pass = await loadDependent(RUN, cwd, 20000, undefined, (t) => ((asked = t), "node -e \"process.exit(0)\""));
    assert.deepEqual(asked, [".pi/scenarios/convoy.spec.ts:45", ".pi/scenarios/follow.spec.ts:12"]);
    assert.match(pass ?? "", /^LOAD-DEPENDENT: .*convoy\.spec\.ts:45.*pass when run alone/);
    assert.equal(classifyVerifyFailure(`${pass}\n\n${RUN}`).label, "load_flake");
    assert.equal(await loadDependent(RUN, cwd, 20000, undefined, () => "node -e \"process.exit(1)\""), null);
  });
});
