import { AXIS_DESCRIPTIONS, EXPAND_AXES, type ExpandAxis } from "./config";
import { formatMap, type Idea, type Ledger } from "./ledger";

/**
 * Prompts for the three /expand phases (map → ideas → build) and the fit critique.
 *
 * The one rule that keeps ideas from being generic: every idea must name the existing
 * system it builds on and the gap it fills. "Add a shop" is refused; "poison has no
 * counterplay item → antidote gear in the consumables pool" is accepted.
 */

function pillarsBlock(ledger: Ledger): string {
  if (ledger.pillars.length === 0) return "Design pillars: none set. (The user can set them with /expand pillars <a; b; c>. Infer the intent from the code and say so.)";
  return `Design pillars — everything must serve these, ideas that strain one are dropped:\n${ledger.pillars.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}`;
}

function axisBlock(axes: ExpandAxis[]): string {
  return axes.map((a) => `- ${a}: ${AXIS_DESCRIPTIONS[a]}`).join("\n");
}

// ---------- map ----------

export function buildMapPrompt(ledger: Ledger): string {
  const prior = ledger.map ? `\nThere is an existing map; produce a fresh, complete one (it will be replaced):\n${formatMap(ledger.map)}\n` : "";
  return `Map what this project IS, so later feature ideas can build on what exists instead of being generic.

Read the code (entry points, data files, content tables, core loops). Do not change anything. Then call expand_map ONCE with:
- systems: the moving parts (combat, inventory, progression, save/load, editor, billing...). kind "system".
- pools: content collections with a count (weapons ×12, classes ×3, levels ×5, templates ×8). kind "pool".
- interactions: pairs that already affect each other, one line each (status effects ↔ gear: "gear can grant resistance").
- gaps: asymmetries and dead ends you noticed. Be concrete: "3 classes, only Mage has a unique resource", "12 weapons, 0 ranged", "burn and freeze exist but never interact", "levels 1–5 share one enemy pool". Aim for 5–10 gaps.
${prior}
Finish with a 5-line plain-English summary of the map. No feature ideas yet.`;
}

// ---------- ideas ----------

export interface IdeasPromptOptions {
  ledger: Ledger;
  axes: ExpandAxis[];
  /** Free text from the user narrowing the search ("something for the combat", "early game is boring"). */
  focus: string;
  count: number;
  /** When set, the tool auto-picks this many and the model must build them in the same turn. */
  autoBudget: number | null;
}

export function buildIdeasPrompt(o: IdeasPromptOptions): string {
  const { ledger } = o;
  const rejected = ledger.ideas.filter((i) => i.status === "rejected");
  const done = ledger.ideas.filter((i) => i.status === "done");
  const open = ledger.ideas.filter((i) => i.status === "proposed" || i.status === "picked" || i.status === "building");

  const mapStep = ledger.map
    ? `Systems map (what exists):\n${formatMap(ledger.map)}`
    : "There is no systems map yet. FIRST read the code and call expand_map (systems, pools with counts, interactions, gaps). THEN continue below.";

  const memory = [
    rejected.length > 0 ? `Rejected before — do not propose these or close variants:\n${rejected.map((i) => `  - ${i.title}`).join("\n")}` : "",
    done.length > 0 ? `Already built:\n${done.map((i) => `  - ${i.title}`).join("\n")}` : "",
    open.length > 0 ? `Already on the table (do not repeat):\n${open.map((i) => `  - #${i.n} ${i.title}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const deeperRule = o.axes.includes("deeper")
    ? '\n- For "deeper": each idea must CROSS two existing systems/pools from the map (status effects × gear, classes × levels). Name both.'
    : "";

  const auto =
    o.autoBudget !== null
      ? `\nAUTO MODE: after expand_propose returns, it will tell you which ${o.autoBudget} idea(s) were picked. Build those in this same turn following the instructions the tool gives you. Do not ask the user.`
      : "\nThen STOP. Write no code. End with the numbered list and the line: Pick with /expand build <n> [<n> ...] · reject with /expand reject <n> · or /expand auto <n>.";

  return `Find ${o.count} ways to take this project further. This is gap analysis, not brainstorming.

${mapStep}

${pillarsBlock(ledger)}
${memory ? `\n${memory}\n` : ""}
Axes to cover (spread ideas across them):
${axisBlock(o.axes)}
${o.focus ? `\nUser focus: "${o.focus}". Every idea must serve this.` : ""}

Rules:
- Every idea names an existing system or pool from the map that it builds on, and the gap it fills. Ideas that don't are refused by the tool.
- Prefer ideas that make existing things matter more over ideas that add a parallel thing.
- Say how the user/player will see or reach it (playerFacing). Unreachable features are not features.
- Size honestly: S = an hour, M = an afternoon, L = a day or more.
- Fit: high = serves a pillar directly; medium = neutral; low = strains one (say which).${deeperRule}
- No generic genre staples ("add a shop", "add achievements", "dark mode") unless the map shows a specific gap they close.

Call expand_propose ONCE with all ideas.${auto}`;
}

// ---------- build ----------

export function buildBuildPrompt(ideas: Idea[], ledger: Ledger): string {
  const list = ideas
    .map(
      (i) =>
        `#${i.n} ${i.title} [${i.axis}/${i.size}]\n   builds on: ${i.buildsOn.join(", ")}\n   gap: ${i.gap}\n   player-facing: ${i.playerFacing || "(decide and state it)"}`,
    )
    .join("\n");
  return `Build the following ${ideas.length === 1 ? "idea" : `${ideas.length} ideas`}, one at a time, in order:

${list}

${pillarsBlock(ledger)}

For EACH idea:
1. Write a mini-spec first (5 lines max): what changes, 3–5 acceptance criteria, which existing systems it touches. Print it.
2. If it is user-visible, register it with define_scenarios (a scenario per acceptance path) so it is tested like everything else.
3. Implement it so it INTERACTS with the systems it builds on — not a parallel feature bolted on the side.
4. Make it reachable and explained: the user must be able to find it and understand it in the UI without reading code (label, tooltip, tutorial line, help text — whatever fits).
5. Do not refactor or restyle things the idea does not touch.

When all are implemented, call expand_map with merge: true so pool counts and new interactions are recorded. Then finish normally — verify and scenarios run as usual, and a fit check follows.`;
}

// ---------- system prompt block ----------

export interface ModeProcedureOptions {
  ledger: Ledger;
  mode: "ideas" | "build";
  axes?: ExpandAxis[];
  focus?: string;
  building?: Idea[];
}

/** Injected into the system prompt while an expand task is active (incl. /once <axis> prompts). */
export function buildExpandProcedure(o: ModeProcedureOptions): string {
  const { ledger } = o;
  if (o.mode === "ideas") {
    return `## Expand — ideas mode (axes: ${(o.axes ?? EXPAND_AXES).join(", ")})
You are looking for ways to take this project further. Ideas must build on an existing system from the map and fill a named gap; propose them with expand_propose; write no code unless the tool tells you ideas were auto-picked.${o.focus ? `\nUser focus: "${o.focus}".` : ""}
${pillarsBlock(ledger)}
Systems map:
${formatMap(ledger.map)}`.trim();
  }
  const building = o.building ?? [];
  return `## Expand — building ${building.map((i) => `#${i.n} "${i.title}"`).join(", ")}
Each must interact with the systems it builds on, be reachable and explained in the UI, and leave untouched things untouched.
${pillarsBlock(ledger)}
When a fit check asks for findings, call expand_fit FIRST, then before EACH edit write one line "Fixing: <finding>".`.trim();
}

// ---------- fit critique ----------

export const FIT_QUESTIONS = [
  "Reachable: can the user actually get to it from the normal flow? Is it wired in, not just defined?",
  "Explained: does the UI tell the user it exists and how it works (label, tooltip, tutorial, help)?",
  "Integrated: does it change how at least one existing system plays, or is it a parallel thing bolted on?",
  "Sane: are numbers/limits plausible next to what exists (a new weapon that outclasses all 12 others is a bug)?",
  "Pillars: does it serve the pillars, or quietly pull the project toward something else?",
];

export function buildSelfFitPrompt(ideas: Idea[], ledger: Ledger, passNumber: number, passCap: number): string {
  const names = ideas.map((i) => `#${i.n} "${i.title}"`).join(", ");
  return `Fit check ${passNumber}/${passCap} for ${names}.

Look at what you just built and answer, honestly and specifically, against these questions:
${FIT_QUESTIONS.map((q) => `- ${q}`).join("\n")}
${pillarsBlock(ledger)}

Do this in order:
1. Call expand_fit({ idea: <n>, findings: ["<question> — <what is off> — <what to do>", ...] }) for EACH idea, at most three findings per idea, empty list if it genuinely holds up.
2. Fix each finding in the code. Before each edit write one line: "Fixing: <finding>".
3. Finish normally — verify and scenarios run as usual.`;
}

export interface ExternalFitOptions {
  idea: Idea;
  ledger: Ledger;
  files: Array<{ path: string; content: string }>;
}

export function buildExternalFitPrompts(o: ExternalFitOptions): { system: string; user: string } {
  const { idea, ledger } = o;
  const code = o.files.map((f) => `--- ${f.path}\n${f.content}`).join("\n\n");
  return {
    system:
      "You are a senior game/product designer reviewing a feature another engineer just added to an existing project. " +
      "You judge fit, not code style: is it reachable, explained, integrated with what exists, sane, and true to the pillars. " +
      "You are blunt, specific and brief. You never praise.",
    user: `Feature #${idea.n}: "${idea.title}" (${idea.axis}). Builds on: ${idea.buildsOn.join(", ")}. Gap it should fill: ${idea.gap}. Player-facing: ${idea.playerFacing || "(unspecified)"}.

${pillarsBlock(ledger)}

Systems map:
${formatMap(ledger.map)}

Questions:
${FIT_QUESTIONS.map((q) => `- ${q}`).join("\n")}

Changed files:
${code || "(no file contents available)"}

Reply ONLY with lines in this exact form, most important first, at most three:
FINDING: <question> — <what is off> — <what to do>

If it genuinely fits on every question, reply with exactly one line:
NONE: <one sentence why>

No other text.`,
  };
}

export function parseFitReply(text: string): { findings: string[]; none: boolean; unparsed: boolean } {
  const findings: string[] = [];
  let none = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const f = /^[-*\s]*FINDING\s*:\s*(.+)$/i.exec(line);
    if (f) {
      findings.push(f[1]!.trim());
      continue;
    }
    if (/^[-*\s]*NONE\s*:/i.test(line)) none = true;
  }
  return { findings: findings.slice(0, 3), none, unparsed: findings.length === 0 && !none };
}

export function buildExternalFixPrompt(idea: Idea, findings: string[], critic: string, passNumber: number, passCap: number): string {
  return `Fit check ${passNumber}/${passCap} for #${idea.n} "${idea.title}" — an independent reviewer (${critic}) read the changed files and found:
${findings.map((f, i) => `${i + 1}. ${f}`).join("\n")}

Fix each one in the code. Before each edit write one line: "Fixing: <finding>". Then finish normally — verify and scenarios run as usual.
Do not call expand_fit for this pass; the findings are already recorded.`;
}
