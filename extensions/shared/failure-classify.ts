/**
 * Route failure output into a primary LABEL + EVIDENCE + RAW.
 * Labels are hints for the next action — models must still read evidence/raw.
 */

export type FailureLabel =
  | "stale_build"
  | "server_down"
  | "timeout"
  | "assert_fail"
  | "console_error"
  | "weak_spec"
  | "toolchain_missing"
  | "missing_test_file"
  | "lint_fail"
  | "build_fail"
  | "test_fail"
  | "unknown";

export interface ClassifiedFailure {
  label: FailureLabel;
  evidence: string;
  next: string;
  raw: string;
}

export const LABEL_TRUST_WARNING =
  "Do not rely on LABEL blindly — confirm against EVIDENCE and RAW below. " +
  "If they disagree with the label, ignore the label and fix based on the real error.";

const RAW_MAX = 3500;
const EVIDENCE_MAX = 500;

function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…(truncated)`;
}

function firstMatchLine(text: string, re: RegExp): string | null {
  const m = text.match(re);
  if (!m) return null;
  const idx = text.indexOf(m[0]);
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  const lineEnd = text.indexOf("\n", idx);
  return text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
}

/** Classify scenario / Playwright / pytest style failure text. */
export function classifyScenarioFailure(input: {
  report: string;
  preflightWarnings?: string[];
  weakSpecBlocking?: boolean;
  missingFiles?: string[];
}): ClassifiedFailure {
  const raw = clip(input.report, RAW_MAX);
  const blob = `${(input.preflightWarnings ?? []).join("\n")}\n${input.report}`;

  if (input.missingFiles?.length) {
    return {
      label: "missing_test_file",
      evidence: `Missing: ${input.missingFiles.join(", ")}`,
      next: "Create the testFile path(s), implement the flow, then call run_scenarios.",
      raw,
    };
  }

  if (input.weakSpecBlocking || /WEAK SPEC PATTERNS|spec proof is too weak/i.test(blob)) {
    return {
      label: "weak_spec",
      evidence:
        firstMatchLine(blob, /BLOCKING|WEAK SPEC|canvas\.toBeVisible|localStorage|page\.evaluate/i) ??
        "Passing exit code but weak/forbidden proof patterns.",
      next: "Strengthen the spec (real clicks/scroll/screenshots on the named screen); do not weaken asserts.",
      raw,
    };
  }

  if (/Stale web build|no build\/web|flutter build web/i.test(blob)) {
    return {
      label: "stale_build",
      evidence:
        firstMatchLine(blob, /Stale web build|no build\/web|flutter build web/i) ??
        "Flutter/web build may be stale.",
      next: "Run `flutter build web` (or rebuild the served output), then re-run run_scenarios.",
      raw,
    };
  }

  if (
    /ECONNREFUSED|ERR_CONNECTION_REFUSED|net::ERR_|Connection refused|Exceeded timeout.*webServer|Timed out waiting.*\d{2,5}/i.test(
      blob,
    )
  ) {
    return {
      label: "server_down",
      evidence:
        firstMatchLine(blob, /ECONNREFUSED|ERR_CONNECTION_REFUSED|webServer|Connection refused/i) ??
        "App server / webServer not reachable.",
      next: "Fix .pi/playwright.config.ts webServer/baseURL (or start the app), then re-run.",
      raw,
    };
  }

  if (/timed out|Timeout|Test timeout|exceeded/i.test(blob) && /\[FAIL\]|exit 124/i.test(blob)) {
    return {
      label: "timeout",
      evidence: firstMatchLine(blob, /timed out|Timeout|exit 124/i) ?? "Scenario timed out.",
      next: "Check waits, navigation, and that the app reached the expected screen; then re-run.",
      raw,
    };
  }

  if (/toolchain missing|probe failed|All scenario checks were SKIPPED/i.test(blob)) {
    return {
      label: "toolchain_missing",
      evidence:
        firstMatchLine(blob, /toolchain missing|SKIPPED|probe failed/i) ?? "Runner toolchain missing.",
      next: "Run /scenarios doctor and install Playwright/pytest as hinted. [SKIP] is not a pass.",
      raw,
    };
  }

  if (/console\.(error|assertClean)|pageerror|Console errors/i.test(blob)) {
    return {
      label: "console_error",
      evidence: firstMatchLine(blob, /console|pageerror|assertClean/i) ?? "Console errors during scenario.",
      next: "Fix the runtime error, keep attachConsoleCapture + assertClean in the spec, re-run.",
      raw,
    };
  }

  if (/Expected |expect\(|AssertionError|toBeVisible|toHaveText|toBeCloseTo/i.test(blob)) {
    return {
      label: "assert_fail",
      evidence:
        firstMatchLine(blob, /Expected |Error: expect|AssertionError|toBeVisible/i) ??
        "Assertion failed in scenario.",
      next: "Fix app or strengthen navigation/asserts on the screen the user named; re-run run_scenarios.",
      raw,
    };
  }

  if (/\[FAIL\]/i.test(blob)) {
    return {
      label: "unknown",
      evidence: firstMatchLine(blob, /\[FAIL\].*/i) ?? "Scenario failed — see RAW.",
      next: "Inspect RAW carefully, fix the real cause, then re-run run_scenarios.",
      raw,
    };
  }

  return {
    label: "unknown",
    evidence: clip(blob.split("\n").find((l) => l.trim()) ?? "No clear failure line.", EVIDENCE_MAX),
    next: "Inspect RAW carefully, fix the real cause, then re-run.",
    raw,
  };
}

/** Classify verify (lint/build/test) failure text. */
export function classifyVerifyFailure(report: string): ClassifiedFailure {
  const raw = clip(report, RAW_MAX);
  if (/ruff|eslint|clippy|go vet|lint/i.test(report) && /FAIL|error/i.test(report)) {
    if (/tsc|typeerror|error TS|cargo check|go build|dotnet build/i.test(report)) {
      /* fall through — may be build */
    } else if (!/pytest|npm test|go test|cargo test|dotnet test/i.test(report)) {
      return {
        label: "lint_fail",
        evidence: firstMatchLine(report, /error|FAIL|E\d+|F\d+/i) ?? "Lint failed.",
        next: "Fix lint issues without deleting or weakening the check; re-run verify.",
        raw,
      };
    }
  }
  if (/tsc|error TS|cargo check|go build|dotnet build|compile/i.test(report)) {
    return {
      label: "build_fail",
      evidence: firstMatchLine(report, /error TS|error\[|Build FAILED|error CS/i) ?? "Build/typecheck failed.",
      next: "Fix compile/type errors; re-run verify.",
      raw,
    };
  }
  if (/pytest|npm test|go test|cargo test|dotnet test|FAILED|AssertionError/i.test(report)) {
    return {
      label: "test_fail",
      evidence: firstMatchLine(report, /FAILED|AssertionError|Error:|FAIL/i) ?? "Tests failed.",
      next: "Fix the failing test or code under test; do not skip or delete the test to pass.",
      raw,
    };
  }
  if (/SKIP|toolchain|not found|ENOENT/i.test(report)) {
    return {
      label: "toolchain_missing",
      evidence: firstMatchLine(report, /SKIP|not found|ENOENT/i) ?? "Toolchain issue.",
      next: "Run /doctor and install missing tools. [SKIP] is not a pass.",
      raw,
    };
  }
  return {
    label: "unknown",
    evidence: clip(report.split("\n").find((l) => l.trim()) ?? "Verify failed.", EVIDENCE_MAX),
    next: "Inspect RAW, fix the real cause, re-run verify.",
    raw,
  };
}

export function formatClassifiedFailure(
  classified: ClassifiedFailure,
  intro: string,
  extras?: { screens?: string[] },
): string {
  const lines = [
    intro,
    "",
    `LABEL: ${classified.label}   ← routing hint only`,
    `WARNING: ${LABEL_TRUST_WARNING}`,
    `EVIDENCE: ${clip(classified.evidence, EVIDENCE_MAX)}`,
  ];
  if (extras?.screens?.length) {
    lines.push(`SCREEN: ${extras.screens.join(", ")}`);
  }
  lines.push(`NEXT: ${classified.next}`, "", "RAW:", classified.raw);
  return lines.join("\n");
}
