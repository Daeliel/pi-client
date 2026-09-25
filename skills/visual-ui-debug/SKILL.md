---
name: visual-ui-debug
description: General playbook for UI/layout/visual bugs and wrong-screen content — stop code-reading loops, reproduce the user's steps in Playwright, screenshot on the screen they named, measure instead of speculate. Load when the user reports something looks wrong, empty list on a tab, overlaps, wrong size, or covers text.
---

# Visual / layout bug playbook

Use this for any report like "X covers Y", "element is too big", "layout broke after
click" — not only web apps with DOM; also canvas/Flutter web.

## Symptom-first (any app)

When the user names a **specific screen, tab, menu, or level** ("History is empty", "inventory wrong"):

1. Write a Playwright spec that follows **their steps in order** — reach that exact view.
2. **Screenshot + assert on that view** — not on a different screen with a related metric.
3. **Console on that view** — `attachConsoleCapture(page)` at test start, `assertClean()` after steps (scaffolded in `.pi/scenarios/helpers/`).
4. A home-page counter, storage log, or code review is **not** proof the reported screen works.

Template: `templates/scenarios/example-symptom-repro.spec.ts` in pi-client.

## Stop spinning

- After **one** read pass of the relevant widget/screen files, you must **run** something:
  `run_scenarios`, or add/update a spec and run it.
- Do **not** re-read the same file with the same hypothesis more than once.
- Do **not** write shell `node -e` / connectOverCDP scripts — use Playwright specs (Lane A).
- Do **not** use `browser_*` to prove a layout fix unless the dev server is already
  running and you only need a cosmetic peek (Lane B). Prefer Playwright.

## Workflow (Workflow A — Playwright)

1. **Inventory** — list existing `.pi/scenarios/*.spec.ts` (read once). Reuse or extend.
2. **Reproduce in one spec** — same test, same browser:
   - `import { attachConsoleCapture } from "./helpers/console-capture"` at test start
   - `page.goto` / wait for app ready
   - screenshot → **idle** (save under `.pi/scenarios/output/` or test-results)
   - perform the user action (click, tap — for canvas use `page.mouse.click` with waits)
   - **scroll** if content is below the fold: `scrollCanvasWheel` / `scrollCanvasDrag` from `./helpers/canvas-interaction`
   - screenshot → **after**
   - **assert** what the user asked for (see below)
   - `consoleCapture.assertClean()` — errors in the same session as clicks
3. **run_scenarios** — failing test = reproducer; fix code; rerun until pass.
4. **Done** when the spec passes — do not re-verify with CDP.

## What to assert (pick what matches the report)

| User says | Assert in Playwright (same session) |
|-----------|-------------------------------------|
| Wrong/empty screen or tab | Reproduce their clicks/keys → open that screen → screenshot + assert content visible there |
| Same size before/after | Compare bounding boxes: `locator.boundingBox()` for two states, or element width/height within tolerance |
| Covers header text | `expect(locator).not.toOverlap(other)` or screenshot + vision; check z-index/position |
| Wrong position | `boundingBox()` x/y within tolerance vs baseline screenshot or stored idle box |
| Canvas / no DOM nodes | Screenshots after each step in output/ + vision review; reuse click coords from passing specs; **scrollCanvasWheel/Drag** before proof when UI is below the fold |

Store baseline metrics in the spec (constants) or compare before/after in one test.

## App must be running

- `run_scenarios` and `capture_page_screenshot` use `.pi/playwright.config.ts`.
- Set `webServer.command` and `use.baseURL` for **this** project (Vite, Flutter web, etc.).
- **Flutter + static server:** after Dart edits run `flutter build web` before scenarios/capture — Playwright may serve old `build/web`.
- If `browser_navigate` returns `ERR_CONNECTION_REFUSED`, the dev server is down —
  fix playwright config or start the server; do not guess from code alone.

## When code reading helps (briefly)

- Map **idle vs active** widgets (which build methods, which parent layout).
- Check **explicit sizes** (fixed width/height vs expanded/flex).
- Check **strokeWidth / padding / Stack** — one pass, then run a spec.

## Anti-patterns

- Re-reading the same widget/layout code for many turns without a failing test.
- `browser_screenshot` on `chrome://newtab` then declaring the app broken.
- A passing flow spec but claiming "clicks don't work" in CDP.
- Checking a different screen or indirect metric when the user named a specific view.
- Declaring done when run_scenarios passed but output screenshot shows the wrong tab/screen — fix spec coords/asserts.
- Saying "cannot scroll" without `scrollCanvasWheel` / `scrollCanvasDrag` in the spec — capture tools are single-frame.
- Injecting app state in a web spec to skip UI (localStorage, page.evaluate, globals) when proving a user flow.
- Changing npm `test` script to `exit 0` to green-verify.

## Template

See `templates/scenarios/example-visual-before-after.spec.ts` in pi-client for a
copy-paste pattern (before/after screenshots + optional bounding-box compare).
