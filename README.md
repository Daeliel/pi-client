# pi-client — guardrails that make small local models actually finish coding tasks

> ⚠️ **Heavily work-in-progress.** This is an evolving personal toolkit that I'm opening up because it already makes a real difference for local-model coding agents. Expect rough edges, breaking changes, and opinionated defaults. Ideas, issue reports, and PRs are very welcome.

**pi-client** is a foundation package for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`@earendil-works/pi-coding-agent`). It targets a specific, underserved setup: **Pi running against a small local model** (LAN GPU box or your own machine, any OpenAI-compatible server — llama.cpp / llama-server, LM Studio, Ollama, vLLM…).

Small models are cheap and private, but they thrash: they repeat the same tool call ten times, "think" in circles, hallucinate `<tool_call>` XML that never executes, claim work is done while tests fail, and declare a UI fixed without ever looking at it. pi-client wraps Pi in a set of **hard gates and recovery steers** that push a small model through the loop: *change code → verify → prove the behaviour → only then finish*.

## Model support status

Tested day-to-day against two models on a LAN GPU box:

- **`qwen3.6-27b-q6-dflash` (Qwen 3.6 27B, Q6 + DFlash, served by Beellama): works well today.** This is the setup the toolkit is developed against, and the current gates + anti-loop steering measurably improve task completion — the model gets caught when it loops, gets a failing test report instead of silently stopping, and gets screenshots pushed into context for visual claims.
- **`ternary-bonsai-27b` (Ternary Bonsai 27B, served by Prism): not where it needs to be yet.** Support is in active development — ternary models thrash differently and need tighter steering than the current heuristics provide. I'm working hard on extending this, and I'll gladly take ideas and PRs from anyone experimenting with ternary inference.

Any OpenAI-compatible server works; those two are simply what the guardrails are tuned against right now.

## What's in the box

Eleven Pi extensions, three skills, four prompt templates, and a config layering system.

### Extensions

| Extension | What it does |
|---|---|
| **anti-loop** | Breaks weak-model thrash. Blocks a tool call repeated 3 times with no edit in between (also when calls alternate, A,B,A,B,A), aborts mid-stream when the thinking channel cycles the same plan lines, auto-continues on max-output-token truncation, recovers "ghost" tool calls written as text (Hermes `<tool_call>`, `<function_call>`, `[TOOL_CALLS]`, bare JSON), and hard-stops the agent after 2 recoveries without progress so a stuck model can't pin your GPU. A successful edit counts as progress and resets the budget. `/anti-loop on\|off\|status\|reset` · **User-help** mode: when the model is going in circles — or you type while it is visibly thrashing — it stops investigating and asks you for what it cannot observe (where it broke, console output, the exact click). Ordinary steering while it works is delivered as-is. Also entered after a hard stop. `/stuck`, `/stuck off` |
| **verify** | Blocking lint/build/test gate. Lints changed files inline after every edit; at the end of each turn runs the full check suite and, if it fails, re-triggers a fix turn with a classified failure report (max 5 attempts, then it gives up cleanly). Python (ruff/pytest), Node (eslint/tsc/npm test), C# (dotnet) out of the box; any language via config. `/verify`, `/doctor` |
| **scenarios** | Acceptance-test gate. The model must *define* user-visible flows (`define_scenarios`), write runnable specs (Playwright for web, pytest for API, scripts otherwise), and *pass* them (`run_scenarios`) before finishing. Includes spec-quality auditing (catches "weak proof" specs that pass without actually testing the flow), failure screenshots fed back as vision input, an optional visual-QA screenshot gate (model- or human-approved), and spec housekeeping. `/scenarios …` |
| **browser-console** | Attaches to a live Chrome/Edge via CDP (auto-launches a debug profile if needed). Console errors after web edits come back inline in the edit result; remaining errors block the finish. Also: network failure reports, live-tab screenshots with Playwright fallback, navigate/reload tools. `/browser …` |
| **project-context** | Auto-scaffolds an `AGENTS.md` at the repo root on first session (never overwrites) and injects it into the first turn. `/agents-init` |
| **research** | `web_search` + `fetch_web_page` via the Brave Search API (free tier works) so the model can look up real docs instead of hallucinating APIs. `/research setup` |
| **release** | Flutter Android release lane: `release_doctor` (toolchain preflight) and `release_build` (APK/AAB with artifact verification). `/release doctor`, `/release build apk` |
| **polish** | Asks "is it good?" where the gates ask "is it broken?". A level knob (`off` / `basic` / `standard` / `showcase` / `ultimate`, or `auto`) decides how many "name the three weakest things and fix them" passes each UI surface gets. Surfaces are tracked in `.pi/polish/inventory.json`; scope follows the request, and loop guards stop a surface that keeps naming the same weakness. Optional separate vision-model critic at `showcase`+. `/polish <level>`, `/polish status`, `/polish critic <provider/model>` |
| **expand** | Polish's sibling for depth: gap analysis over what already exists (content pools, mechanics, entity types, workflows). `/expand map` records a systems map, `/expand pillars` sets design pillars, `/expand ideas` proposes ideas along four axes (`more`, `deeper`, `wider`, `tension`) that must each name the system they build on and the gap they fill. Then it stops for you to `/expand build <n>` or `/expand reject <n>`. Builds end with a fit check (reachable, explained, integrated, sane numbers). State lives in `.pi/expand/ledger.json`. |
| **once** | One-shot modifiers for a single prompt: `/once <modifier> [<modifier> ...] <prompt>`. Polish registers its levels, expand its axes; other extensions can register more via `extensions/shared/once.ts`. `/once` alone lists what is available. |
| **vision-relay** | Lets text-only session models "see". When the session model has no image input, screenshots and pasted images go to a separate vision model and the session gets its description instead. Models declaring `input: ["text", "image"]` still get images attached directly. `/vision status`, `/vision model <provider/id>`, `/vision off` |

A shared **gate orchestrator** ensures only one gate sends a fix follow-up per turn (order: verify → scenarios → browser → QA), so the model gets one clear instruction instead of three competing ones. A **stack detector** (Node, Python, Flutter, C#, static HTML…) tunes the injected procedures and Playwright scaffolds per project.

### Why gates instead of prompting?

Small models ignore polite instructions. Everything here is enforced *mechanically*:

- Failing checks send a **follow-up turn** with the failure report — the model cannot settle idle while checks fail.
- Repeated tool calls are **blocked at the harness level** with a steering message, not just discouraged.
- Screenshots are **attached as images** to the conversation, so "the layout looks right" claims are grounded in pixels.
- Every gate has a **max-attempt cap** and a hard stop, so a model that can't fix something fails loudly instead of burning your GPU overnight.

### Skills & prompts

- **skills/visual-ui-debug** — workflow for layout/wrong-screen bugs: reproduce the user's steps in a Playwright spec, screenshot, assert on the named screen. No proxy checks.
- **skills/gotchas** — common correctness traps (mutable defaults, pytest state leaks, concurrency, etc.) the model should actively check for.
- **skills/flutter-android-release** — human setup checklist + agent workflow for Android store builds.
- **prompts/** — `/plan-first` (declare cross-file interfaces before coding), `/review` (independent audit of the changes), `/visual-debug` (forced Playwright repro), `/research` (doc lookup workflow).

## Install

### Prerequisites

- Node.js LTS (with npm)
- An OpenAI-compatible inference server for your model (llama.cpp / llama-server, LM Studio, Ollama, vLLM, …)
- Windows for the install script (the package itself is cross-platform — manual steps below)

### Windows (scripted)

```powershell
git clone https://github.com/Daeliel/pi-client.git
cd pi-client
.\install-on-client.bat
```

The script:

1. `git pull`s the clone
2. Installs the `pi` CLI globally if missing
3. Installs Playwright + browsers globally (needed for web acceptance scenarios)
4. Creates `~/.pi/agent/models.json` from `bootstrap/models.json` **only if you don't have one** — then **edit `baseUrl` and the model ids to match your server**
5. Registers this repo as a Pi package (from your clone's git `origin`, falling back to the local path)
6. Runs `pi update --extensions`

Then start `pi` in any project. Re-run `install-on-client.bat` any time to update. Restart Pi after updating.

### Manual (any platform)

```bash
npm install -g @earendil-works/pi-coding-agent
npm install -g @playwright/test && playwright install

git clone https://github.com/Daeliel/pi-client.git
pi install /path/to/pi-client   # or the git URL

# point Pi at your inference server:
#   copy bootstrap/models.json to ~/.pi/agent/models.json and edit baseUrl/model ids
pi update --extensions
```

### Optional: web research key

Free Brave Search key: <https://api-dashboard.search.brave.com/register>, then in Pi: `/research key YOUR_KEY` (saved to `~/.pi/research.config.json`, never committed).

## Configuration

Every extension reads JSON config in layers (later wins):

```
~/.pi/<name>.config.json          # user-global
<project>/.pi/<name>.config.json  # per project
<project>/<name>.config.json      # legacy project root
```

Copy any `*.config.example.json` from this repo as a starting point: `verify`, `scenarios`, `browser-console`, `anti-loop`, `research`, `release`, `polish`, `expand`, `vision`. Sensible defaults apply when no file exists — the gates are **on by default**.

Frequently used toggles:

- `/anti-loop off` — disable thrash protection (e.g. when driving a big cloud model)
- `/scenarios qa on` — enable the visual-QA screenshot gate (`model` or `human` approve mode)
- `"blocking": false` in `verify`/`scenarios`/`browser-console` config — advisory mode instead of hard gates

## Per-project notes (AGENTS.md)

pi-client's procedures are global; anything specific to one app (dev-server command, port, folder conventions, "do not touch" areas) belongs in that repo's `AGENTS.md` (or `CLAUDE.md`). On first session pi-client creates it from what it can detect (stack, package scripts, dev-server hint) — only true facts, no example text, because small models treat everything in it as fact. Add your rules under **Rules**; [`templates/AGENTS.md.example`](templates/AGENTS.md.example) lists sections worth considering. Keep it short — it's loaded into context every turn.

Each web project also gets `.pi/playwright.config.ts` (auto-scaffolded) — make sure its `webServer.command` and `baseURL` match how the app actually starts, it's the #1 cause of failing captures.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test suites for detectors, gates, scaffolds
```

Repo layout: `extensions/*/index.ts` is each extension's entry point; `extensions/shared/` holds the gate orchestrator, stack detection, and failure classification; `skills/`, `prompts/`, `templates/` are content; `bootstrap/` + `scripts/` are install plumbing.

## Contributing

This project is young and moving fast. Especially welcome:

- **Ternary/Bonsai model reports** — what loops/failure modes do you see? Transcripts are gold.
- New anti-loop detectors (every model family thrashes in its own way)
- Language support for the verifier (Go and Rust configs exist but are lightly tested)
- Non-Windows install scripting
- Better spec-quality heuristics for the scenarios auditor

MIT licensed.
