/**
 * Tiered web tooling text for small models.
 * CORE is always short; WEB_LANE / FLUTTER_LANE append only when relevant.
 */

/** Always-on when any web/browser procedure is injected — keep short. */
export const WEB_TOOLING_CORE = `
## Web tooling — two browsers (do not mix)

| | **A — Playwright (scenarios)** | **B — browser_* (CDP)** |
|--|-------------------------------|---------------------------|
| Job | ACT + PROVE flows | OBSERVE while coding |
| Click/type? | YES — in .pi/scenarios/*.spec.ts | NO |
| Proof? | YES — run_scenarios | NEVER |

**Workflow A:** define_scenarios → write spec → run_scenarios until pass → STOP (do not re-prove in CDP).
**Workflow B:** edit → browser_errors / network_errors / reload; browser_screenshot is cosmetic only.
**Symptom-first:** prove on the screen/tab the user named — no proxy metrics on another view.
**[SKIP] is not a pass.** Fix toolchain via /scenarios doctor.
`.trim();

/** Extra rules when web UI / web files are in play. */
export const WEB_LANE_DETAILS = `
## Lane A / B details

- Web specs must use real UI actions (click/tap/key). Forbidden: localStorage / page.evaluate to fake the flow.
- Screenshots: prefer inside the Playwright spec (same browser as clicks). Blank/white capture = failure.
- capture_page_screenshot cannot scroll — use helpers/canvas-interaction in the spec for below-the-fold content.
- Layout bugs: one spec with before/after screenshots → run_scenarios (load visual-ui-debug skill). Do not code-read in a loop.
- Optional scaffold_scenario helps start a spec; freeform specs are fine when you write solid tests yourself.
- Failure messages may include LABEL + EVIDENCE + RAW — do not trust LABEL alone; confirm against EVIDENCE and RAW.
`.trim();

/** Flutter / static build/web projects only. */
export const FLUTTER_LANE_DETAILS = `
## Flutter / static webServer

- After Dart edits, run \`flutter build web\` before run_scenarios when Playwright serves build/web — stale UI is not proof.
- Canvas: page.mouse.click + waits; scroll with helpers/canvas-interaction (never window.scrollBy).
- canvas.toBeVisible() alone is not visual proof — use before/after screenshots on the named screen.
- Reuse click coords from a passing spec in this project.
`.trim();

/** @deprecated Prefer WEB_TOOLING_CORE + conditional lanes. Kept for any external imports. */
export const WEB_TOOLING_SEGMENTATION = `${WEB_TOOLING_CORE}

${WEB_LANE_DETAILS}

${FLUTTER_LANE_DETAILS}`.trim();
