# plan — design

Status: **built** (2026-10-16), all six phases in section 13. Extends and replaces the
blueprint half of `extensions/autopilot/DESIGN.md`. Points (section 4) live in
`POINTS.md`; sources in `sources/INDEX.md`; moment checks in `checks.json`; the fresh
read in `sources/REREAD.json` — all beside the blueprint.

**plan** turns whatever the user gives — one line, a screenshot, ten pages of design — into
a plan that stays **faithful to the source** and **makes sense to the person who will use
the result**, and keeps both visible for the whole build. Autopilot becomes one way of
working through a plan, not the owner of it.

---

## 1. Why

From a long build of a game (Leviathan) where 475 green tests sat on top of something
nobody could play:

1. **The translation was lossy and unchecked.** The design doc became the model's own
   build-order file; from then on the model worked only from that paraphrase and never held
   it against the source again. Dense sources get silently simplified; sparse ones get
   silently invented on — and nobody notices until the end.
2. **Everything was local.** One task, one flag, one spec at a time. Nothing in the flow
   made the model hold the experience in mind — "the player is on this screen, deciding
   this, needs to see this, does this, then this happens". Two typical misses:
   - a **mechanic instead of a decision**: the route map let the player click to the end of
     the route, when picking a road should *choose* the next leg, resolved when Travel starts;
   - a **decision without its information**: the blueprint stage asked where to add a wagon
     without showing the train.
3. **Progress was counted in the wrong unit.** "95/95 tasks" said nothing about whether a
   person could do anything with it.

(The back-door specs, journeys and the result bar — the other half of that lesson — are
built: see scenarios.)

Not a goal: judging fun, feel or balance. plan checks **faithfulness** (does the build do
what the source says) and **comprehensibility** (does every moment have a clear decision,
the information for it, a meaningful action and a visible result). Fun stays `manual`.

---

## 2. Where plan sits — by size of work, not by mode

| Work | Planning |
|---|---|
| **Small** — a fix, a tweak, a feature inside an existing plan | None. Gates as usual. |
| **Large build from a source** — a new app or game, a design doc, an overhaul | The pipeline below is a real step. In normal development it is **offered, not forced**; in autopilot it is required. |
| **A plan exists** | Normal development uses it lightly (section 9); autopilot works through it. |

The model recognises "plan-sized" from meaning, like autopilot requests: a `propose_plan`
tool whose description says when (a new product, a design doc to implement, an overhaul),
offered with one line of why; the user can decline. No keywords.

**Work that grows.** A build rarely announces itself: the Leviathan began as a small room
game and became a large design over many prompts. So the offer also comes when a project
without a plan has *grown* into one — signals: a design doc appeared or changed a lot, many
sessions of feature work on the same product, the model itself keeping a build-order or
task file. At most once per session, and never again in a project where the user declined
(remembered in the project's plan config).

```
SOURCES (yours: intent)          one line · design docs · screenshots · references
   │  fingerprinted, never rewritten by the model
   ▼
POINTS (S-nn)                    what the sources say, quoted verbatim
   ▼
READING                          interpretations (I read X as Y) · additions · not covered
   ▼
WALKTHROUGH (M-nn)               the experience, moment by moment
   ▼
ITEMS (R-nn)                     tiered, each serves points, belongs to a moment, has evidence
   ▼
REVIEW (you)                     reading + walkthrough, minutes not hours
   ▼
BUILD                            step by step or autopilot — source quotes in view
   ▼
MOMENT CHECKS                    when a moment's items are done: narrate, then screen questions
   ▼
REPORT                           progress per moment
```

**Extension split.** `plan` owns the blueprint file, its checker, sources, points, reading,
walkthrough, moment checks and the light normal-development integration. `autopilot` keeps
the run: approval, briefs, budget, checkpoints, stall handling, playtest — and calls plan for
everything about the plan. Turning autopilot off never turns planning off.

---

## 3. Sources

Whatever the user provided, as given:

- **Text** — the prompt itself (saved verbatim), and any files the user points at
  (`DESIGN.md`, specs, notes).
- **Images** — screenshots or references ("a game like this"); described via the session
  model or vision-relay, as REF entries do today.
- **Found references** — image search / web research results, marked as found by the model,
  not given by the user.

Stored under `.pi/blueprint/sources/` (files copied, or referenced in place for large or
living docs) with a fingerprint per source in `sources/INDEX.md`:
`- SRC-1 DESIGN.md · 691 lines · sha 3f9a… · given by user · 2026-10-15`.

**The source is the truth for intent; the model never edits it.** If the user's design doc
lives in the repo and the user evolves it (designer sessions), that is their edit — see
change tracking (section 4).

---

## 4. Points

Before any planning, every source is broken into **points** — one statement each, with a
**verbatim quote** and where it is:

```
- S-07 (DESIGN.md §2 "The route map") "Branching goes up to 5 branches wide. The map fans
  out, so the player is choosing a route, not just a next step."
- S-08 (DESIGN.md §2 table) "Chart — pick the next destination on a random map"
- S-31 (screenshot ref-2.png) top-left: a resource bar with three icons and numbers
```

Points live in `.pi/blueprint/POINTS.md` (a dense doc yields a hundred or more; they would
drown the blueprint). The blueprint refers to them by id.

**Coverage rule** (`blueprint_check`): every point is served by at least one item or moment,
**or** listed under *Not covered* with a reason (deferred to a tier, out of scope, open
question). Nothing is dropped silently.

**Sparse vs dense is visible, not guessed.** "Build me a Minecraft clone" yields 2–3 points
and the plan is mostly additions — the model is *designing*, and the walkthrough deserves the
user's eye. A ten-page doc yields 120 points and few additions — the model must be
*faithful*, and every addition deserves a second look. The report states the ratio.

**Change tracking.** On every plan touch (session start with a plan, `blueprint_check`,
autopilot step), source fingerprints are compared. A changed source is re-split; points that
changed, appeared or vanished are listed, and every item and moment that serves them is
flagged `· review: source changed (S-07)` until the model (or user) confirms or adapts it.

---

## 5. Reading — what the model did with the source

A short section in the blueprint, written by the model, reviewed by the user:

```
## Reading

### Interpretations
- I-01 (S-08) "pick the next destination" — I read it as: on the Chart the player selects ONE
  of the reachable nodes; the choice is shown and can be changed; it takes effect when Travel
  starts. Not: walking the whole route by clicking.
- I-02 (S-12) "decide where the empty wagon spawns" — the train must be visible in Blueprint,
  with the insertion points marked; the player picks one.

### Additions (not in the sources)
- A-01 How the player learns the controls: a one-line hint per stage, dismissable. → M-01
- A-02 The legacy room-capture rules are off once the Leviathan cycle is on. → M-02

### Not covered
- S-44 Crane-yard fees — deferred to v2 (economy first).
- S-51 "Diving into wagons" — PROPOSED in the doc, not AGREED: left out, question Q-03.
```

- **Interpretations** are where misreadings live; listing them is the cheapest moment for the
  user to catch "no, that's not what I meant" — before anything is built.
- **Additions** make invention visible (and, for sparse sources, reviewable).
- **Not covered** makes omission explicit.

---

## 6. Walkthrough — the experience, moment by moment

For the `product` bar, before items: the main loop (and its edges) as numbered moments, each
answering the same questions:

```
### M-03 Chart the next leg
- Situation: the route map for this leg; the current node marked; reachable nodes lit.
- Decision: which road to take — easy (forgo prizes) or hard (risk for better rewards).
- Needs to see: which nodes are reachable from here; each node's kind and risk; what is selected.
- Does: click a reachable node (click again or another node to change).
- Feedback: the node and its road highlight; a line "Next: <destination> — starts at Travel".
- Then: Travel moves the Leviathan to the chosen node; the map is not walked by clicking.
- Turns off: room charging, Q/E room cycling — this is a map screen, not the interior.
- Serves: S-07, S-08 · Items: R-11, R-12
```

**Turns off** exists because mode switches are where old and new behaviour collide (the
Leviathan's legacy rules kept running under the chart).

**Forgotten moments checklist.** The walkthrough states for each whether it applies (and
where): first launch / orientation · learning the controls · waiting / idle · failure and its
feedback · cancel / undo · the end of the loop and starting again · switching modes or
stages · saving and coming back. Design docs routinely describe rules and skip these.

For the `spec` bar the walkthrough is optional; interpretations and coverage still apply.

For apps the same structure fits: a moment is a user task ("add an expense": needs to see
the categories, does pick one and type an amount, feedback: the total updates, then: the list
shows it).

---

## 7. Items

Unchanged shape plus two references:

```
- [ ] **R-11** Click a reachable node to select the next leg; selection shown and changeable
  · moment: M-03 · serves: S-07, S-08 · input: click a reachable node · proves: chart.spec.ts
```

- `moment:` required for player-facing items in `product`; `serves:` required unless the item
  is an addition (`serves: A-01`).
- Order inside a tier stays the model's judgement (decided earlier).
- A moment is **complete** when all its items are `[x]`.

---

## 8. Checks

### At planning time — `blueprint_check`
- every source point covered or listed as not covered (section 4);
- `product`: walkthrough present; every moment has all fields; forgotten-moments checklist
  answered; every player-facing item names its moment and input;
- every moment is served by at least one item; every item's references exist;
- sources' fingerprints match `INDEX.md` (else: re-split, flag affected items).

### Independent re-read
A **fresh pass** — no blueprint, no build context — splits the sources into points on its
own; the two point lists are compared, and points the plan lacks become findings. Catches
what the builder skipped or misread at the start. Best with a separate model (like expand's
critic); a fresh session of the same model works too. Cost: one pass per source at planning
time and after a source change.

### Moment checks — when a moment's items are complete (both modes)
1. **Narrate (cheap, text):** the model describes the moment as the code *now* behaves —
   what happens when the player does each thing — next to the moment's fields and its source
   quotes. Mismatches ("clicking a node moves the train immediately" vs "takes effect at
   Travel") become findings.
2. **Screen questions (vision):** the journey (or play mode) screenshots the moment. A pass
   that sees **only the screenshot** answers questions **generated from the moment's fields,
   without their answers**:
   - from *Needs to see*: "From this screen alone: which nodes can be chosen? Where would the
     new wagon be attached?"
   - from *Decision*: "What is the player choosing here?"
   - from *Feedback/Then*: "What is currently selected? What happens next?"
   Concrete questions are hard to bluff; "cannot tell" or a wrong answer is the finding.
   **Same model for now** (decided), in a fresh context that sees only the screenshot and
   the questions. A text-only session model goes through vision-relay; with no way to see
   images the screen questions are skipped and the report says so — the narration still runs.

Findings become items in the current tier (`· from: M-03 check`) — in autopilot automatically;
in normal development they are reported and proposed.

### Before finishing a tier
Autopilot's playtest (built) stays, and now walks the moments in order.

---

## 9. Normal development with a plan

When a blueprint exists, in every session (not only during autopilot):

- **Summary in each prompt** — goal, bar, the moment being worked on and its open items,
  moment status line. Short (ids, not the file). The model keeps the big picture.
- **Plan in the plan.** The model is told to plan and track there — not in a build-order
  file of its own (a second plan pi-client cannot see always wins).
- **Building an item step by step** ("build R-11", or the model picking it): the model gets
  the item with its moment and the verbatim source quotes it serves — the same context an
  autopilot brief carries.
- **Marks from evidence in every mode.** When an item's spec (or verify) passes in a normal
  gate run, its mark turns `[x]`; the extension still owns the marks.
- **Moment checks** fire when a moment completes, as in autopilot; findings are reported and
  proposed as items rather than added silently.

No budget, no checkpoints, no automatic briefs, no stall nudges — that is autopilot's.

---

## 10. Review by the user

What the user reviews is small on purpose: **Reading** (interpretations, additions, not
covered) and the **Walkthrough**. Not the item list.

- **Autopilot: no review.** Autopilot is hands-off until the job is done: the model writes the
  Reading and Walkthrough, checks them itself, and builds. The start approval stays (it is the
  switch); its dialog shows the counts ("120 points: 113 covered, 4 deferred, 3 questions ·
  9 interpretations · 15 additions · 11 moments") so the user knows what they are starting.
  The Reading and Walkthrough are in the blueprint to read at any time, and the final report
  leads with them — what was interpreted, added and left out.
- **Normal development:** when a plan is written or changes materially, the model presents
  the Reading and Walkthrough and asks before building.

---

## 11. Progress and reports

Progress is reported **per moment**, items second:

```
M-01 Orientation       ✓ checked
M-02 Prep              ✓ checked
M-03 Chart             built · screen check: "can't tell what is selected" → R-31 added
M-04 Blueprint         2/5 items
M-05 Travel            not started
```

Final reports (autopilot and on request) lead with moments, then points coverage, then items.

---

## 12. Cost on a small model

- The prompt carries the summary, never POINTS.md or the full blueprint.
- Moment checks: one narration per moment (text) and one vision pass per moment, only when a
  moment completes — not per edit.
- The independent re-read happens at planning time and on source changes only.

---

## 13. Build phases

1. **Split** — move blueprint code into `plan`; autopilot depends on it. No behaviour change.
2. **Sources + points + coverage + change tracking**, `blueprint_check` rules.
3. **Reading + walkthrough** (fields, forgotten-moments checklist), items' `moment:`/`serves:`,
   briefs carry moments and source quotes.
4. **Normal-development integration** — summary injection, `propose_plan`, marks from
   evidence in gate runs, item context on "build R-nn".
5. **Moment checks** — narration, then screen questions.
6. **Independent re-read** and the review step in the autopilot dialog.

---

## 14. Decisions (2026-10-15)

1. **Review** — autopilot skips it and runs hands-off until done (start approval stays);
   normal development presents Reading + Walkthrough before building (section 10).
2. **Checker model** — the session model, in a fresh context, for now; vision-relay when it
   is text-only; screen questions skipped when nothing can see images (section 8).
3. **Independent re-read — when** — automatically when the text sources together exceed
   **1,500 words** (counted by the extension, never judged by the model): about where a small
   model starts losing details of a document read once. A one-line prompt or short brief never
   triggers it; a real design doc always does. Images are not counted. Config:
   `rereadAboveWords`. Also on request.
4. **Work that grows** — the plan is also offered when a project grows into a large build
   over many prompts (section 2).
