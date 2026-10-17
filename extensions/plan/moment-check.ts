import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readBlueprint, servesOf, type BlueprintItem } from "./blueprint";
import type { PlanConfig } from "./config";
import { readPoints, type Point } from "./sources";
import { momentOf, parseExperience, type Experience, type Moment } from "./walkthrough";
import { runCriticCompletion } from "../polish/critic";
import { loadVisionRelayConfig, pickRelayModel, sessionSeesImages } from "../shared/vision-relay";
import { loadVisionImages } from "../scenarios/vision";
import { loadConfig as loadScenariosConfig } from "../scenarios/config";

/**
 * Moment checks — when every item of a moment is built, check the moment as a whole:
 *  1. narrate: the model says what the code now does at this moment, next to the
 *     moment's fields and the source's words — mismatches of meaning surface here;
 *  2. screen: a separate request that sees ONLY a screenshot answers questions made from
 *     the moment's fields (without their answers) — missing information surfaces here.
 * Records live in checks.json beside the blueprint; a moment is checked again when the
 * set of its items changes (an item added or reopened).
 */

interface CheckRecord {
  /** Item ids complete when the check ran. */
  items: string[];
  at: string;
  /** asked = the check was requested; done = moment_check reported. */
  state: "asked" | "done";
  differences?: number;
  screen?: "answered" | "no screenshot" | "no vision model";
}

type Checks = Record<string, CheckRecord>;

function checksPath(cwd: string, config: PlanConfig): string {
  return path.resolve(cwd, path.dirname(config.blueprintPath), "checks.json");
}

export function readChecks(cwd: string, config: PlanConfig): Checks {
  try {
    return JSON.parse(fs.readFileSync(checksPath(cwd, config), "utf8")) as Checks;
  } catch {
    return {};
  }
}

function writeChecks(cwd: string, config: PlanConfig, checks: Checks): void {
  const file = checksPath(cwd, config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(checks, null, 2)}\n`, "utf8");
}

function itemsOf(items: BlueprintItem[], momentId: string): BlueprintItem[] {
  return items.filter((i) => momentOf(i) === momentId);
}

function sameItems(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/** Moments whose items are all done and that were not checked with exactly these items. */
export function pendingMoments(cwd: string, config: PlanConfig): Moment[] {
  const bp = readBlueprint(cwd, config.blueprintPath);
  if (!bp) return [];
  const checks = readChecks(cwd, config);
  return parseExperience(bp.text).moments.filter((m) => {
    const mine = itemsOf(bp.parsed.items, m.id);
    if (mine.length === 0 || mine.some((i) => i.mark !== "x")) return false;
    const rec = checks[m.id];
    return !rec || !sameItems(rec.items, mine.map((i) => i.id));
  });
}

/** Note that a check was asked for, so an unanswered request is not repeated forever. */
export function markAsked(cwd: string, config: PlanConfig, momentId: string): void {
  const bp = readBlueprint(cwd, config.blueprintPath);
  if (!bp) return;
  const checks = readChecks(cwd, config);
  checks[momentId] = { items: itemsOf(bp.parsed.items, momentId).map((i) => i.id), at: new Date().toISOString(), state: "asked" };
  writeChecks(cwd, config, checks);
}

/** Questions from the moment's fields — what to look for, never the answer. */
export function screenQuestions(m: Moment): string[] {
  const qs: string[] = [];
  if (m.fields.Decision) qs.push("What is the person deciding or choosing on this screen?");
  const needs = (m.fields["Needs to see"] ?? "")
    .split(/[;,]|\band\b/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  for (const n of needs.slice(0, 5)) qs.push(`Can you see ${n.replace(/^(the|a|an)\s+/i, "the ")}? If yes, where and what does it show? If not, say "cannot tell".`);
  if (m.fields.Does) qs.push("What would the person do here — which control or input?");
  if (m.fields.Feedback) qs.push("Is there anything on screen showing that their last action worked? What?");
  if (m.fields.Then) qs.push("What do you expect to happen next, and when?");
  return qs;
}

/** The request sent to the model when a moment's items are all built. */
export function buildMomentCheckPrompt(m: Moment, items: BlueprintItem[], exp: Experience, points: Point[]): string {
  const fields = Object.entries(m.fields)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  const served = new Set(items.flatMap(servesOf));
  const quotes = points.filter((p) => served.has(p.id));
  const readings = exp.interpretations.filter((i) => i.points.some((s) => served.has(s)));
  return `MOMENT CHECK ${m.id} ${m.title} — all its items are built (${items.map((i) => i.id).join(", ")}). Check the moment as a whole, as the person experiences it:

${m.id} as planned:
${fields}
${quotes.length ? `\nThe source's own words:\n${quotes.map((p) => `  ${p.id}: "${p.quote}"`).join("\n")}` : ""}${readings.length ? `\nHow you read them:\n${readings.map((i) => `  ${i.id}: ${i.text}`).join("\n")}` : ""}

1. Narrate this moment from the code as it is now — what is on screen, and what happens when the person does each thing (name the file and function). Not from memory of what you meant to build.
2. List every difference between that narration and the plan above (fields and source words). "Clicking selects one node" vs "clicking moves the train now" is a difference.
3. Take a screenshot of this moment as the person sees it (play to reach it, or a spec that saves one) — a separate look that sees only that image will answer questions about it.
4. Call moment_check with the moment, your narration, the differences, and the screenshot path.`;
}

/**
 * The fresh look: a separate request with only the screenshot and the questions. The
 * session model when it sees images, else the vision-relay model; null when nothing can.
 */
export async function screenCheck(ctx: ExtensionContext, screenshot: string, m: Moment): Promise<{ answers: string } | { skipped: string }> {
  const abs = path.resolve(ctx.cwd, screenshot);
  if (!fs.existsSync(abs)) return { skipped: `no such screenshot: ${screenshot}` };
  const { images } = await loadVisionImages([abs], loadScenariosConfig(ctx.cwd));
  if (images.length === 0) return { skipped: "the screenshot could not be loaded" };
  const model = sessionSeesImages(ctx) ? ctx.model : pickRelayModel(ctx, loadVisionRelayConfig(ctx.cwd).relayModel).model;
  if (!model) return { skipped: "no model here can see images (set one with /vision model)" };
  const questions = screenQuestions(m);
  const reply = await runCriticCompletion(
    ctx,
    model,
    "You see a screenshot of an app or game for the first time. Answer only from what is visible in it. When something is not visible, answer \"cannot tell\" — do not guess what the app probably does.",
    `Answer each question in one line, numbered:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
    images,
    ctx.signal,
  );
  if (!reply.ok) return { skipped: `the screen check failed: ${reply.error ?? "no answer"}` };
  return { answers: questions.map((q, i) => `Q${i + 1} ${q}`).join("\n") + `\n\nAnswers (seeing only the screen):\n${reply.text.trim()}` };
}

export function recordCheck(cwd: string, config: PlanConfig, momentId: string, differences: number, screen: CheckRecord["screen"]): void {
  const bp = readBlueprint(cwd, config.blueprintPath);
  if (!bp) return;
  const checks = readChecks(cwd, config);
  checks[momentId] = {
    items: itemsOf(bp.parsed.items, momentId).map((i) => i.id),
    at: new Date().toISOString(),
    state: "done",
    differences,
    screen,
  };
  writeChecks(cwd, config, checks);
}

/** For the check prompt: the moment, its items and the context they need. */
export function momentContext(cwd: string, config: PlanConfig, momentId: string): { moment: Moment; items: BlueprintItem[]; exp: Experience; points: Point[] } | null {
  const bp = readBlueprint(cwd, config.blueprintPath);
  if (!bp) return null;
  const exp = parseExperience(bp.text);
  const moment = exp.moments.find((m) => m.id === momentId);
  if (!moment) return null;
  return { moment, items: itemsOf(bp.parsed.items, momentId), exp, points: readPoints(cwd, config.blueprintPath)?.points ?? [] };
}
