import { WEB_TOOLING_CORE, WEB_LANE_DETAILS, FLUTTER_LANE_DETAILS } from "../shared/web-tooling-guide";
import type { StackDetection } from "../shared/stack-detect";
import type { ScenarioLevel } from "./config";

/**
 * Short acceptance-scenario core — always injected when scenarios are enabled.
 * Web/Flutter details are appended only when the project/turn needs them.
 */
export const SCENARIOS_CORE = `
## Lane A — Acceptance scenarios (prove behaviour)

Before treating a feature as done, prove it with runnable tests — not reasoning alone:

1. Call define_scenarios early (id, title, steps, testFile, kind: web | api | script). Optional: scaffold_scenario for a starter file.
2. Write or adapt the test files under .pi/scenarios/.
3. Call run_scenarios; fix until pass. The gate blocks finish while scenarios fail or are missing.
4. **Symptom-first:** open the screen/state the user named and assert there — no proxy proof elsewhere.
5. **[SKIP] is not a pass** — run /scenarios doctor.
6. If a failure message has LABEL / EVIDENCE / RAW: do not trust LABEL alone — confirm against EVIDENCE and RAW.

Where tests go:
- **Rules** (numbers, formulas, state changes) → unit tests in the project's own test runner (the verify gate runs them). Specs prove what the user **sees and does**: input, screens, navigation, rendering — not a rule re-checked through the browser.
- **One spec file per area** (energy.spec.ts, travel.spec.ts), many tests inside. Add to the matching file; a new file only for a new area. When behaviour changes, update its test — never add a second one beside it.
- First line of each spec: \`// @covers: <source paths or globs it proves>\`.
- Keep 3–5 **smoke** tests (title ends with @smoke) that play the core loop end to end.
\`/scenarios tidy\` when the folder grows.
`.trim();

/** One paragraph per gate level, appended to the core. */
export const LEVEL_TEXT: Record<ScenarioLevel, string> = {
  thorough:
    "Level: **thorough** — every spec runs on every code change. Cover edge cases: limits, zero/empty, repeats, wrong order. " +
    "For a rule that must always hold, add a unit test that drives a random sequence of actions and checks it after every step.",
  standard:
    "Level: **standard** — the gate runs this task's specs, the smoke specs and the specs whose @covers (or file name) matches the changed files. " +
    "A few edge cases per rule. Before calling a milestone done, run_scenarios with all: true.",
};

export function buildScenariosProcedure(opts: {
  includeWeb: boolean;
  includeFlutter: boolean;
  stackSummary?: string;
  level?: ScenarioLevel;
}): string {
  const parts = [SCENARIOS_CORE, LEVEL_TEXT[opts.level ?? "thorough"]];
  if (opts.stackSummary) {
    parts.push(`## Detected project\n\n${opts.stackSummary}`);
  }
  if (opts.includeWeb) {
    parts.push(WEB_TOOLING_CORE, WEB_LANE_DETAILS);
  }
  if (opts.includeFlutter) {
    parts.push(FLUTTER_LANE_DETAILS);
  }
  return parts.join("\n\n");
}

/** Full procedure for tests / fallback when stack is unknown but web is assumed. */
export function buildFullScenariosProcedure(detection?: StackDetection): string {
  const includeFlutter = detection?.stacks.includes("flutter") ?? true;
  const includeWeb = detection?.hasWebUi ?? true;
  return buildScenariosProcedure({
    includeWeb,
    includeFlutter,
    stackSummary: detection?.summary,
  });
}

/** @deprecated Use buildScenariosProcedure — kept so old imports still resolve during transition. */
export const SCENARIOS_PROCEDURE = buildScenariosProcedure({
  includeWeb: true,
  includeFlutter: true,
});
