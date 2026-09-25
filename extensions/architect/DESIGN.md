# architect — design

Status: **design agreed, not built.** No code exists yet.

Front-loads the thinking for a new app. One architect run turns a vague idea into a
repo you can develop in, with the Gauntlet Loop's structure baked into artifacts the
existing pi-client gates already enforce.

Source method: <https://somethingbig.ai/gauntlet-loop>

---

## 1. What architect is (and is not)

**Is:** a scaffolder. Runs once (re-runnable to amend), produces artifacts, exits.

**Is not:** a builder, and not a loop runner. After architect finishes you develop
normally in pi. Architect never writes app code.

The Gauntlet Loop's own execution — build → critique → revise — is driven by the
user across two pi sessions, guided by the emitted prompts and enforced by `verify`
and `scenarios`.

### Why not run the loop in-process

The loop's non-negotiable is that **the builder never grades itself** — builder and
critic must have independent context.

pi's extension API has no subagent/spawn primitive (`docs/extensions.md`). The closest
is `ctx.newSession()`, which *replaces* the session rather than nesting one. Running a
second agent via the SDK's `createAgentSession()` inside an extension would mean
rebuilding, by hand and outside pi's expectations:

- **UI** — pi's TUI renders the one session it owns; a child agent's output is invisible
- **Cancellation** — `ctx.abort()`/Esc stop pi's agent, not a child spawned in a tool call
- **Config** — model config, `bootstrap/models.json`, trust, context files, and the other
  pi-client extensions load via pi's startup path; a child inherits none of it, so
  `verify`, `scenarios`, and `anti-loop` would not apply to it
- **Session log** — pi records one conversation; critic reasoning would need its own
  persistence, invisible to `/resume`, compaction, and forking
- **Upgrades** — depends on SDK internals extensions are not the intended consumer of

Decisive point: **a fresh pi session already gives complete context independence, for
free.** In-process spawning would buy *automation*, not better separation.

### The seam

Loop execution lives behind one module. If fresh-session prompts later prove too
tedious, automated orchestration can be swapped in **without changing the artifact
format, the prompts, or `state.json`**.

---

## 2. The bar

The article underspecifies this; in practice it is the whole game. A vague bar produces
a vague critic and the loop degrades into the model congratulating itself.

**Rules:**

- The bar must be **inspectable** — a URL, screenshot, reference repo, or named work.
  "Make it polished" is rejected; architect refuses to proceed.
- Bar comes from **user-supplied references, architect research (Lane C
  `web_search`/`fetch_web_page`), or both** — but is **always user-approved**. Nothing
  proceeds until locked.
- Architect **writes the bar down as named criteria** (`BAR-01`…), because a critic three
  sessions later cannot re-derive them from the image.
- Architect **names what the references cannot carry** rather than pretending one image
  is enough (e.g. motion, feel).

### Worked example — "Creatures of the Deep" fishing game

From one gameplay screenshot:

```
BAR-01 camera    high-angle ~60°, fixed tilt, no orbit
BAR-02 palette   desaturated teal water, chalky pastel land, no pure black
BAR-03 geometry  low-poly flat-shaded, chunky silhouettes
BAR-04 water     depth gradient, shallow ring at shorelines
BAR-05 wake      discrete foam dots, not a texture strip
BAR-06 hud       rounded pills, transparent backing, soft shadow
BAR-07 density   many small props per island, not few large

Gaps: no motion reference (BAR-05, camera drift), no fishing frame.
```

Note the criteria differ **in kind**: BAR-02 is checkable from one still; BAR-07 needs a
side-by-side; BAR-05 needs motion. That difference drives decomposition.

---

## 3. Decomposition

The test is **"can this be judged separately against the bar"** — stricter than "can this
be built separately."

Two traps, both seen in the worked example:

- **"Art direction" is not a piece.** It is the bar itself — the criterion every piece is
  judged by.
- **"Fishing feel" fails independence the other way.** A screenshot cannot judge it, so it
  needs different evidence or does not belong in a visual gauntlet.

Each piece carries: scope, the BAR-ids that judge it, and **what evidence would prove it**.
Evidence maps onto `scenarios` specs so the critic gets real pixels, not a description of
pixels.

```
water      BAR-02,04     evidence: screenshot, 3 camera heights
islands    BAR-03,07     evidence: screenshot, 2 islands
camera     BAR-01        evidence: 5s capture ⚠ weak from stills
boat+wake  BAR-05        evidence: 5s capture ⚠ weak from stills
hud        BAR-06        evidence: screenshot
```

**Honest limitation, stated up front:** for a game, wake, camera drift, and feel are much
of what makes it match the reference, and none survive flattening to a screenshot. A
screenshot gauntlet covers maybe 70% of that bar; the rest needs the user looking at it.
Better known early than discovered via a loop reporting green on a game that feels dead.

---

## 4. Output: `.pi/architect/`

| Artifact | Role |
|---|---|
| `brief.md` | Goal, locked bar with evidence, constraints |
| `bar/` | Reference images/URLs |
| `pieces/<piece>.md` | Scope, BAR-ids, evidence required |
| `prompts/build-<piece>.md` | Builder prompt → `/build-<piece>` |
| `prompts/critique-<piece>.md` | Critic prompt → `/critique-<piece>`, fresh session |
| `state.json` | Verdict log (append-only) + running markers |
| `progress.html` | Renders from `state.json` |

Outside that folder: `AGENTS.md`, project structure, `.pi/scenarios/` specs per piece.

### Stack

**Infer, then confirm.** Architect proposes a stack from the goal plus
`extensions/shared/stack-detect.ts`, shows it, and waits for approval **before writing any
file**.

---

## 5. Session flow

### Session 1 — architect

```
D:\games\deep> pi
/architect
```

Empty repo, no `.pi/architect/` → architect stays quiet until invoked; it does not hijack
a normal session.

1. **Interview** — what, scope for v1, hard constraints
2. **Bar** — user pastes references; architect reads back named criteria + gaps; **user
   approves**
3. **Decomposition** — proposed with BAR-ids and evidence; user edits in chat (merge, drop,
   split) until happy
4. **Stack** — proposed, waits for approval
5. **Write** — only now touches disk; prints what it made
6. **Hand off** — states the loop and exits

### Session 2 — build

```
/build-water
```

Loads the piece: scope, BAR criteria verbatim, reference image, evidence required. Reads
any open verdict and works on that gap. Ordinary pi from here; `verify` and `scenarios`
apply as always.

### Session 3 — critique, **fresh window**

```
D:\games\deep> pi
/critique-water
```

### Session 4 — back to build

Loop 3↔4 until the critic stops finding gaps. **No round limit** — per the article, no
arbitrary final round.

---

## 6. The fresh window

### What it means

A **new pi process, new session, empty conversation**. Same repo, same files on disk, zero
shared conversation.

### Why it is required

In the same session the critic sees the builder's reasoning, and that reasoning is
uniformly self-justifying:

> "The shoreline uses a hard cutoff because a smooth gradient caused z-fighting with the
> sand mesh — going with the cutoff for now."

A model reading that is no longer looking at pixels; it is looking at an argument for why
the pixels are acceptable, written by itself, and it will agree. Not dishonesty — that is
what context does. Result: `✓ BAR-04 met — deliberate tradeoff, documented above.` The gap
is still on screen.

Since the loop's entire output is the critic's verdicts, a compromised critic makes the
whole thing decorative.

### The one-way valve

**Crosses the boundary (disk only):**

```
reference image        .pi/architect/bar/ref-01.png
criteria               BAR-02, BAR-04  (verbatim text)
current pixels         screenshot from the piece's scenario
open verdicts          state.json — prior gaps, for regression checks
```

**Never crosses:** the build transcript, agent rationale, why anything was done, what was
hard. The critic does not know a human or a model made this.

Verdicts flow back to the builder. Reasoning flows builder→critic **blocked**.

### Guard

`/critique-<piece>` checks whether this session has already run a build:

```
⚠ This session ran /build-water. The builder would be grading itself.
  Open a new pi window and run /critique-water there.
  Continue anyway? (verdict will be marked UNTRUSTED in state.json)
```

Not blocked — but recorded as `UNTRUSTED` in `state.json` and rendered distinctly in
`progress.html`, so a self-graded pass never reads as a real one.

### Cost, stated plainly

Two terminals, and a window switch per critique. Inherent. What is designed away is
*ambiguity about which window you are in* — never the switch itself.

---

## 7. Critic vision model

### The problem

The critic compares images. On a small local text model it produces confident, worthless
verdicts — clean, isolated, well-formed, and wrong.

### Existing state (verified)

`extensions/scenarios/vision.ts` `buildVisionMessage` attaches images to the **current
session's model**. There is no second-model call anywhere in pi-client. The
separate-model branch is genuinely new code.

### What makes it buildable

`dist/core/model-registry.d.ts`:

- Every model declares `input: ("text" | "image")[]` — **"is your model multimodal?" is a
  fact pi already knows**, not something the user must work out
- `getAvailable()` → models with auth configured
- `getApiKeyAndHeaders()` + `streamSimple` → a **one-shot call to a different model**
  without touching the session's model. No second agent, no orchestration.

### `/architect critic`

```
Critic vision
  Session model:  qwen2.5-coder-32b   text only  ✗ cannot see screenshots

  Visual criteria (BAR-02/04/07) need a model that accepts images.

  1  Use a separate vision model for critique only     ← recommended
  2  Switch session to a multimodal model
  3  Text-only critique (visual criteria marked UNJUDGED)

  > 1

  Available vision models:
  1  qwen2.5-vl-7b      local-gpu
  2  claude-opus-5      anthropic
  > 1

  ✓ Critique routes to qwen2.5-vl-7b. Builder stays qwen2.5-coder-32b.
```

If the session model already accepts images, architect says so and offers to use it.

Saved to `~/.pi/architect.config.json`, project override supported (matches existing
pi-client config convention; ship `architect.config.example.json`).

**Option 3 is honest, not a fallback:** visual criteria are marked `UNJUDGED` in
`state.json` and render **grey** on the progress page — never green. A gap you cannot see
is not a gap you have closed.

---

## 8. Cross-session awareness

### Principle

The two sessions talk **only through `state.json`** — never a direct channel. The moment
two sessions have a live channel, the leak the fresh window exists to prevent is rebuilt.

Watching a file the critic wrote is no different in kind from the user reading it; it is
just faster. The one-way valve holds:

```
CRITIQUE session ──writes──> state.json ──watched──> BUILD session
                                  ▲
                        already the crossing point
```

### Mechanism

`fs.watch` on `.pi/architect/state.json`, started in `session_start`, torn down in
`session_shutdown` — the lifecycle `docs/extensions.md` prescribes ("do not start
background resources from the factory").

- **Atomic writes** — write `state.tmp.json`, then rename (atomic on NTFS)
- **Debounce ~200ms + JSON-parse guard** — Windows `fs.watch` fires multiple events per
  write and can fire mid-write; partial reads are discarded, not shown
- **Diff against last-seen verdict id** — announce new verdicts only, not every touch
- **Session id stamp** — a session never notifies itself about verdicts it caused

### Running markers

`state.json` holds more than finished verdicts. The critique session writes a **running
marker** on start and clears it on verdict write. Without this, a session shows nothing
while the other window is actively grinding, and the user cannot tell whether to wait or
switch.

Three distinguishable states + staleness:

```
● Critic running   — water, started 40s ago
● Critic finished  — water: BAR-04 shoreline gap · just now
● Critic stalled   — water, no result for 8m (window closed?)
```

---

## 9. Widget wording rules

Widgets are **passive display** (`ctx.ui.setWidget`, above/below editor). They must not
steal focus, interrupt a stream, or inject agent input. If the user is mid-build the
widget waits.

**Never imply an affordance that does not exist.** An earlier draft used `↵ /build-water`,
implying Enter runs it — widgets cannot be focused, so that keybinding is fake.

**Format:** `verb phrase` → *what/which* → `command` → plain-verb clause for what the
command does → *age*.

**The widget never tells the user what to think about the work, only what the command
does.** "Fix it" is a judgment and assumes the verdict is a defect — often it is new work,
not a repair. "Send this gap to the builder" is a description of the mechanism.

**Timestamps everywhere** — the difference between `just now` and `9m ago` is the
difference between a live loop and a dead window.

**"No action needed" must be said explicitly.** A widget that only appears when action is
required trains the user to read its presence as a demand; when it is merely informational
it should say so.

### In the build window

```
┌────────────────────────────────────────────────────┐
│ ● Critic running — water, started 40s ago          │
│   waiting for the verdict                          │
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│ ● Critic finished — water: BAR-04 shoreline gap    │
│   /build-water — send this gap to the builder      │
│                                          · just now│
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│ ● Critic passed — hud meets the bar      · 2m ago  │
│   no action needed                                 │
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│ ● Critic stalled — water, no result for 8m         │
│   /architect status — check the critique window    │
└────────────────────────────────────────────────────┘
```

### In the critique window

```
┌────────────────────────────────────────────────────┐
│ ● Builder running — water, started 1m ago          │
│   wait for it to finish before critiquing          │
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│ ● Builder finished — water rebuilt (iter 4)        │
│   /critique-water — judge it against the bar       │
│                                          · just now│
└────────────────────────────────────────────────────┘
```

---

## 10. Flow legibility

The user must never have to hold a session-lifecycle model in their head. **pi always
states the one next thing.**

### Every architect output ends with the literal next action

```
✓ Water build complete.

  NEXT: critique — needs a fresh session (builder can't grade itself)

    ┌─────────────────────────────────────────┐
    │  Open a NEW terminal, then:             │
    │    cd D:\games\deep                     │
    │    pi                                   │
    │    /critique-water                      │
    └─────────────────────────────────────────┘

  Leave this window open — you'll come back here to fix what it finds.
```

The last line is essential: not just "go", but **"come back here, and why."**

### On arrival, pi says where you are

Launching pi in a repo with `.pi/architect/`, before the user types anything. Printed
once as a normal startup notice — **not** a widget, since it is a one-time orientation,
not live state:

```
Architect — Creatures of the Deep          3 pieces · 1 met

  water   critic found a gap    BAR-04 shoreline, iter 3 · 12m ago
  hud     meets the bar         iter 2
  boat    not started

  This session has run nothing yet — either role is available.

  /architect next     what to do now
  /architect status   full detail
```

Per §9: no arrows, no implied keybindings. Each piece states **what happened** in a verb
phrase, then detail, then age. Commands are listed as text with a plain-verb clause.

The third line is the session-role statement (below).

### Session role

Derived from what has been run in the session, so it is never ambiguous which window is
which. Shown in the arrival banner and in the footer (`ctx.ui.setFooter`) thereafter:

```
This session has run nothing yet — either role is available.
This session is building water — critique needs a fresh window.
This session is critiquing water.
```

Stated as a **fact about the session**, not a label. `BUILD`/`CRITIQUE` badges would be
jargon the user has to learn; a sentence is self-explaining on first read.

### `/architect next`

Answers "what now" from any window. It knows the session's role, so it can distinguish
"do this here" from "do this elsewhere" — the distinction the whole two-window flow
depends on:

```
> /architect next

  water — critic found a BAR-04 gap (iter 3, 12m ago)

  This session is critiquing. The gap is already recorded, so there is
  nothing to judge here.

  Switch to your build window and run:
    /build-water
```

When the action belongs in *this* session, it says so plainly:

```
> /architect next

  water — builder finished iter 4 (just now)

  This session has run nothing yet, so it can judge:
    /critique-water — compare it against the bar
```

And when the loop is genuinely done for now:

```
> /architect next

  All three pieces meet the bar.

  No action needed. Add a piece with /architect amend, or keep
  building normally — the gates stay on.
```

**Rule:** `/architect next` never lists more than one action. Its entire job is removing
the decision, so offering a menu would defeat it. Full detail lives in
`/architect status`.

---

## 11. Second terminal spawn

**On by default**, user can disable.

First time only:

```
Opening a second terminal for critique.

  The critic must run in a fresh session — otherwise the builder
  grades its own work and the verdict is worthless.

  This will happen automatically from now on.
  Turn it off: /architect terminal off
```

Then silent. Uses `wt` if present, else `cmd`; cwd set; command **pre-typed but not
executed** — the user presses Enter. Launching a window is acceptable; running something
in it unattended is not.

On spawn failure (no `wt`, restricted policy): falls back to the copy-paste box **and says
why** — never a dead end.

---

## 12. Commands

| Command | Purpose |
|---|---|
| `/architect` | Run the interview → bar → decomposition → stack → write flow |
| `/architect status` | Per-piece detail: gates, verdicts, iteration |
| `/architect next` | "What now" from any window |
| `/architect progress` | Open `progress.html` |
| `/architect amend` | Re-run decomposition against existing brief; **keeps verdict history for surviving pieces** |
| `/architect critic` | Vision model routing (§7) |
| `/architect terminal on\|off` | Second-terminal spawn (§11) |
| `/architect dismiss` | Clear current widget |
| `/build-<piece>` | Generated per piece |
| `/critique-<piece>` | Generated per piece; fresh session |

**Re-runnable by design.** Pieces turn out wrong mid-project — merged, split, dropped. A
plan that cannot be amended is how these get abandoned.

---

## 13. Trust boundaries

Two guarantees of different strength, and they must not be confused.

**Mechanical (trustworthy):** `verify` and `scenarios` pass/fail. Cannot be talked out of.

**Critic verdicts (soft):** only as honest as the critic prompt being followed. A critic
writing "good enough" without real comparison poisons `state.json`.

Mitigation: **every verdict must cite the specific BAR criterion and the observed gap**, so
an empty verdict is visibly empty rather than quietly green.

`progress.html` therefore shows **two separate columns**, never merged:

```
piece    gates    critic
water    ✓ pass   ✗ BAR-04 open (iter 3)
hud      ✓ pass   ✓ met (iter 2)
boat     — none   ✗ BAR-05 open (iter 1)
```

Green gates on a piece the critic has rejected is exactly the confusion this prevents — a
passing test suite is not evidence of meeting the bar.

Verdict trust levels: **normal**, `UNTRUSTED` (self-graded, §6), `UNJUDGED` (no vision
model, §7). The latter two never render as green.

---

## 14. Relationship to the existing extensions

### How architect differs

The five existing extensions are, structurally, one thing: they hook the agent's turn loop
and gate its finish. `verify`, `scenarios`, and `browser-console` each hook
`before_agent_start` → `agent_end`, run a check, and block completion via
`sendUserMessage(..., { deliverAs: "followUp" })`. `anti-loop` intercepts tool calls and
streams. `research` adds tools plus a procedure.

All are **reactive, per-turn, session-scoped**.

Architect is none of those:

| | existing gates | architect |
|---|---|---|
| Trigger | agent turn | user invocation |
| Lifetime | one turn | outlives every session |
| Output consumed by | current agent | *future* sessions |
| Blocks finish | yes | **never** |

It is the only extension whose artifacts are read by processes that do not yet exist. That
is why it is its own extension rather than a mode of `scenarios`.

### What architect reuses (do not reimplement)

| Module | Use |
|---|---|
| `scenarios/scaffold.ts` `scaffoldScenario()` | Per-piece evidence specs — already handles `ensureWebScaffold`, Playwright deps, never-overwrite |
| `shared/stack-detect.ts` | Stack inference for §4 |
| `shared/agents-md.ts` | `piClientPackageRoot()`, git-root walk, never-overwrite template write |
| `scenarios/vision.ts` | `loadVisionImages`, `resizeImage`, capture spec — critic screenshots go through the same path |
| `shared/config-paths.ts` | `~/.pi/architect.config.json` + project override |

Genuinely new: the interview, the bar/criteria model, `state.json`, the cross-session
watcher, and the second-model vision call (§7).

### Gate-orchestrator conflict — two hard rules

`shared/gate-orchestrator.ts` enforces **exactly one follow-up per agent turn**, with
documented ordering `verify → scenarios → browser-console`. First lane to `tryClaimGate()`
wins; the rest silently skip.

**Rule 1 — architect never claims a gate lane.** It has no `GateLane`, and never calls
`sendUserMessage`. All cross-session signalling is widgets only (§9), which are passive by
construction. A fifth contender would either starve or starve an existing gate.

**Rule 2 — critique sessions must suppress the fix-follow-up.** `/critique-<piece>` runs
`run_scenarios` to obtain pixels. On failure `scenarios` claims the gate and injects a
*fix the tests* follow-up — diverting the critic into repair work, in the session whose
entire purpose is judgment. Worse, it means the critique window starts touching build work,
which is exactly the separation §6 exists to protect.

The critique prompt must therefore run capture in a mode that does not trigger the fix
lane, or architect must set a flag `scenarios` honours for capture-only runs. **Implementation
detail to settle before coding — it requires a change in `scenarios`, not just architect.**

---

## 15. Resolved questions

### Evidence for non-visual criteria — out of scope, explicitly flagged

Criteria like camera drift, wake motion, and feel (BAR-01, BAR-05) cannot be judged from
stills. Video capture is **not** in v1: it needs frame extraction, a model that reasons over
sequences, and far more capture machinery than a screenshot path.

Instead, such criteria are marked `HUMAN` at bar-lock time, and:

- they are **never** assigned to an automated critic
- `progress.html` renders them in a third state — not green, not a gap, but *awaiting you*
- `/architect next` surfaces them when all machine-judgeable pieces are met:

```
  All machine-judgeable criteria are met.

  3 criteria need your eyes — they cannot be judged from stills:
    BAR-01 camera drift
    BAR-05 wake in motion

  /architect review — mark them met or reopen with a note
```

This is the §3 honesty point made operational: the loop reports what it *can* judge, and
says plainly what it cannot, rather than reporting green on a game that feels dead.

### `/architect amend` and the bar — bar is amendable, criteria are append-only

Freezing the bar is wrong: the §2 worked example ends by *identifying missing references*,
so adding them later is the expected path, not an exception.

But silently re-deriving criteria would invalidate history — a verdict citing BAR-04 becomes
meaningless if BAR-04 later means something else.

So:

- **New references may be added at any time.** Architect proposes new criteria from them;
  the user approves, exactly as at lock time.
- **Criteria ids are append-only and immutable.** New references yield BAR-08, BAR-09 —
  never a redefined BAR-04.
- **Superseding is explicit.** A criterion can be marked `superseded by BAR-09`, which
  closes its open verdicts with that reason recorded rather than deleting them.
- **Affected pieces reopen.** Any piece judged by a new criterion returns to "not met",
  with the reason stated: `reopened — BAR-09 added`.

History stays readable: every verdict continues to mean what it meant when written.

---

## 16. Open questions

1. **Gate suppression mechanism** (§14 Rule 2) — flag honoured by `scenarios`, or a
   capture-only entry point? Requires a change in `scenarios`.
2. **Piece identity across `amend`** — if the user merges `islands` into `water`, what
   happens to the merged piece's verdict history? Concatenate, or archive and start clean?
