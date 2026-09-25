import { WEB_TOOLING_CORE, WEB_LANE_DETAILS, FLUTTER_LANE_DETAILS } from "../shared/web-tooling-guide";
import type { StackDetection } from "../shared/stack-detect";

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

Housekeeping: extend existing specs before adding many new ones. \`/scenarios tidy\` when the folder grows.
`.trim();

export function buildScenariosProcedure(opts: {
  includeWeb: boolean;
  includeFlutter: boolean;
  stackSummary?: string;
}): string {
  const parts = [SCENARIOS_CORE];
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
