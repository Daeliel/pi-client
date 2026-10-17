import * as fs from "node:fs";
import * as path from "node:path";
import type { ScenariosConfig } from "./config";
import { isScratchSpecFile } from "./housekeeping";
import { detectStacks } from "../shared/stack-detect";

export interface SpecPatternWarning {
  file: string;
  message: string;
  /** When true, a passing run_scenarios should fail the gate. */
  blocking: boolean;
}

const SCROLL_PROOF =
  /scrollCanvas|scrollAndCapture|mouse\.wheel|PageDown|ArrowDown|scrollCanvasWheel|scrollCanvasDrag|keyboard\.press\s*\(\s*['"]PageDown/i;

/** The spec itself says content is off-screen and must be scrolled to. */
const SCROLL_INTENT = /\b(scroll\w*|below(?:[ -]the)?[ -]fold|off.?screen)\b/i;

/**
 * Words for content that often sits below the fold in a scrolling app (Flutter lists,
 * timelines). In a fixed-size canvas game they are just game words ("bottom wall",
 * "delete room"), so alone they only block in a scrolling canvas project.
 */
const BELOW_FOLD_HINT =
  /\b(below|list|timeline|stages|footer|bottom|lower|achievement|achievements|history item|delete|progress tab)\b/i;

const LAYOUT_PROOF_HINT =
  /\b(achievement|layout|position|two per row|fit two|overlap|misalign|scroll down|scrolled)\b/i;

const STORAGE_CHEAT = /localStorage\.(get|set)Item|sessionStorage\.(get|set)Item/;

const DOM_SCROLL_CHEAT = /window\.scroll|document\.scroll|scrollBy\s*\(|scrollTo\s*\(/;

const CANVAS_ONLY_ASSERT =
  /expect\s*\(\s*(?:page\.locator\s*\(\s*['"]canvas|canvas)\s*\)\.toBeVisible\s*\(\s*\)/;

function walkSpecs(dir: string, visit: (abs: string, relFromDir: string) => void): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "helpers" || entry.name === "output") continue;
      walkSpecs(abs, visit);
      continue;
    }
    if (!/\.spec\.ts$/i.test(entry.name)) continue;
    visit(abs, entry.name);
  }
}

/** Spec drives a canvas (Flutter web, games): DOM locators cannot see inside it. */
const CANVAS_SPEC = /canvas|canvas-interaction|mouse\.(?:click|wheel|move|down)/i;

/** Calls that change the page whatever they are called on. */
const EVAL_MUTATING_CALL = /\.click\s*\(|dispatchEvent\s*\(|\.(?:setItem|removeItem)\s*\(|\.focus\s*\(|\.(?:submit|requestSubmit)\s*\(/;

/** Array/collection mutators — a write only when the receiver is page/app state, not a local. */
const EVAL_MUTATOR = /([A-Za-z_$][\w$]*)[\w$.\s]*?\.(?:push|pop|shift|unshift|splice|sort|reverse|fill)\s*\(/g;

/** `lhs op= …` (not `==`, `=>`); lhs is a name or a member/index chain. */
const EVAL_ASSIGN =
  /(^|[^\w$.\s]|\b(?:const|let|var)\s+|\s)([A-Za-z_$][\w$]*(?:\s*(?:\.\s*[\w$]+|\[[^\]]*\]))*)\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|\?\?|&&|\|\|)?=(?![=>])/g;

const EVAL_INCDEC = /(?:([A-Za-z_$][\w$]*)[\w$.\[\]]*\s*(?:\+\+|--))|(?:(?:\+\+|--)\s*([A-Za-z_$][\w$]*))/g;

/** Blank out string and template literal contents so words in them are not code. */
function stripStrings(code: string): string {
  return code.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (s) => s[0] + s[0]);
}

/** Names the evaluate body declares itself (const/let/var, arrow params): local bookkeeping. */
function localNames(body: string): Set<string> {
  const names = new Set<string>();
  const add = (list: string | undefined) => {
    for (const n of list?.match(/[A-Za-z_$][\w$]*/g) ?? []) names.add(n);
  };
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([^=;]+?)\s*(?:=|\bof\b|\bin\b)/g)) add(m[1]);
  add((body.match(/^\s*(?:async\s*)?\(([^)]*)\)\s*=>/) ?? body.match(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/))?.[1]);
  add(body.match(/^\s*(?:async\s+)?function\s*[\w$]*\s*\(([^)]*)\)/)?.[1]);
  return names;
}

/**
 * Locals the body creates itself (`= []`, `= {}`, `= new …`, a literal). Changing their
 * properties is bookkeeping; changing properties of a local that *aliases* page state
 * (`const g = window.__game; g.stage = …`) is a write.
 */
function freshLocals(body: string): Set<string> {
  const names = new Set<string>();
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(\[|\{|new\s|["'`\d-])/g)) names.add(m[1]!);
  return names;
}

/**
 * True when a page.evaluate body changes the page or app state (assigns to globals or
 * DOM/app properties, clicks, dispatches, stores, mutates app arrays). Reading — even
 * with local variables and helper arrays — is fine.
 */
export function evaluateWrites(rawBody: string): boolean {
  const body = stripStrings(rawBody);
  if (EVAL_MUTATING_CALL.test(body)) return true;
  const locals = localNames(body);
  const fresh = freshLocals(body);
  // A bare local may be reassigned; a member of one only if the body created it.
  const allowed = (target: string) => {
    const root = target.match(/^[A-Za-z_$][\w$]*/)![0];
    return /^[A-Za-z_$][\w$]*$/.test(target.trim()) ? locals.has(root) : fresh.has(root);
  };
  for (const m of body.matchAll(EVAL_ASSIGN)) {
    if (/\b(?:const|let|var)\s+$/.test(m[1]!)) continue; // a declaration
    if (!allowed(m[2]!)) return true;
  }
  for (const m of body.matchAll(EVAL_INCDEC)) {
    const target = m[0].replace(/\+\+|--/g, "").trim();
    if (!allowed(target)) return true;
  }
  for (const m of body.matchAll(EVAL_MUTATOR)) {
    if (!fresh.has(m[1]!)) return true;
  }
  return false;
}

/** Bodies of every page.evaluate(...) call (paren-matched, strings ignored). */
export function evaluateBodies(text: string): string[] {
  const bodies: string[] = [];
  const re = /page\.evaluate\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    let quote: string | null = null;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i]!;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    bodies.push(text.slice(m.index + m[0].length, i - 1));
  }
  return bodies;
}

// ---------- back doors: calling the app's own functions instead of using its UI ----------

/** First words that make an app function an action the user would do in the UI. */
const ACTION_VERBS = new Set(
  (
    "go goto set add remove delete del launch commit fold decouple couple step chart place undo redo " +
    "start stop apply trigger fire move build buy sell equip unequip use select choose pick toggle open close " +
    "submit create update edit rebuild new skip advance jump teleport force win lose kill damage heal give grant " +
    "unlock complete finish play enter exit leave drop collect craft attack cast send save load login logout " +
    "register checkout pay purchase confirm accept reject approve cancel dismiss navigate visit spend install " +
    "uninstall burn repair arrive depart fly hit begin invest upgrade downgrade clear repel record end mount " +
    "unmount dismantle offer assign hire fire eat drink rest sleep wake board land dock undock attach detach " +
    "rename sort reorder import export upload download share invite join quit"
  ).split(" "),
);

/** Leading words that namespace an action: prepPlaceRoom, uiClickButton, debugSetStage. */
const NAMESPACE_WORDS = new Set(["prep", "ui", "dev", "debug", "test", "game", "app", "player", "admin", "do", "cmd"]);

/** Verbs that only count after a namespace word (alone they are usually nouns: linkBonuses, overdriveState). */
const NAMESPACED_VERBS = new Set(["link", "unlink", "overdrive", "depart"]);

/** Trailing words that make a name a lookup: linkBonusFor, levelOf, moraleOf. */
const LOOKUP_TAIL = new Set(["for", "of", "by", "at", "in", "on"]);

/**
 * Test hooks that set conditions rather than perform the user's actions — allowed even in
 * a journey: a fixed seed, slowed time, invincibility, feature flags, a fresh start, an
 * enemy to test against. They make a scripted run deterministic; they do not skip the flow.
 */
const CONDITION_CALL =
  /^(?:(?:set|enable|disable|toggle|use|with|freeze|unfreeze|pause|resume)[_A-Z]?)?(?:seed|rng|random|time|timescale|speed|clock|now|feature|features|flag|flags|godmode|invincib|immortal|cheat|difficulty)|^(?:reset|spawn|mock|stub|seed)|^(?:step|tick|advance(?:Time|Clock|Frames?)?|fastForward|skipTime)$/i;

/** Waits longer than these are usually waiting for game time to pass — a time hook does it in a blink. */
const LONG_SLEEP_MS = 2000;
const LONG_POLL_MS = 8000;
const LONG_TEST_MS = 60_000;

function msValue(text: string): number {
  return Number(text.replace(/_/g, ""));
}

/** The longest sleep, poll/wait timeout and per-test timeout in a spec. */
export function longestWaits(text: string): { sleep: number; poll: number; test: number } {
  const max = (re: RegExp) => Math.max(0, ...[...text.matchAll(re)].map((m) => msValue(m[1]!)));
  return {
    sleep: max(/waitForTimeout\s*\(\s*([\d_]+)/g),
    poll: max(/\btimeout\s*:\s*([\d_]+)/g),
    test: Math.max(max(/test\.setTimeout\s*\(\s*([\d_]+)/g), max(/configure\s*\(\s*\{[^}]*timeout\s*:\s*([\d_]+)/g)),
  };
}

/** DOM/browser functions reachable through window — not the app's own surface. */
const BROWSER_FUNCS = /^(?:getComputedStyle|requestAnimationFrame|cancelAnimationFrame|setTimeout|setInterval|clearTimeout|clearInterval|matchMedia|getSelection|fetch|atob|btoa|structuredClone|queueMicrotask|alert|confirm|prompt|open|close|focus|blur|print|postMessage|scroll\w*|dispatchEvent|addEventListener|removeEventListener)$/;

export type AppCallKind = "read" | "condition" | "action";

function camelWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_$]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function classifyAppCall(name: string): AppCallKind {
  if (CONDITION_CALL.test(name)) return "condition";
  const words = camelWords(name);
  if (words.length > 1 && LOOKUP_TAIL.has(words[words.length - 1]!)) return "read";
  if (ACTION_VERBS.has(words[0]!)) return "action";
  if (words.length > 1 && NAMESPACE_WORDS.has(words[0]!) && (ACTION_VERBS.has(words[1]!) || NAMESPACED_VERBS.has(words[1]!))) return "action";
  return "read";
}

/** Calls to the app's own functions inside page.evaluate bodies: window.__game.chartTo(…), __app.save(). */
export function appCalls(text: string): Array<{ name: string; kind: AppCallKind }> {
  const out: Array<{ name: string; kind: AppCallKind }> = [];
  for (const raw of evaluateBodies(text)) {
    const body = stripStrings(raw);
    const re = /\b(?:(?:window|globalThis|self)\s*\.\s*([\w$]+(?:\s*\.\s*[\w$]+)*)|(__[\w$]+(?:\s*\.\s*[\w$]+)*))\s*\(/g;
    for (const m of body.matchAll(re)) {
      const chain = (m[1] ?? m[2]!).replace(/\s+/g, "");
      const name = chain.split(".").pop()!;
      if (!m[2] && chain.split(".").length === 1 && BROWSER_FUNCS.test(name)) continue; // window.getComputedStyle(…)
      out.push({ name, kind: classifyAppCall(name) });
    }
  }
  return out;
}

/** Real user input outside page.evaluate: clicks, keys, typing, taps, drags. */
const REAL_INPUT =
  /page\.(?:mouse|keyboard|touchscreen)\.\w+\s*\(|\.(?:click|dblclick|fill|press|pressSequentially|type|check|uncheck|selectOption|tap|dragTo|hover|setInputFiles)\s*\(/g;

export function realInputCount(text: string): number {
  let rest = text;
  for (const body of evaluateBodies(text)) rest = rest.replace(body, "");
  return (rest.match(REAL_INPUT) ?? []).length;
}

/** A @journey spec: the main thing a user comes to do, start to finish, through real input. */
export function isJourneySpec(text: string): boolean {
  return /test(?:\.\w+)?\s*\(\s*["'`][^"'`]*@journey\b/.test(text);
}

export interface SpecScanOptions {
  /** Project renders its UI into a canvas (e.g. Flutter web): apply canvas rules to every spec. */
  canvasProject?: boolean;
}

/**
 * Scan one spec file's source for weak/forbidden proof patterns.
 *
 * Canvas rules (scroll helpers, "canvas visible is not proof") only apply to canvas
 * specs or canvas projects — on a normal DOM page, words like "list" or "delete"
 * and window.scrollTo are fine, and demanding canvas helpers there sends a small
 * model down the wrong path.
 */
export function scanSpecFileContent(rel: string, text: string, options: SpecScanOptions = {}): SpecPatternWarning[] {
  const warnings: SpecPatternWarning[] = [];
  const canvas = Boolean(options.canvasProject) || CANVAS_SPEC.test(text);
  const scrollIntent = SCROLL_INTENT.test(text);
  const mentionsBelow = BELOW_FOLD_HINT.test(text);
  const layoutSpec = LAYOUT_PROOF_HINT.test(text);
  const hasScroll = SCROLL_PROOF.test(text);
  const screenshotCount = (text.match(/screenshotStep|page\.screenshot/g) ?? []).length;
  const usesCanvasHelper = /canvas-interaction/.test(text);

  if (STORAGE_CHEAT.test(text)) {
    warnings.push({
      file: rel,
      blocking: true,
      message: "Uses localStorage/sessionStorage — not valid UI proof; drive the UI and assert on the named screen.",
    });
  }

  const evalBodies = evaluateBodies(text);
  if (evalBodies.some(evaluateWrites)) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "page.evaluate changes the page (assigns, clicks, dispatches or stores) — that skips the user flow. " +
        "Use real clicks/typing instead. Reading values with page.evaluate is fine.",
    });
  }

  // Back doors: the app's own action functions instead of its UI. Setup through test hooks
  // (seed, time, flags, spawn) is fine; performing the user's actions that way is not.
  const calls = appCalls(text);
  const actions = [...new Set(calls.filter((c) => c.kind === "action").map((c) => `${c.name}()`))];
  if (isJourneySpec(text) && actions.length > 0) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        `@journey spec performs user actions through the app's own functions (${actions.slice(0, 5).join(", ")}) — ` +
        "a journey must reach every step with real input (clicks, keys, typing). Test hooks may only set conditions: seed, time scale, flags, spawn, reset.",
    });
  } else if (actions.length > 0 && realInputCount(text) === 0) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        `Spec drives the app only through its own functions (${actions.slice(0, 5).join(", ")}) and never uses its UI — ` +
        "it proves the logic, not that a person can do it. Do the user's actions with real clicks/keys; keep hooks for setup (seed, flags, spawn) and reads.",
    });
  }

  // Long waits mean the spec waits for the app's own time to pass. Not wrong, but slow and
  // flaky under load: a time-scale or step hook (a condition, allowed everywhere) does it fast.
  const waits = longestWaits(text);
  const long = [
    waits.sleep > LONG_SLEEP_MS ? `sleeps ${waits.sleep / 1000}s` : "",
    waits.poll > LONG_POLL_MS && waits.test <= LONG_TEST_MS ? `waits up to ${waits.poll / 1000}s` : "",
    waits.test > LONG_TEST_MS ? `allows ${waits.test / 1000}s per test` : "",
  ].filter(Boolean);
  if (long.length) {
    warnings.push({
      file: rel,
      blocking: false,
      message:
        `Spec ${long.join(", ")} — probably waiting for game/app time to pass. Add a time hook to the app's test surface ` +
        "(e.g. window.__game.setTimeScale(8) or step(seconds)) and use it instead: same proof, a fraction of the time, and no timing flakes.",
    });
  }

  if (!canvas) return warnings;

  // Only when scrolling can matter: the spec says so, or the project is a scrolling canvas
  // app (Flutter). On a fixed-size canvas game, words like "list" or "bottom" are game
  // words — a hint there fires on every spec and can never be satisfied.
  if ((scrollIntent || (mentionsBelow && options.canvasProject)) && !hasScroll) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "Canvas spec mentions below-fold content but never scrolls — import scrollAndCapture or scrollCanvasWheel/scrollCanvasDrag from ./helpers/canvas-interaction (in THIS project, not pi-client templates).",
    });
  }

  if (DOM_SCROLL_CHEAT.test(text)) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "Uses DOM window/document scroll — does not scroll a canvas. Use ./helpers/canvas-interaction instead.",
    });
  }

  if (layoutSpec && CANVAS_ONLY_ASSERT.test(text) && screenshotCount < 2) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "Layout spec only asserts canvas visible — need before+after screenshots (scrollAndCapture) and vision review; canvas.toBeVisible() is not proof.",
    });
  }

  if (layoutSpec && hasScroll && screenshotCount < 2 && !/scrollAndCapture/.test(text)) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "Layout spec scrolls once with one screenshot — use scrollAndCapture(beforePath, afterPath) with wheel + drag fallback; compare JPGs.",
    });
  }

  if (layoutSpec && !usesCanvasHelper && hasScroll && /mouse\.wheel/.test(text)) {
    warnings.push({
      file: rel,
      blocking: false,
      message: "Prefer ./helpers/canvas-interaction over raw page.mouse.wheel for Flutter canvas scroll.",
    });
  }

  return warnings;
}

export function scanSpecPatterns(cwd: string, config: ScenariosConfig): SpecPatternWarning[] {
  const scenariosRoot = path.join(cwd, config.scenariosDir);
  const warnings: SpecPatternWarning[] = [];
  const canvasProject = detectStacks(cwd).stacks.includes("flutter");

  walkSpecs(scenariosRoot, (abs, name) => {
    if (isScratchSpecFile(name)) return;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      return;
    }
    const rel = path.relative(cwd, abs).replace(/\\/g, "/");
    warnings.push(...scanSpecFileContent(rel, text, { canvasProject }));
  });

  return warnings;
}

/** Spec files (repo-relative) with a @journey test. */
export function findJourneySpecs(cwd: string, config: ScenariosConfig): string[] {
  const out: string[] = [];
  walkSpecs(path.join(cwd, config.scenariosDir), (abs, name) => {
    if (isScratchSpecFile(name)) return;
    try {
      if (isJourneySpec(fs.readFileSync(abs, "utf8"))) out.push(path.relative(cwd, abs).split(path.sep).join("/"));
    } catch {
      /* unreadable: not a journey */
    }
  });
  return out;
}

export function formatSpecPatternWarnings(warnings: SpecPatternWarning[]): string[] {
  if (warnings.length === 0) return [];
  const lines = ["WEAK SPEC PATTERNS (fix before trusting pass):"];
  for (const w of warnings) {
    const tag = w.blocking ? "BLOCKING" : "hint";
    lines.push(`  - [${tag}] ${w.file}`);
    lines.push(`    ${w.message}`);
  }
  lines.push("  → Helpers: .pi/scenarios/helpers/canvas-interaction.ts in THIS repo");
  lines.push("  → scrollAndCapture(page, { beforePath, afterPath, wheelDy, dragDy })");
  return lines;
}

export function hasBlockingSpecWarnings(warnings: SpecPatternWarning[]): boolean {
  return warnings.some((w) => w.blocking);
}
