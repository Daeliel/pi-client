/** How to write a blueprint. Returned by write_blueprint / start_autopilot when none exists. */
export function buildBlueprintProcedure(opts: {
  blueprintPath: string;
  refsDir: string;
  budgetMinutes: number | null;
  imageSearch: boolean;
  forAutopilot: boolean;
}): string {
  const budget =
    opts.budgetMinutes !== null
      ? `\nTime budget: ${formatMinutes(opts.budgetMinutes)}. Size v1 to fit it; put the rest in v2/later.`
      : "";
  const images = opts.imageSearch
    ? "Use find_reference_images (or any image-search tool you have) for visual references; keep them with save_reference_image."
    : "If the user gave images, keep them with save_reference_image. If you have an image-search tool, use it and save results with save_reference_image.";
  const points = opts.blueprintPath.replace(/BLUEPRINT\.md$/i, "POINTS.md");
  const refs = opts.refsDir.replace(/^\.pi\/blueprint\//, "");
  return `BLUEPRINT — write the plan to ${opts.blueprintPath} before any app code.${budget}

1. Sources — what the plan is built from, kept as given. add_source for each: the user's request (text, word for word), every document they named (file), every image (file). Never rewrite a source.
2. Points — in ${points}, everything the sources say, one statement per line, **quoted in the source's own words**: \`- S-01 (SRC-1 §2 The route map) "Branching goes up to 5 branches wide."\` (shorten long quotes with "…"). blueprint_check verifies each quote is really in its source. For an image, describe what it shows. A one-line request gives a few points; a long design doc gives many — list them all.
3. **Bar:** \`product\` when a person is meant to use the result (an app or game, "make it playable/usable", quality matters); \`spec\` when only what is written is wanted (a library, an API, "just what the doc says"). If the request does not tell you, ask the user once.
4. Reading — \`## Reading\`: **Interpretations** wherever a point can be read more than one way (\`- I-01 (S-08) "pick the next destination" — I read it as: …\`) — say how you read it, concretely. **Additions**: what the sources never say but the result needs (\`- A-01 …\`); for product, think how the user does each thing, what they see, how one screen or stage hands over to the next, what an old mode does once a new one starts.
5. Walkthrough (product) — \`## Walkthrough\`: the experience as numbered moments, before the items. For each \`### M-nn <name>\`: **Situation** (what is on screen), **Decision** (what the person is choosing and why it matters), **Needs to see** (what they must see to decide it), **Does** (the input), **Feedback** (how they know it worked), **Then** (what it leads to, and when it takes effect), **Turns off** (what stops while here, or "nothing"). Then \`### Forgotten moments\` — answer each with a moment id or "n/a — why": First launch / orientation · Learning the controls · Waiting / idle · Failure and its feedback · Cancel / undo · End of the loop and starting again · Switching modes or stages · Saving and coming back.
6. Items — tiers \`## v1\` (the smallest usable version), \`## v2\`, \`## later\`; vertical slices, each small enough to build and prove in one sitting, in checkable terms. Each item says:
   - \`serves:\` the points it builds (\`S-07, S-08\`) or the addition (\`A-01\`). Every point is served, or listed under \`## Not covered\` with why (deferred, out of scope, open question) — nothing dropped silently.
   - \`moment:\` the walkthrough moment it builds (product, for everything a person does).
   - \`input:\` how the person does it (product).
   - \`proves:\` a spec file, \`verify\` (the project's tests), or \`manual\` (only the user can judge, e.g. "feels fun"). Product: 1–2 items are \`@journey\` specs — the main flow start to finish through real input.
7. References: ${images} Describe each under \`## References\` with what it shows, which items it informs, and what it cannot prove (motion, feel, exact colours).
8. Call blueprint_check and fix every problem it reports.${opts.forAutopilot ? "\n9. Then call start_autopilot again." : "\n9. Then stop and show the user the Reading and the Walkthrough — they read those, not the item list — and say the blueprint is ready (they can build it step by step or start autopilot on it)."}

Format:
\`\`\`
# Blueprint: <name>

Goal: <one line>
Bar: product | spec
Stack: <languages/frameworks>

## Reading
### Interpretations
- I-01 (S-02) "<the words>" — I read it as: <concretely>
### Additions
- A-01 <what the sources never say, and why it is needed>

## Walkthrough
### M-01 <moment>
- Situation: …
- Decision: …
- Needs to see: …
- Does: …
- Feedback: …
- Then: …
- Turns off: …
### Forgotten moments
- First launch / orientation: M-01
- Learning the controls: …

## v1 — core
- [ ] **R-01** <what it does, checkably> · serves: S-01, S-02 · moment: M-01 · input: <e.g. click a node on the map> · proves: <name>.spec.ts
- [ ] **R-02** <…> · serves: S-03 · proves: verify
- [ ] **R-03** Journey: <the main flow, start to finish> · serves: A-01 · moment: M-01 · input: <the steps> · proves: <flow>.spec.ts (test title ends with @journey)

## v2
- [ ] **R-10** <…> · serves: S-05 · moment: M-02 · input: <…> · proves: <name>.spec.ts

## later
- [ ] **R-20** <…> · serves: S-09 · proves: manual

## Not covered
- S-12 — deferred to v2: needs the economy first
- S-14 — open question: the doc marks it PROPOSED, not agreed

## References
- **REF-01** ${refs}/<file>.png — <what it shows> → R-01, R-02 · cannot show: <…> · source: <url or file>
\`\`\`
Order inside a tier is the build order — put what other items depend on first. Leave every box as \`[ ]\`: status marks are set from evidence by pi-client, not by hand.`;
}

export function formatMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${String(m % 60).padStart(2, "0")}h` : `${m} min`;
}
