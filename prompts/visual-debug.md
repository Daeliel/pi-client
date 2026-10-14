---
description: Debug a visual/layout or wrong-screen bug with Playwright — reproduce user steps, no shortcuts
argument-hint: "<what looks wrong>"
---
Stop speculating from code alone. Read and follow the **visual-ui-debug** skill.

1. List `.pi/scenarios/*.spec.ts` once; call `run_scenarios`.
2. Extend or add ONE spec: follow the user's steps in order → reach the screen they named → screenshot + assert there (size, overlap, visibility, or content).
3. One hypothesis → one code change → `run_scenarios`. Max one passive code read before step 1.

Do not use `browser_*` to prove layout. Fix `webServer` / `baseURL` in `.pi/playwright.config.ts` if connection refused.
Starter specs: `scaffold_scenario` with template `symptom-repro` (wrong screen / empty tab) or `visual-before-after` (layout/size) writes one into `.pi/scenarios/` — then adapt it.

Issue:
