import { levelAtLeast, type PolishLevel } from "./config";
import type { OpenWeakness, Surface } from "./inventory";

/**
 * System-prompt rails per level. Short and concrete on purpose — small models follow
 * a few numbered rules better than prose. Each level adds to the one below it.
 */
export function buildPolishProcedure(opts: {
  level: PolishLevel;
  passes: number;
  inventoryText: string;
  hasResearchTools: boolean;
  reopened: Surface[];
  /** True when the user asked vaguely ("make it look good") — everything is fair game. */
  vague: boolean;
  /** Surfaces the request is about, when specific. Empty = not known yet. */
  scopeNames: string[];
}): string {
  const { level, passes, inventoryText, hasResearchTools, reopened, vague, scopeNames } = opts;
  if (level === "off") return "";

  const rules: string[] = [
    "Style native controls (buttons, inputs, selects) you create or touch — never ship browser defaults.",
    "Every clickable element you create or touch has hover and focus states.",
    "Nothing half-finished in the UI: no lorem ipsum, no placeholder copy, no visible TODO.",
  ];

  if (levelAtLeast(level, "standard")) {
    rules.push(
      "Before writing new UI, state in one short block: palette (hex), font(s), spacing scale, corner radius, motion rule. Build to it and stay consistent with what already exists.",
      "On the surface you are working on: every list has an empty state, every async action has a loading state, errors are shown, not swallowed.",
      "Visual hierarchy on that surface: one clear primary action; secondary actions look secondary.",
    );
  }

  if (levelAtLeast(level, "showcase")) {
    rules.push(
      hasResearchTools
        ? "Before building a NEW screen, run web_search once for a strong reference (\"<kind of screen> UI design reference\") and say in one line what you borrowed."
        : "Before building a NEW screen, name one real product whose equivalent screen you are using as the reference, and say what you borrowed.",
      "Give the surface you are working on one signature detail (motion, texture, illustration, micro-interaction) — something a template would not have.",
    );
  }

  if (level === "ultimate") {
    rules.push(
      "On the surface you are working on — motion: transitions on state changes (120–250ms), entrance animation, feedback on every press.",
      "On the surface you are working on — responsive: layout holds at 360px, 768px and 1280px widths.",
      "On the surface you are working on — accessibility: visible focus ring, text contrast ≥ 4.5:1, keyboard reachable.",
    );
  }

  rules.push(
    vague
      ? "The user asked for a general visual improvement, so every surface is in scope."
      : "Scope: only the surface(s) the user's request is about. Do NOT restyle screens the user did not mention — a specific request is not permission to redesign the app.",
  );

  const numbered = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");

  const passLine =
    passes === 0
      ? `Level ${level} adds no review passes.`
      : level === "ultimate"
        ? `After verify/scenarios pass, a polish pass names the three weakest things on an in-scope surface and you fix them — up to ${passes} passes per surface, polished ones included.`
        : `After verify/scenarios pass, a polish pass names the three weakest things on an in-scope raw surface and you fix them — up to ${passes} pass${passes === 1 ? "" : "es"} per surface. Polished surfaces are left alone unless the user asks.`;

  const scopeLine =
    !vague && scopeNames.length > 0
      ? `\nIn scope this task: ${scopeNames.map((n) => `"${n}"`).join(", ")}. If your work is on a listed surface not in scope, call polish_surfaces({ action: "focus", name }).`
      : !vague
        ? `\nIf your work is on one of the listed surfaces, call polish_surfaces({ action: "focus", name }) so polish passes target it.`
        : "";

  const reopenedLine =
    reopened.length > 0
      ? `\nThe user asked to improve ${reopened.map((s) => `"${s.name}"`).join(", ")} — reopened for polish passes this task.`
      : "";

  return `## Polish (level: ${level})

${numbered}

${passLine}${scopeLine}${reopenedLine}

### Surfaces (polish inventory)
${inventoryText}
Register new user-facing screens with polish_surfaces({ action: "add", name, urlPath }). define_scenarios registers web flows automatically.
During a polish pass: call polish_report FIRST, then before EACH edit write one line "Fixing: <weakness>" so the user can follow along.
Change level: /polish <level> (session) · /once <level> <prompt> (one prompt).`.trim();
}

/** Shared critic checklist — design quality, not defects (those belong to the QA gate). */
const CRITIC_AREAS = [
  "typography (font choice, sizes, weight contrast, line length)",
  "colour (palette coherence, accent use, contrast, no raw #000/#fff)",
  "spacing and alignment (consistent scale, breathing room, grid)",
  "hierarchy (one obvious primary action, secondary things look secondary)",
  "interactive states (hover, focus, active, disabled visible and consistent)",
  "empty / loading / error states present and designed",
  "finish (icons match, corners consistent, shadows deliberate, nothing default-looking)",
];

function ultimateAreas(level: PolishLevel): string[] {
  if (level !== "ultimate") return [];
  return [
    "motion (transitions on state change, entrance animation, press feedback)",
    "responsiveness (does the layout hold at narrow widths)",
    "accessibility (focus ring visible, contrast, keyboard reachability)",
  ];
}

export interface CriticPromptOptions {
  surface: Surface;
  level: PolishLevel;
  passNumber: number;
  passCap: number;
  hasScreenshot: boolean;
  /** Weaknesses already open on this surface (so the critic can confirm or clear them). */
  priorOpen: OpenWeakness[];
}

/**
 * Prompt for the SESSION model (standard level, or fallback when no critic model is set).
 * Asks for three named weaknesses via polish_report, then fixes.
 */
export function buildSelfCritiquePrompt(o: CriticPromptOptions): string {
  const areas = [...CRITIC_AREAS, ...ultimateAreas(o.level)].map((a) => `- ${a}`).join("\n");
  const shot = o.hasScreenshot
    ? "The current screenshot of this surface is attached."
    : "No screenshot could be captured — open the surface's files and judge from the markup/styles, or capture it yourself with capture_page_screenshot.";
  const prior =
    o.priorOpen.length > 0
      ? `\nPreviously named and not yet confirmed fixed:\n${o.priorOpen.map((w) => `  - ${w.text} (named ${w.namings}x)`).join("\n")}\nIf one is truly fixed now, do not name it again. If it is still weak, name it again — you will be told to change approach.\n`
      : "";

  return `Polish pass ${o.passNumber}/${o.passCap} — surface "${o.surface.name}" (${o.surface.urlPath}), level ${o.level}.

${shot}

Judge it as a designer would judge a shipped product, not as a tester. Look at:
${areas}

Name the THREE weakest things. Each one names the element, what is weak, and what it should be instead. Skip bugs (overlap, clipping, broken layout) — the QA gate owns those.
If it genuinely holds up in every area, report zero weaknesses and say why per area in one line each.
${prior}
Do this in order:
1. Call polish_report({ surface: "${o.surface.name}", weaknesses: ["<element> — <what is weak> — <what it should be>", ...] }) FIRST.
2. Fix each weakness in the code, on THIS surface only. Before each edit write one line: "Fixing: <weakness>". Change the design, not just the words.
3. Finish normally — verify and scenarios run as usual.`;
}

/** Steer appended when the model must fix weaknesses an EXTERNAL critic found. */
export function buildExternalFixPrompt(o: CriticPromptOptions & { weaknesses: OpenWeakness[]; criticModel: string }): string {
  const list = o.weaknesses
    .map((w) => (w.namings > 1 ? `- ${w.text}  ← named ${w.namings}x: your previous fix did not land. Do something DIFFERENT and say what.` : `- ${w.text}`))
    .join("\n");
  return `Polish pass ${o.passNumber}/${o.passCap} — surface "${o.surface.name}" (${o.surface.urlPath}), level ${o.level}.

An independent critic (${o.criticModel}) reviewed the current screenshot and named the weakest things:
${list}

Fix each one in the code, on THIS surface only. Before each edit write one line: "Fixing: <weakness>". Change the design, not just the words. Then finish normally — verify and scenarios run as usual.
Do not call polish_report for this pass; the critic's findings are already recorded.`;
}

/** System + user text for the EXTERNAL critic model. Output is parsed line by line. */
export function buildExternalCriticPrompts(o: CriticPromptOptions): { system: string; user: string } {
  const areas = [...CRITIC_AREAS, ...ultimateAreas(o.level)].map((a) => `- ${a}`).join("\n");
  const prior =
    o.priorOpen.length > 0
      ? `\nA previous review named these; say whether each is fixed or still present:\n${o.priorOpen.map((w) => `- ${w.text}`).join("\n")}\n`
      : "";
  return {
    system:
      "You are a senior product designer reviewing a screenshot of a shipped screen. You are blunt, specific and brief. " +
      "You judge design quality, not functionality. You never praise; you name what is weakest and what it should be instead.",
    user: `Screen: "${o.surface.name}". Target quality: ${o.level === "ultimate" ? "best-in-class, award-level polish" : "a well-designed shipped product"}.

Look at:
${areas}
${prior}
Reply ONLY with lines in this exact form, most important first, at most three:
WEAKNESS: <element> — <what is weak> — <what it should be>

If the screen genuinely holds up everywhere, reply with exactly one line:
NONE: <one sentence why>

Ignore bugs such as overlap, clipping or broken layout. No other text.`,
  };
}

/** Parse the external critic's reply into weakness strings ([] when it said NONE). */
export function parseCriticReply(text: string): { weaknesses: string[]; none: boolean; unparsed: boolean } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const weaknesses: string[] = [];
  let none = false;
  for (const line of lines) {
    const w = /^[-*\s]*WEAKNESS\s*:\s*(.+)$/i.exec(line);
    if (w) {
      weaknesses.push(w[1]!.trim());
      continue;
    }
    if (/^[-*\s]*NONE\s*:/i.test(line)) none = true;
  }
  const unparsed = weaknesses.length === 0 && !none;
  return { weaknesses: weaknesses.slice(0, 3), none, unparsed };
}
