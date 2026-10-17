import { servesOf, type BlueprintItem, type ParsedBlueprint } from "./blueprint";
import type { Point } from "./sources";

/**
 * Reading and Walkthrough — the two parts of the blueprint that keep the big picture:
 *
 *   ## Reading
 *   ### Interpretations
 *   - I-01 (S-08) "pick the next destination" — I read it as: select ONE reachable node; it takes effect at Travel.
 *   ### Additions
 *   - A-01 How the player learns the controls: a one-line hint per stage.
 *
 *   ## Walkthrough
 *   ### M-03 Chart the next leg
 *   - Situation: … - Decision: … - Needs to see: … - Does: … - Feedback: … - Then: … - Turns off: …
 *   ### Forgotten moments
 *   - First launch / orientation: M-01
 */

export const MOMENT_FIELDS = ["Situation", "Decision", "Needs to see", "Does", "Feedback", "Then", "Turns off"] as const;
export type MomentField = (typeof MOMENT_FIELDS)[number];

export interface Moment {
  id: string;
  title: string;
  fields: Partial<Record<MomentField, string>>;
}

export interface Interpretation {
  id: string;
  points: string[];
  text: string;
}

export interface Addition {
  id: string;
  text: string;
}

export interface Experience {
  hasReading: boolean;
  interpretations: Interpretation[];
  additions: Addition[];
  hasWalkthrough: boolean;
  moments: Moment[];
  /** Forgotten-moments checklist: topic (lower case) → answer. */
  forgotten: Map<string, string>;
}

/** What design docs routinely skip; the walkthrough must say where each is, or why not. */
export const FORGOTTEN_MOMENTS = [
  "First launch / orientation",
  "Learning the controls",
  "Waiting / idle",
  "Failure and its feedback",
  "Cancel / undo",
  "End of the loop and starting again",
  "Switching modes or stages",
  "Saving and coming back",
];

function topicKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z]+/g, " ").trim().split(" ").slice(0, 2).join(" ");
}

export function parseExperience(text: string): Experience {
  const exp: Experience = { hasReading: false, interpretations: [], additions: [], hasWalkthrough: false, moments: [], forgotten: new Map() };
  let section = "";
  let sub = "";
  let moment: Moment | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const h2 = raw.match(/^##\s+(.+?)\s*$/);
    if (h2 && !raw.startsWith("###")) {
      section = h2[1]!.toLowerCase();
      sub = "";
      moment = null;
      if (section.startsWith("reading")) exp.hasReading = true;
      if (section.startsWith("walkthrough")) exp.hasWalkthrough = true;
      continue;
    }
    const h3 = raw.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      sub = h3[1]!.toLowerCase();
      moment = null;
      const m = h3[1]!.match(/^(M-\d+)\s+(.+)$/);
      if (section.startsWith("walkthrough") && m) {
        moment = { id: m[1]!, title: m[2]!.trim(), fields: {} };
        exp.moments.push(moment);
      }
      continue;
    }
    const bullet = raw.match(/^\s*[-*]\s+(.+)$/)?.[1];
    if (!bullet) continue;
    if (section.startsWith("reading") && sub.startsWith("interpretation")) {
      const m = bullet.match(/^\*{0,2}(I-\d+)\*{0,2}\s*(?:\(([^)]*)\))?\s*(.*)$/);
      if (m) exp.interpretations.push({ id: m[1]!, points: (m[2] ?? "").match(/S-\d+/g) ?? [], text: m[3]!.trim() });
    } else if (section.startsWith("reading") && sub.startsWith("addition")) {
      const m = bullet.match(/^\*{0,2}(A-\d+)\*{0,2}\s+(.*)$/);
      if (m) exp.additions.push({ id: m[1]!, text: m[2]!.trim() });
    } else if (section.startsWith("walkthrough") && sub.startsWith("forgotten")) {
      const m = bullet.match(/^([^:]+):\s*(.*)$/);
      if (m) exp.forgotten.set(topicKey(m[1]!), m[2]!.trim());
    } else if (moment) {
      const m = bullet.match(/^([A-Za-z ]+?)\s*:\s*(.*)$/);
      const field = m && MOMENT_FIELDS.find((f) => f.toLowerCase() === m[1]!.trim().toLowerCase());
      if (field) moment.fields[field] = m![2]!.trim();
    }
  }
  return exp;
}

/** The item's moment, from `· moment: M-03`. */
export function momentOf(item: BlueprintItem): string | null {
  return item.fields.moment?.match(/M-\d+/)?.[0] ?? null;
}

/** Player-facing: proven by a spec (not verify, not manual). */
function playerFacing(item: BlueprintItem): boolean {
  return Boolean(item.proves) && !/^(verify|manual)$/i.test(item.proves);
}

export function checkExperience(parsed: ParsedBlueprint, exp: Experience, pointIds: Set<string>): string[] {
  const problems: string[] = [];
  const additionIds = new Set(exp.additions.map((a) => a.id));
  for (const it of parsed.items) {
    for (const ref of servesOf(it)) {
      if (/^A-\d+$/.test(ref) && !additionIds.has(ref)) problems.push(`${it.id}: serves ${ref}, but there is no ${ref} under \`## Reading\` → \`### Additions\`.`);
    }
  }
  for (const i of exp.interpretations) {
    for (const s of i.points) if (!pointIds.has(s)) problems.push(`${i.id}: interprets ${s}, which is not in POINTS.md.`);
  }

  if (parsed.bar !== "product") return problems;

  if (!exp.hasReading) {
    problems.push("No `## Reading` — list your Interpretations (where the sources can be read more than one way: `- I-01 (S-08) \"…\" — I read it as: …`) and Additions (what the sources never say: `- A-01 …`).");
  }
  if (!exp.hasWalkthrough || exp.moments.length === 0) {
    problems.push(
      "Product bar: no `## Walkthrough` — the experience, moment by moment (`### M-01 <name>` with Situation, Decision, Needs to see, Does, Feedback, Then, Turns off). Write it before the items: it is how you check that each thing makes sense to the person doing it.",
    );
    return problems;
  }
  const momentIds = new Set(exp.moments.map((m) => m.id));
  for (const m of exp.moments) {
    const missing = MOMENT_FIELDS.filter((f) => !m.fields[f]);
    if (missing.length) problems.push(`${m.id} ${m.title}: missing ${missing.join(", ")} — "Needs to see" is what the player must see to decide; "Turns off" may be "nothing".`);
  }
  const answered = new Set(exp.forgotten.keys());
  const unanswered = FORGOTTEN_MOMENTS.filter((t) => !answered.has(topicKey(t)));
  if (unanswered.length) {
    problems.push(`\`### Forgotten moments\` must answer each (a moment id, or "n/a — why"): ${unanswered.join(" · ")}.`);
  }
  const used = new Set<string>();
  for (const it of parsed.items) {
    const m = momentOf(it);
    if (m) {
      used.add(m);
      if (!momentIds.has(m)) problems.push(`${it.id}: moment ${m} is not in the walkthrough.`);
    } else if (playerFacing(it)) {
      problems.push(`${it.id}: say which moment it belongs to — \`· moment: M-nn\` (product bar).`);
    }
  }
  for (const m of exp.moments) {
    if (!used.has(m.id)) problems.push(`${m.id} ${m.title}: no item builds this moment — add one, or remove the moment.`);
  }
  return problems;
}

/**
 * What the model needs in front of it while building one item: its moment, and the source's
 * own words for every point it serves (with how they were interpreted). Empty when none.
 */
export function itemContext(item: BlueprintItem, exp: Experience, points: Point[]): string {
  const parts: string[] = [];
  const mid = momentOf(item);
  const moment = mid ? exp.moments.find((m) => m.id === mid) : undefined;
  if (moment) {
    const lines = MOMENT_FIELDS.filter((f) => moment.fields[f]).map((f) => `  ${f}: ${moment.fields[f]}`);
    parts.push(`Moment ${moment.id} ${moment.title} — build it so this is what the player experiences:\n${lines.join("\n")}`);
  }
  const served = servesOf(item);
  const quotes = points.filter((p) => served.includes(p.id));
  if (quotes.length) {
    parts.push(`The source's own words (build these, not a paraphrase):\n${quotes.map((p) => `  ${p.id}: "${p.quote}"`).join("\n")}`);
    const readings = exp.interpretations.filter((i) => i.points.some((s) => served.includes(s)));
    if (readings.length) parts.push(`How you read them:\n${readings.map((i) => `  ${i.id}: ${i.text}`).join("\n")}`);
  }
  for (const a of exp.additions.filter((x) => served.includes(x.id))) parts.push(`Addition ${a.id} (not in the sources): ${a.text}`);
  return parts.join("\n\n");
}
