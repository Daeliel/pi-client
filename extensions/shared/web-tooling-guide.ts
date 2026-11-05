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

- Web specs must use real UI actions (click/tap/key). Forbidden: localStorage / page.evaluate to fake the flow. Reading state with page.evaluate (\`window.__game.state()\`) is fine.
- Screenshots: prefer inside the Playwright spec (same browser as clicks). Blank/white capture = failure.
- **Explore with \`play\`** before writing a spec when you do not know yet how the app behaves — where a button sits on a canvas, what a key does, what a screen shows after N steps: open it with \`play\`, do a few actions per call, look at each screenshot. When a path works, \`play_save_spec\` writes it as a spec; add the assertions and run_scenarios. Play is exploring, not proof.
- **How a screen looks** (colours, overlays, opacity, layout) is not proven by clicks. Save a screenshot of that screen to \`.pi/scenarios/output/<name>.png\` in a spec you keep — passing specs' screenshots there are attached for you to review. Scratch \`__*.spec.ts\` files are deleted after a green gate, so do not keep visual checks in them.
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

/**
 * For a model that cannot see images and has nothing to describe them (see shared/eyes.ts):
 * the same lanes, with proof it can read instead of screenshots.
 */
export const WEB_LANE_DETAILS_BLIND = `
## Lane A details

- Web specs must use real UI actions (click/tap/key). Forbidden: localStorage / page.evaluate to fake the flow. Reading state with page.evaluate (\`window.__game.state()\`) is fine.
- **You cannot see images**, so a screenshot proves nothing to you: do not take, open or review screenshots. Specs may still save them for the user.
- Prove with what you can read in the spec: \`toHaveText\` / \`toContainText\`, \`getByRole\` / \`getByText\`, values read with page.evaluate, console and page errors (attachConsoleCapture).
- **How a screen looks:** measure it in the spec — \`boundingBox()\` for size, position and overlap; \`getComputedStyle\` via page.evaluate for colour, opacity, visibility; scroll position before and after. What cannot be measured that way (art, feel), say plainly that the user has to check it.
- Layout bugs: one spec that measures the boxes before and after → run_scenarios. Do not code-read in a loop.
- Optional scaffold_scenario helps start a spec; freeform specs are fine when you write solid tests yourself.
- Failure messages may include LABEL + EVIDENCE + RAW — do not trust LABEL alone; confirm against EVIDENCE and RAW.
`.trim();

export const FLUTTER_LANE_DETAILS_BLIND = `
## Flutter / static webServer

- After Dart edits, run \`flutter build web\` before run_scenarios when Playwright serves build/web — stale UI is not proof.
- Canvas: page.mouse.click + waits; scroll with helpers/canvas-interaction (never window.scrollBy).
- canvas.toBeVisible() alone is not proof, and you cannot check canvas pixels: expose state through a test hook (read it with page.evaluate) or the semantics tree, and assert on that.
- Reuse click coords from a passing spec in this project.
`.trim();

export function webToolingCore(blind: boolean): string {
  return blind ? WEB_TOOLING_CORE.replace("; browser_screenshot is cosmetic only.", ".") : WEB_TOOLING_CORE;
}

export function webLaneDetails(blind: boolean): string {
  return blind ? WEB_LANE_DETAILS_BLIND : WEB_LANE_DETAILS;
}

export function flutterLaneDetails(blind: boolean): string {
  return blind ? FLUTTER_LANE_DETAILS_BLIND : FLUTTER_LANE_DETAILS;
}

/** @deprecated Prefer WEB_TOOLING_CORE + conditional lanes. Kept for any external imports. */
export const WEB_TOOLING_SEGMENTATION = `${WEB_TOOLING_CORE}

${WEB_LANE_DETAILS}

${FLUTTER_LANE_DETAILS}`.trim();
