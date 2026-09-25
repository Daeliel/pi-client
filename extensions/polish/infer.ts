import { isPolishLevel, type PolishLevel } from "./config";

/**
 * Per-prompt override: "+showcase build me a snake game" or "polish:showcase build me a snake game"
 * → level showcase, text "build me a snake game". ("!" is taken by pi's user-bash prefix.)
 * Only the first token is considered; unknown words pass through untouched.
 */
export function parseLevelPrefix(text: string): { level: PolishLevel; text: string } | null {
  const m = /^\s*(?:\+|polish:)([a-z]+)\b\s*/i.exec(text);
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  if (!isPolishLevel(word)) return null;
  return { level: word, text: text.slice(m[0].length) };
}

/** Words that mean the prompt is about something the user will look at. */
const UI_WORDS =
  /\b(game|app|ui|ux|page|screen|menu|hud|dashboard|website|site|landing|form|button|modal|dialog|layout|design|style|css|theme|frontend|front-end|component|widget|view|panel|sidebar|navbar|header|footer|animation|responsive|mobile)\b/i;

/** Words that mean maintenance or non-visual work. */
const MAINTENANCE_WORDS =
  /\b(fix|bug|crash|typo|rename|refactor|script|cli|cron|one-?liner|migration|migrate|test|tests|lint|readme|docs?|comment|log|logging|config|dependency|dependencies|upgrade|bump|ci|pipeline|api|endpoint|backend|database|sql|schema|parser|regex)\b/i;

/** Words that ask for visual improvement of something that already exists. */
const VAGUE_IMPROVE_WORDS =
  /\b(better|nicer|improve|improved|polish|polished|refine|prettier|beautiful|beautify|ugly|meh|bland|basic|boring|plain|looks? (off|wrong|bad|weird)|still looks|make it (look|feel)|spruce|spit-?shine|level up|more (modern|professional|fun|lively))\b/i;

export interface InferredLevel {
  level: PolishLevel;
  reason: string;
}

/**
 * Auto mode. Deliberately simple: two word lists plus the stack signal.
 * Anything ambiguous lands on "standard" only when the project clearly has a UI.
 */
export function inferLevel(prompt: string, hasWebUi: boolean): InferredLevel {
  const text = prompt.trim();
  const ui = UI_WORDS.test(text);
  const maintenance = MAINTENANCE_WORDS.test(text);
  const improve = VAGUE_IMPROVE_WORDS.test(text);

  if (ui && improve) return { level: "standard", reason: "asks to improve how something looks" };
  if (ui && !maintenance) return { level: "standard", reason: "prompt is about something user-facing" };
  if (ui && maintenance) return { level: "basic", reason: "UI mentioned, but reads like a fix" };
  if (improve && hasWebUi) return { level: "standard", reason: "asks for visual improvement in a UI project" };
  if (maintenance) return { level: "off", reason: "reads like a fix, script or maintenance task" };
  if (hasWebUi && text.length > 40) return { level: "basic", reason: "UI project, no visual words in the prompt" };
  return { level: "off", reason: "no UI signal in prompt or project" };
}

/** True when the prompt asks for a vague visual improvement (used to reopen polished surfaces). */
export function isVagueImprovePrompt(prompt: string): boolean {
  return VAGUE_IMPROVE_WORDS.test(prompt);
}
