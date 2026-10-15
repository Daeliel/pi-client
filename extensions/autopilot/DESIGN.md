# autopilot + blueprint — design

Status: **phases 1–3 built** (2026-10-15): trigger + approval, blueprint pipeline, run loop,
budget, checkpoints, references. **Phase 4 (independent critic) not built.**

Two capabilities that share one file:

- **blueprint** — turn a prompt, a design doc, reference images, or all three into a
  structured, buildable plan on disk. Useful on its own ("blueprint me an app that works
  like Photoshop") and as the input to autopilot.
- **autopilot** — the user approves once, then the model works through the blueprint
  until the chosen scope is done, the time budget runs out, or the user pauses it —
  without the user having to say "proceed" after every stop.

---

## 1. Why

Today pi-client keeps a model working until **what it built works** (verify, scenarios,
browser gates). Nothing keeps it working until **what was asked for is built**. On a
long task a small model builds a plausible first slice, proves that slice, and stops;
after context compaction it also loses its plan, because the plan only lived in context.

Testing a large model (DeepSeek 4.1) showed the cheap version of the fix works: when it
stops, say "proceed as you suggested"; when it asks, answer "do what you think is best".
That loop is the engine of this design. On a 27B, nudging alone drifts (re-polishing,
scope creep, rewrites), has no stopping point, and lets the model grade its own work.
The blueprint is what steers the nudges and decides when to stop.

### Relation to existing pieces

| Piece | Relation |
|---|---|
| **expand** | Same shape: ledger on disk, build step, fit check. Ledger I/O and the fit-check critic are reused. |
| **scenarios** | The evidence. An item is done when the spec that proves it passes. |
| **gate orchestrator** | Autopilot is a new lane, always last: it only acts when every other gate is green. |
| **research / vision-relay** | Web lookup, image fetch (new: image search), image description for references. |

---

## 2. Concepts

| Term | Meaning |
|---|---|
| **Blueprint** | `.pi/blueprint/BLUEPRINT.md` — the single source of truth for what to build and how far it got. |
| **Item** | One buildable, checkable unit with a stable id (`R-07`), acceptance criteria, a tier, and the evidence that proves it. |
| **Tier** | Scope layer: `v1` (core, built first), `v2`, `later`. Autopilot finishes a tier, not "everything". |
| **Evidence** | What makes an item done: a scenario spec, the verify suite, or `manual` (only the user can confirm). |
| **Run** | One autopilot session over a blueprint: approval → items → stop (scope done / budget / pause / blocked). Resumable. |

---

## 3. Trigger and approval

### Semantic trigger — the model decides, no keywords

The model gets a tool, `start_autopilot`, whose description says when to use it: the
user wants the work carried through to completion without being asked to continue
("build it to spec and come back when done", "just make the whole game"). Matching is
done by the model reading the request, never by regex or keyword lists in the extension.

```
start_autopilot({ goal, blueprint?: path, scope?: "v1" | "v2" | "all" })
```

If no blueprint exists, autopilot starts with the blueprint pipeline (section 4) and asks
for approval once the blueprint is written — approval covers a concrete plan, not a vague
goal.

### Approval — always, it is a workflow change

The tool opens a dialog:

```
Autopilot — build "pixel editor" to spec
Blueprint: .pi/blueprint/BLUEPRINT.md · v1: 14 items · v2: 9 · later: 6
Scope: v1        Budget: ( ) no limit  ( ) 1h  ( ) 3h  ( ) custom…
Checkpoints: commit per item on branch autopilot/pixel-editor

[ Start ]  [ Not now ]  [ Don't offer again this session ]
```

- **Start** — run begins; footer shows `autopilot: R-03/14 · 0:42 of 3:00`.
- **Not now** — the model is told the user declined and continues in normal mode.
- **Don't offer again this session** — tool is removed from the model's tool list for the
  rest of the session.

### Off switches

- `/autopilot off` — this session; `autopilot.enabled: false` in config — permanently.
- Off means the tool is **not offered at all** (tool activation), not offered-then-refused:
  an eager model cannot call what it cannot see, and the prompt stays smaller.
- Esc or `/autopilot pause` stops a running autopilot at any moment (section 7).

### Headless (`pi -p`)

No UI means no dialog, so autopilot is unavailable unless config opts in:
`autopilot.headless: "allow"` (approval is implied by the flag). Default: unavailable.

---

## 4. Blueprint

### One file, split ownership

`BLUEPRINT.md` is the only source of truth and the only place the user reads progress.
Drift between a readable doc and a tracking file is avoided by splitting **ownership**
inside one file, not by keeping two files:

- **Content** (items, criteria, tiers, notes, assumptions) — written by the model, editable
  by the user.
- **Status marks** — written **only by the extension, only from evidence**. If the model or
  the user edits a mark, the next pass rewrites it from evidence. The model cannot tick its
  own boxes.
- Any nicer progress view (HTML, widget) is **rendered from the file**, never edited.

### Format

Plain markdown with a fixed item shape a lenient parser reads:

```markdown
# Blueprint: pixel editor

Goal: a browser pixel-art editor for 32×32 to 256×256 sprites.
Stack: TypeScript + Vite, canvas 2D. Budget: 3h (planned 2026-10-15).

## v1 — core
- [x] **R-01** Canvas: create 32/64/128 px, zoom 1–16×, grid toggle · proves: canvas.spec.ts
- [~] **R-02** Pencil + eraser, 1–4 px, undo/redo 50 steps · proves: draw-undo.spec.ts
- [ ] **R-03** Palette: 16 swatches, custom colour picker · proves: palette.spec.ts
- [!] **R-04** PNG export at 1×/4× · proves: export.spec.ts · blocked: canvas.toBlob null in headless
- [ ] **R-05** Save/load project JSON · proves: verify

## v2
- [-] **R-10** Layers: add/hide/reorder · proves: layers.spec.ts · deferred: budget

## References
- **REF-01** refs/aseprite-main.png — tool strip left, palette right, timeline bottom → R-02, R-03

## Assumptions
- A-01 (R-03): no palette import — not in the doc, kept out of v1.
```

| Mark | Meaning | Set when |
|---|---|---|
| `[ ]` | open | default |
| `[~]` | in progress | autopilot picked it |
| `[x]` | done | its evidence passed |
| `[!]` | blocked | per-item attempt cap hit; reason recorded |
| `[-]` | deferred | re-planned out of the current run (budget / scope) |

Parser rules: an item is a list line containing `**<ID>**`; `proves:` is required
(`<file>.spec.ts`, `verify`, or `manual`); unknown fields are kept verbatim. Malformed
lines are reported to the model as a tool result to fix, never silently dropped.

`manual` items are never auto-done; the final report lists them as "needs you".

**Run settings are not progress.** Scope, budget and time used, the checkpoint branch and
per-item commits, attempt counts, and the evidence-backed marks the file is reconciled to
live in `.pi/blueprint/run.json`. Progress is still read in one place — the blueprint. When
a run resumes in a new session the file's marks are adopted, and every `[x]` is re-proven
before the run can finish.

### Pipeline — making a good blueprint

The blueprint is where a small model is weakest and where the payoff is largest, so it
gets its own procedure and a checker, not a free-form "write a plan":

1. **Sources** — the user's prompt; any design doc they point at (expanded, never
   silently rewritten — additions are marked); reference images (section 5); research
   (`web_search`) for "works like X" requests.
2. **Inventory** — what the thing does: screens, entities, actions, states. For "like
   Photoshop", the inventory comes from research plus references, not from memory.
3. **Tiers** — v1 is the smallest version that is a usable product; built as vertical
   slices (each item usable on its own), not layers ("all models, then all UI").
4. **Items** — each small enough to build and prove in one sitting, with acceptance
   criteria a spec can check.
5. **Evidence** — every item names what proves it; UI items map to scenario specs.
6. **Check** — a `blueprint_check` tool validates shape (ids unique, `proves:` present,
   tiers present, v1 not empty, no item without criteria) and returns problems to fix.
7. **Budget fit** — if a budget is set, v1 is sized to it; the rest is v2/later (section 6).

### Standalone mode

`/blueprint <prompt>` (or the model calling `write_blueprint` when the user only wants a
plan: "blueprint me Photoshop"). Produces the file and stops. From there the user either
goes step by step (normal pi, "build R-03 next") or starts autopilot on it.

---

## 5. References

Two sources, one result: named, checkable criteria plus the images kept for later.

- **User images** — files in the folder, pasted images, or `@image.png`. Each is
  described by the session model if it sees images, otherwise by vision-relay.
- **Web images** — "find references for a cozy farming game HUD", through **whatever image
  search the user already has** (see below). Results are downloaded to
  `.pi/blueprint/refs/` with the source URL recorded.

### Image search: use what is available

Autopilot does not bring its own search account. `find_reference_images` uses the first
provider that works, in this order:

1. **An image-search tool already in the session** — e.g. one from an MCP server or another
   pi package. The model uses it directly; autopilot only stores and describes the results.
2. **The research extension's key**, if its provider covers image search (Brave's image
   endpoint, when the user's plan includes it).
3. **Other configured keys** under `research` config (pluggable providers, added as users
   ask for them).
4. **None available** — the tool says so plainly and the model asks for user-supplied
   images instead; the blueprint is still written, with REF entries only for images the
   user gave.

Which provider was used is recorded per REF, so a reference can be traced to its source.

Each image becomes a **REF** entry: what it shows (regions, controls, states), which items
it informs, and **what it cannot prove** (motion, feel, exact colours from a small vision
model) — stated up front, so a green run is not mistaken for a faithful copy.

Constraints:
- Downloaded images are **reference only**: kept local, never copied into the app's assets.
- A 7B-class vision model is good at layout inventories and weak at fine detail; REF
  criteria should be about structure and presence, not pixel matching.
- Refs are attached again when the item they inform is built, so the builder sees the
  image, not a description from three hours ago.

---

## 6. Budget

**One knob: time.** It is what both real limits are about — compute availability and
life — and turns mean nothing to a person. Default: **no limit** (run until the scope tier
is done).

- **Plans the scope.** The budget is in the blueprint pipeline's input: "3h → v1 = canvas,
  pencil, palette, export; layers deferred". The model estimates items; v1 is sized to fit.
- **Re-plans as it goes.** After each item, elapsed vs remaining is compared; when behind,
  the model is asked to re-plan, and items it drops from the run are marked `[-]` deferred
  (with reason), never deleted. A 27B's estimates will be poor, so this correction matters
  more than the first guess.
- **Priority is the model's judgement.** There is no priority field: blueprint order within
  a tier *is* the priority, and the model may reorder items or move them between tiers
  while planning or re-planning. Autopilot follows the order as the model last left it —
  the next item is the first open one, deferral takes from the end. (Content is
  model/user-owned, so reordering is allowed; only status marks are extension-owned.)
- **Never cuts mid-item.** When the remaining time will not cover the next item, autopilot
  finishes the current one and stops at a clean boundary with a report.
- **Safety ceiling.** One item running far past the whole budget (e.g. 1.5× the budget
  total) is stopped and marked blocked.

**Pause/resume is the second half of the knob.** `/autopilot pause` any time;
`/autopilot resume` later — even in a new session — continues from the blueprint, because
the file is the state. Life getting in the way is handled by pausing, not by budgeting in
advance.

---

## 6a. Checkpoints

An unattended run must be reversible item by item. **On by default**, off with
`autopilot.checkpoints: false`.

- **Own branch.** At run start autopilot creates `autopilot/<slug>` from the current HEAD
  and works there; the user's branch is never touched. If the working tree has uncommitted
  changes, the approval dialog says so ("7 uncommitted files will be the run's starting
  point") and they are committed first as `autopilot: starting point`.
- **One commit per item.** When an item turns `[x]`: `autopilot R-03: Palette — 16
  swatches, custom picker`, including the blueprint. A blocked item is committed as
  `autopilot R-04 (blocked): …` so its work is kept for review, not lost or silently
  carried into the next item.
- **Never** pushes, rewrites history, or touches other branches.
- **Rollback.** The final report lists each item's commit. `/autopilot rollback R-03`
  resets the run branch to just before R-03 — after a confirmation dialog that names every
  later item it also undoes — and the next pass recomputes the marks from evidence.

**No git in the project.** Autopilot asks once: "This folder isn't a git repository.
Initialize one so each item can be checkpointed?"
- **Yes** → `git init`, a default `.gitignore` if none exists, an initial commit, then as above.
- **No**, or git is missing / `init` fails → checkpoints off, saved to the project's
  autopilot config so it is not asked again. The run still works; the report notes that
  it has no per-item rollback.

---

## 7. The run loop

### Order of gates

Autopilot is a gate lane (`"autopilot"`) and always **last**: verify → scenarios →
browser → QA → polish/expand → autopilot. It only acts when nothing else claimed the
follow-up — the model never gets "fix these tests" and "start the next item" together.

### Each step

1. **Pick** — the next open item in the current tier (blueprint order); mark `[~]`.
2. **Brief** — the follow-up names the item, its criteria, its evidence, its refs (images
   attached), and the blueprint summary (ids + marks only, not the whole file).
3. **Build** — ordinary pi; existing gates apply as always.
4. **Prove** — when the gates are green, the item's evidence is checked: its spec run (or
   verify). Pass → `[x]`. Fail → back to the model, counted against the item.
5. **Repeat** until the scope tier is done, the budget says stop, or the user pauses.

### Questions and stops

- When the model stops without finishing, the next brief is the nudge — no detection of
  "did it stop" beyond the agent settling with open items.
- Questions are handled by the brief itself, not by detecting a question:
  "If you asked the user something, choose what you would recommend, record it under
  Assumptions as `A-nn (R-xx): …`, and continue." Assumptions are shown in the final report.

### "Done" is checked, not claimed

The model can call `finish_autopilot` when it believes the scope is done. The extension
checks: open items in scope? gates green? every `[x]` still passing (re-run their specs)?
If not, the model is told what is still open and the run continues.

### Stuck items

Per-item attempt cap (default 3 proving failures) → `[!]` blocked with the last failure as
reason; the run moves on to the next item instead of stopping. Anti-loop still applies; a
hard stop pauses autopilot (user-help), it does not end the run.

### Compaction

The blueprint summary is re-sent with every brief, so after compaction the model is
re-anchored on what is done and what is next. The full file is read with `read` when needed.

---

## 8. Visibility

- **Footer:** `autopilot: R-03/14 v1 · 1:12 of 3:00` (or `· no limit`).
- **Working message** during proving: `Autopilot — proving R-03 (palette.spec.ts) · 0:21`.
- **`/autopilot status`** — current item, marks per tier, time used, blocked + reasons.
- **Final report** (on any stop): done / blocked (why) / deferred (why) / needs you
  (`manual` items) / assumptions made / how to resume.
- The blueprint itself is the long-term tracking surface: open it any time.

---

## 9. Commands, tools, config

| Command | |
|---|---|
| `/blueprint <prompt>` | write a blueprint only |
| `/autopilot` | start on the existing blueprint (same approval dialog) |
| `/autopilot pause` / `resume` | stop at once / continue from the file |
| `/autopilot status` | progress |
| `/autopilot rollback <id>` | reset the run branch to before that item (confirmed) |
| `/autopilot off` | disable for this session (tool hidden) |

| Tool (model) | |
|---|---|
| `start_autopilot` | propose a run → approval dialog |
| `write_blueprint` | standalone blueprint request |
| `blueprint_check` | validate the file's shape, return problems |
| `find_reference_images` | image search + download to refs/ |
| `finish_autopilot` | claim done → verified by the extension |

```json
"autopilot": {
  "enabled": true,
  "headless": "deny",
  "itemAttempts": 3,
  "defaultScope": "v1",
  "budgetCeiling": 1.5,
  "checkpoints": true
}
```

---

## 10. Build phases

**Phase 1 — cheap route, anchored.** The engine and the stopping rule, with the smallest
possible plan: semantic trigger + approval + off switches; a checklist file the model
writes (items + `proves:`), extension-owned marks; the brief/nudge with the assumptions
rule; completeness gate (last lane); time budget without re-planning; pause/resume;
checkpoints (branch + commit per item, git-init offer); final report.
*Exit test:* on the 27B, "build <small app> to spec, come back when done" reaches the end
of v1 unattended, or stops with an honest report. This tells us how much phases 2–4 matter.

**Phase 2 — blueprint pipeline.** Full format (tiers, criteria, evidence mapping),
`blueprint_check`, standalone `/blueprint`, budget-aware scoping and re-planning.

**Phase 3 — references.** User images and image search → REF criteria, refs kept and
re-attached when their items are built.

**Phase 4 — independent check.** A separate critic model compares the blueprint (and
refs) with the result at the end of a tier; gaps become new items. Reuses expand's critic.

---

## 11. Decisions (2026-10-15)

1. **Checkpoints** — on by default, off by config; own branch, commit per item; no git →
   ask to init, refusal or failure → off for the project (section 6a).
2. **Image search** — use whatever the user has available: a session tool first, then the
   research key if it covers images, then other configured keys; none → user images only
   (section 5).
3. **Priority** — the model's judgement: blueprint order is the priority; reorders and tier
   moves the model makes are followed (section 6).
4. **Scope** — standalone feature; the separate, unbuilt `architect` design is out of scope
   and not coupled to this one.
