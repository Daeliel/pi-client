/**
 * What failed in a check's output, as stable signatures — a test id, or file + rule + message
 * for lint and type errors — without line numbers, which move as soon as code above changes.
 * Comparing the signatures with and without the model's changes tells its failures from the
 * project's own. Null when the output is not in a format we know (no comparison then).
 */
export function parseFailures(out: string): Set<string> | null {
  const sigs = new Set<string>();
  const lines = out.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const norm = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  let eslintFile: string | null = null;
  let ruffCode: string | null = null;

  for (const line of lines) {
    let m: RegExpMatchArray | null;

    // pytest short summary: "FAILED tests/x.py::test_a - AssertionError", "ERROR tests/x.py - ImportError"
    if ((m = line.match(/^(FAILED|ERROR) (\S+?)(?: - .*)?$/))) {
      sigs.add(`pytest ${m[1]} ${norm(m[2]!)}`);
      continue;
    }
    // ruff concise: "src/x.py:12:5: F401 [*] `os` imported but unused"
    if ((m = line.match(/^(.+?):\d+:\d+: ([A-Z]+\d+) (?:\[\*\] )?(.*)$/))) {
      sigs.add(`lint ${norm(m[1]!)} ${m[2]} ${m[3]}`);
      continue;
    }
    // ruff full: "F401 [*] `os` imported but unused" then " --> src/x.py:12:5"
    if ((m = line.match(/^([A-Z]+\d+) (?:\[\*\] )?(.+)$/))) {
      ruffCode = `${m[1]} ${m[2]}`;
      continue;
    }
    if (ruffCode && (m = line.match(/^\s*--> (.+?):\d+:\d+$/))) {
      sigs.add(`lint ${norm(m[1]!)} ${ruffCode}`);
      ruffCode = null;
      continue;
    }
    // tsc / msbuild: "src/a.ts(3,7): error TS2322: …", "src/a.ts:3:7 - error TS2322: …", "A.cs(3,7): error CS0103: … [x.csproj]"
    if ((m = line.match(/^(.+?)(?:\(\d+,\d+\):?|:\d+:\d+ -) error ([A-Z]+\d+): (.*?)(?: \[[^\]]+\])?$/))) {
      sigs.add(`build ${norm(m[1]!)} ${m[2]} ${m[3]}`);
      continue;
    }
    // eslint stylish: a file path alone, then "  12:5  error  Message  rule-id"
    if (/^(?:[A-Za-z]:[\\/]|\/)\S.*\.[cm]?[jt]sx?$/.test(line)) {
      eslintFile = norm(line);
      continue;
    }
    if (eslintFile && (m = line.match(/^\s+\d+:\d+\s+error\s+(.+?)(?:\s{2,}(\S+))?$/))) {
      sigs.add(`lint ${eslintFile} ${m[2] ?? ""} ${m[1]}`);
      continue;
    }
    // Playwright: "  1) [chromium] › tests/a.spec.ts:12:5 › opens the menu ───"
    if ((m = line.match(/^\s+\d+\) (?:\[[^\]]+\] › )?(\S+?):\d+:\d+ › (.+?)\s*─*$/))) {
      sigs.add(`e2e ${norm(m[1]!)} ${m[2]}`);
      continue;
    }
    // node:test "✖ name (1.2ms)", jest/vitest "✕ name (3 ms)" / "× name"
    if ((m = line.match(/^\s*(?:✖|✕|×) (.+?)(?: \([\d.]+ ?m?s\))?$/))) {
      sigs.add(`test ${m[1]!.trim()}`);
      continue;
    }
    // jest/vitest file header: "FAIL src/a.test.ts"
    if ((m = line.match(/^\s*FAIL\s+(\S+)/))) {
      sigs.add(`test FAIL ${norm(m[1]!)}`);
      continue;
    }
    // dotnet test: "  Failed Namespace.Class.Test [12 ms]"
    if ((m = line.match(/^\s*Failed (\S+) \[/))) {
      sigs.add(`test ${m[1]}`);
      continue;
    }
  }
  return sigs.size > 0 ? sigs : null;
}

/** "pytest FAILED tests/x.py::a" → "tests/x.py::a", for lists shown to the model and the user. */
export function describeFailure(sig: string): string {
  return sig.replace(/^(?:pytest (?:FAILED|ERROR)|lint|build|e2e|test) /, "");
}
