import { WEB_TOOLING_CORE, WEB_LANE_DETAILS, FLUTTER_LANE_DETAILS } from "../shared/web-tooling-guide";
import type { StackDetection } from "../shared/stack-detect";
import type { ResultBar, ScenarioLevel } from "./config";
import { describeLimits, type LightLevel } from "./light";

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
- Keep 1–3 **journey** tests (title ends with @journey): the main thing a user comes to do, start to finish, with **real input only** — every step a click, key or typed value. Test hooks may set conditions (seed, time scale, feature flags, spawn, a starting state), never perform the user's actions (\`start\`, \`goToStage\`, \`chartTo\`, \`save\`…). Declare each setup hook a journey uses at the top of the spec, with why: \`// @hooks: setShield — start at 3 shield; addModules — begin with 3 wagons\` (seed/time/spawn hooks need no line). The report lists them as setup, not played. A journey proves the wiring, not skill: for a real-time game, slow time or turn on invincibility rather than play well. Journeys run on every gate.
- **Don't wait for app time to pass.** When a spec needs the game or app to get somewhere (a fight to end, a timer to run out), add a time hook to the test surface — \`setTimeScale(8)\` or \`step(seconds)\` — and use it: a condition, allowed in journeys too. Keep sleeps short (≤ 2 s) and polls for the UI to settle (≤ 8 s).
- Other specs may set things up through hooks, but the action a spec is about goes through the UI. A spec that only calls the app's own functions proves the logic, not that a person can do it — that is a unit test.
\`/scenarios tidy\` when the folder grows.
`.trim();

/** What "done" means, per result bar. */
export const BAR_TEXT: Record<ResultBar, string> = {
  unset:
    "Result bar: **not set**. Before the first real build, decide what done means and call set_result_bar:\n" +
    "- **product** — a person must be able to use everything you build. Fill the gaps the brief leaves: how the user does each thing, what they see, how one screen or stage hands over to the next. Prove the main flows with @journey specs. Choose it for an app or game meant to be used (\"build a game\", \"make it playable / usable\", \"final quality matters\").\n" +
    "- **spec** — build what is written, no more; record gaps as questions or assumptions instead of inventing. Choose it for libraries, fixes, APIs, or \"only what the doc says\".\n" +
    "If the request does not tell you, ask the user once.",
  product:
    "Result bar: **product** — build something a person can use, not just what the brief lists. For every feature ask \"how does the user do this, and what do they see?\" and build that too: input, feedback, entering and leaving each screen or stage. Where old and new behaviour overlap, decide what each stage turns off. " +
    "Prove the main flows with @journey specs (real input only). Never call work \"done\", \"playable\" or \"usable\" unless the @journey specs passed this session — otherwise say what you have not verified.",
  spec:
    "Result bar: **spec** — build what the brief states, no more. Where it leaves a gap a user would hit, write it down as a question or assumption for the user instead of inventing. Still say plainly what a user cannot do yet.",
};

/** One paragraph per gate level, appended to the core. */
export const LEVEL_TEXT: Record<ScenarioLevel, string> = {
  thorough:
    "Level: **thorough** — every spec runs on every code change. Cover edge cases: limits, zero/empty, repeats, wrong order. " +
    "For a rule that must always hold, add a unit test that drives a random sequence of actions and checks it after every step.",
  standard:
    "Level: **standard** — the gate runs this task's specs, the smoke specs and the specs whose @covers (or file name) matches the changed files. " +
    "A few edge cases per rule. Before calling a milestone done, run_scenarios with all: true.",
};

/** Light changes: what counts as small here, and what the model owes the user instead of specs. */
export function lightText(level: LightLevel): string {
  return [
    "## Light changes",
    "",
    `A small, low-risk change (a colour, a label, a spacing tweak, one condition) does not need new specs. Here small means ${describeLimits(level)}.`,
    "- Call light_change with why it is small and 1-4 steps a person can follow to see it works. Then make the change and finish.",
    "- Lint, typecheck and unit tests still run. If the change grows past the limit, the specs run as usual.",
    "- Not light: new features, anything touching saving, data, money, login or several screens — even when it is few lines.",
    "- End your reply with the \"Not verified by specs — how to check\" steps, so the user knows nothing proved it.",
  ].join("\n");
}

export function buildScenariosProcedure(opts: {
  includeWeb: boolean;
  includeFlutter: boolean;
  stackSummary?: string;
  level?: ScenarioLevel;
  bar?: ResultBar;
  light?: LightLevel;
}): string {
  const parts = [SCENARIOS_CORE, LEVEL_TEXT[opts.level ?? "thorough"], BAR_TEXT[opts.bar ?? "unset"]];
  if (opts.light && opts.light !== "off") parts.push(lightText(opts.light));
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
