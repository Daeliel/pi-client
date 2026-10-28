import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, persistProjectConfig, type AutopilotConfig, type AutopilotScope } from "./config";
import {
  formatSummary,
  inScope,
  readBlueprint,
  setMark,
  tierCounts,
  writeBlueprint,
  type BlueprintItem,
  type Mark,
} from "../plan/blueprint";
import { budgetDecision, parseBudget } from "./budget";
import { proveItem, resolveSpecPath } from "./evidence";
import {
  commitCheckpoint,
  currentBranch,
  dirtyCount,
  git,
  gitAvailable,
  initRepo,
  isRepo,
  rollbackBefore,
  slugify,
  startRunBranch,
} from "./checkpoints";
import { refImagesFor } from "../plan/references";
import { buildBlueprintProcedure } from "../plan/procedure";
import { checkPlan, formatCoverage } from "../plan/check";
import { readPoints } from "../plan/sources";
import { itemContext, parseExperience } from "../plan/walkthrough";
import { buildMomentCheckPrompt, markAsked, momentContext, pendingMoments } from "../plan/moment-check";
import { loadConfig as loadPlanConfig } from "../plan/config";
import { hasImageSearch, setPlanning, syncPlanTools } from "../plan/state";
import {
  buildBrief,
  buildFinishCheck,
  buildPlaytest,
  buildReplan,
  buildRetry,
  buildStallNudge,
  formatMinutes,
} from "./procedure";
import { loadConfig as loadScenariosConfig, persistResultBar } from "../scenarios/config";
import { findJourneySpecs } from "../scenarios/spec-audit";
import { loadVisionImages } from "../scenarios/vision";
import { presentVisionToSession } from "../shared/vision-relay";
import { extractEditPath, isEditTool } from "../shared/edit-tools";
import { isGateClaimed, registerGateReset, tryClaimGate } from "../shared/gate-orchestrator";
import { turnOffPlaytest } from "../shared/playtest";
import { syncOwnedTools } from "../shared/tool-activation";
import { withGateWorkingMessage } from "../shared/working-status";

const TOOLS = ["start_autopilot", "defer_items", "finish_autopilot"];

const RUN_FILE = ".pi/blueprint/run.json";

/** Items in a row blocked for no progress before the run pauses. */
const STALLED_ITEMS_BEFORE_PAUSE = 3;

/** Run settings and bookkeeping. Progress itself lives in the blueprint's marks. */
interface RunState {
  status: "running" | "paused" | "done";
  goal: string;
  scope: AutopilotScope;
  budgetMinutes: number | null;
  /** Active time before the current running segment. */
  usedMs: number;
  checkpoints: { branch: string; from: string; baseSha: string } | null;
  /** Item id → checkpoint commit, in commit order. */
  commits: Array<{ id: string; sha: string; blocked: boolean }>;
  attempts: Record<string, number>;
  /** Authoritative marks: what evidence said. The file is reconciled to these. */
  marks: Record<string, { mark: Mark; note?: string }>;
  /** Manual items that were built (they cannot be proven; the user confirms them). */
  manualBuilt: string[];
  current: string | null;
  stalls: number;
  /** Items blocked in a row for making no progress — enough of them pauses the run. */
  stalledInRow?: number;
  /** Items finished (done, blocked or manual-built) in this run — the budget's pace. */
  finished: number;
  /** `finished` at the last re-plan request (one request per finished count). */
  replanAt: number;
  startedAt: string;
  stopReason?: string;
  /** Product bar: the one playtest turn before finishing has been asked for. */
  playtested?: boolean;
}

export default function (pi: ExtensionAPI) {
  registerGateReset(pi);
  let configCache: AutopilotConfig | null = null;
  let run: RunState | null = null;
  /** Running segment start (ms); time only counts while running. */
  let segmentStart = 0;
  let editSerial = 0;
  let editsAtBrief = 0;
  /** User chose "don't offer again this session" or /autopilot off. */
  let sessionDisabled = false;
  let finishRequested = false;
  /**
   * The last run ended aborted. Anti-loop aborts too and then continues the session; only
   * an abort that leaves pi idle (no continuation started) is the user's Esc.
   */
  let abortPending = false;

  function cfg(ctx: ExtensionContext): AutopilotConfig {
    if (!configCache) configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  /** Where the plan lives — owned by the plan extension's config. */
  function planPaths(ctx: ExtensionContext): { blueprintPath: string; refsDir: string } {
    return loadPlanConfig(ctx.cwd);
  }

  function notify(ctx: ExtensionContext, msg: string, kind: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(msg, kind);
  }

  /** The blueprint's Bar line wins; else the project's scenarios result bar. */
  function resultBar(ctx: ExtensionContext): "product" | "spec" | "unset" {
    const bp = readBlueprint(ctx.cwd, planPaths(ctx).blueprintPath);
    return bp?.parsed.bar ?? loadScenariosConfig(ctx.cwd).bar;
  }

  // ---------- run state on disk ----------

  function loadRun(cwd: string): RunState | null {
    try {
      const abs = path.join(cwd, RUN_FILE);
      if (!fs.existsSync(abs)) return null;
      return JSON.parse(fs.readFileSync(abs, "utf8")) as RunState;
    } catch {
      return null;
    }
  }

  function saveRun(ctx: ExtensionContext) {
    if (!run) return;
    const abs = path.join(ctx.cwd, RUN_FILE);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  }

  function usedMinutes(): number {
    if (!run) return 0;
    const live = run.status === "running" && segmentStart ? Date.now() - segmentStart : 0;
    return (run.usedMs + live) / 60_000;
  }

  function closeSegment() {
    if (run && segmentStart) run.usedMs += Date.now() - segmentStart;
    segmentStart = 0;
  }

  // ---------- tools offered ----------

  function available(ctx: ExtensionContext): boolean {
    const config = cfg(ctx);
    if (!config.enabled || sessionDisabled) return false;
    return ctx.hasUI || config.headless === "allow";
  }

  function syncTools(ctx: ExtensionContext) {
    if (!available(ctx)) {
      syncOwnedTools(pi, TOOLS, []);
      return;
    }
    const wanted = ["start_autopilot"];
    if (run?.status === "running") wanted.push("defer_items", "finish_autopilot");
    syncOwnedTools(pi, TOOLS, wanted);
    syncPlanTools(pi, ctx); // planning may have just started (start_autopilot without a blueprint)
  }

  function showStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!run || run.status === "done") {
      ctx.ui.setStatus("autopilot", undefined);
      return;
    }
    const bp = readBlueprint(ctx.cwd, planPaths(ctx).blueprintPath);
    const counts = bp ? tierCounts(inScope(bp.parsed.items, run.scope)) : "";
    const time = run.budgetMinutes !== null ? `${formatMinutes(usedMinutes())} of ${formatMinutes(run.budgetMinutes)}` : `${formatMinutes(usedMinutes())} · no limit`;
    const label = run.status === "paused" ? "paused" : run.current ?? "";
    ctx.ui.setStatus("autopilot", `autopilot: ${label} · ${counts} · ${time}`);
  }

  // ---------- marks: owned by the extension ----------

  /**
   * Make the file's marks say what evidence said. Edits to marks — by the model or the
   * user — are rewritten; items added during the run start open.
   */
  function reconcile(ctx: ExtensionContext): { text: string; items: BlueprintItem[] } | null {
    const rel = planPaths(ctx).blueprintPath;
    const bp = readBlueprint(ctx.cwd, rel);
    if (!bp || !run) return bp ? { text: bp.text, items: bp.parsed.items } : null;
    let text = bp.text;
    for (const item of bp.parsed.items) {
      const want = run.marks[item.id] ?? { mark: " " as Mark };
      if (!run.marks[item.id]) run.marks[item.id] = want;
      const noteNow = item.fields.blocked ?? item.fields.deferred;
      if (item.mark !== want.mark || (want.note && noteNow !== want.note)) text = setMark(text, item.id, want.mark, want.note);
    }
    if (text !== bp.text) writeBlueprint(ctx.cwd, rel, text);
    const parsed = text === bp.text ? bp.parsed : readBlueprint(ctx.cwd, rel)!.parsed;
    return { text, items: parsed.items };
  }

  /**
   * Items left in progress (~) by an earlier run, a pause or a restart may already be built —
   * the run just never had a turn to prove them (another gate kept the follow-up). Prove them
   * first, so finished work is recorded instead of being briefed again from scratch.
   */
  async function settleStarted(ctx: ExtensionContext, items: BlueprintItem[]): Promise<string[]> {
    if (!run) return [];
    const done: string[] = [];
    for (const item of inScope(items, run.scope).filter((i) => i.mark === "~")) {
      const proof = await proveItem(ctx.cwd, item, ctx.signal);
      if (!proof.ok) continue;
      mark(ctx, item.id, "x");
      run.attempts[item.id] = 0;
      run.finished += 1;
      done.push(item.id);
    }
    if (done.length) notify(ctx, `Autopilot: ${done.join(", ")} already built — evidence passes, marked done.`);
    return done;
  }

  function mark(ctx: ExtensionContext, id: string, m: Mark, note?: string) {
    if (!run) return;
    run.marks[id] = note ? { mark: m, note } : { mark: m };
    const rel = planPaths(ctx).blueprintPath;
    const bp = readBlueprint(ctx.cwd, rel);
    if (bp) writeBlueprint(ctx.cwd, rel, setMark(bp.text, id, m, note));
  }

  function openInRun(items: BlueprintItem[]): BlueprintItem[] {
    if (!run) return [];
    const manual = new Set(run.manualBuilt);
    return inScope(items, run.scope).filter((i) => i.mark === " " || (i.mark === "~" && !manual.has(i.id)));
  }

  /** The item in progress, else the first open one in blueprint order. */
  function pickNext(items: BlueprintItem[]): BlueprintItem | undefined {
    const open = openInRun(items);
    return open.find((i) => i.mark === "~") ?? open[0];
  }

  // ---------- briefs ----------

  /** The item's moment and the source's own words — so it is built as meant, not as paraphrased. */
  function planContext(ctx: ExtensionContext, item: BlueprintItem, text: string): string {
    const points = readPoints(ctx.cwd, planPaths(ctx).blueprintPath)?.points ?? [];
    return itemContext(item, parseExperience(text), points);
  }

  async function sendBrief(
    ctx: ExtensionContext,
    item: BlueprintItem,
    items: BlueprintItem[],
    text: string,
    opts: { resumed?: boolean; startedBefore?: boolean } = {},
  ) {
    if (!run) return;
    const isSpec = !/^(verify|manual)$/i.test(item.proves.trim()) && item.proves.trim() !== "";
    const refs = refImagesFor(ctx.cwd, text, item.id);
    const brief = buildBrief({
      item,
      specPath: isSpec ? resolveSpecPath(ctx.cwd, item.proves) : null,
      summary: formatSummary(items, run.scope),
      progress: tierCounts(inScope(items, run.scope)),
      timeNote: timeNote(),
      attempt: (run.attempts[item.id] ?? 0) + 1,
      maxAttempts: cfg(ctx).itemAttempts,
      refs: refs.map((r) => path.relative(ctx.cwd, r).replace(/\\/g, "/")),
      resumed: opts.resumed,
      startedBefore: opts.startedBefore,
      context: planContext(ctx, item, text),
    });
    editsAtBrief = editSerial;
    if (refs.length === 0) {
      pi.sendUserMessage(brief, { deliverAs: "followUp" });
      return;
    }
    const { images, paths } = await loadVisionImages(refs, loadScenariosConfig(ctx.cwd));
    pi.sendUserMessage(images.length ? await presentVisionToSession(ctx, brief, images, paths) : brief, { deliverAs: "followUp" });
  }

  function timeNote(): string {
    if (!run) return "";
    if (run.budgetMinutes === null) return `${formatMinutes(usedMinutes())} used`;
    return `${formatMinutes(Math.max(0, run.budgetMinutes - usedMinutes()))} left of ${formatMinutes(run.budgetMinutes)}`;
  }

  // ---------- start / stop ----------

  function scopeCounts(items: BlueprintItem[]) {
    return {
      v1: items.filter((i) => i.tier === "v1").length,
      v2: items.filter((i) => i.tier === "v2").length,
      later: items.filter((i) => i.tier === "later").length,
    };
  }

  /** A run works through the gates; playtest mode hides them, so starting or resuming ends it. */
  function leavePlaytest(ctx: ExtensionContext) {
    if (turnOffPlaytest()) notify(ctx, "Playtest mode off — autopilot works with the checks. /playtest on again after the run.");
  }

  type StartOutcome ={ started: true; first: BlueprintItem | null; note: string; startedBefore: boolean } | { started: false; reason: string; disable?: boolean };

  /** Approval dialog (or headless defaults), checkpoints setup, run state. */
  async function approveAndStart(ctx: ExtensionContext, goalHint: string, scopeHint?: AutopilotScope): Promise<StartOutcome> {
    const config = cfg(ctx);
    const bp = readBlueprint(ctx.cwd, planPaths(ctx).blueprintPath)!;
    const items = bp.parsed.items;
    const counts = scopeCounts(items);
    const goal = bp.parsed.goal || goalHint;

    let checkpointsOn = config.checkpoints && (await gitAvailable(ctx.cwd));
    const repo = checkpointsOn && (await isRepo(ctx.cwd));
    const dirty = repo ? await dirtyCount(ctx.cwd) : 0;
    const slug = slugify(goal);

    let scope: AutopilotScope = scopeHint ?? config.defaultScope;
    let budget: number | null = null;

    if (ctx.hasUI) {
      const cpLine = !checkpointsOn
        ? "Checkpoints: off"
        : repo
          ? `Checkpoints: commit per item on branch autopilot/${slug}${dirty > 0 ? ` — your ${dirty} uncommitted file(s) become its starting point` : ""}`
          : "Checkpoints: this folder is not a git repository — you will be asked";
      const title =
        `Autopilot — build "${goal}" to spec\n` +
        `Blueprint: ${planPaths(ctx).blueprintPath} · v1: ${counts.v1} · v2: ${counts.v2} · later: ${counts.later}\n` +
        `${formatCoverage(checkPlan(ctx.cwd, loadPlanConfig(ctx.cwd)).coverage)}\n${cpLine}`;
      const START = "Start";
      const NEVER = "Don't offer again this session";
      const pick = await ctx.ui.select(title, [START, "Not now", NEVER]);
      if (pick === NEVER) return { started: false, reason: "The user turned autopilot off for this session.", disable: true };
      if (pick !== START) return { started: false, reason: "The user declined autopilot for now." };

      if (counts.v2 + counts.later > 0) {
        const opts = [`v1 only (${counts.v1} items)`, ...(counts.v2 ? [`v1 + v2 (${counts.v1 + counts.v2})`] : []), `everything (${items.length})`];
        const preselect = scope === "all" ? opts.length - 1 : scope === "v2" && counts.v2 ? 1 : 0;
        const s = await ctx.ui.select("Scope for this run", [opts[preselect]!, ...opts.filter((_, i) => i !== preselect)]);
        if (!s) return { started: false, reason: "The user declined autopilot for now." };
        scope = s.startsWith("v1 only") ? "v1" : s.startsWith("v1 + v2") ? "v2" : "all";
      } else {
        scope = "v1";
      }

      const b = await ctx.ui.select("Time budget", ["No time limit", "1 hour", "2 hours", "3 hours", "Custom…"]);
      if (!b) return { started: false, reason: "The user declined autopilot for now." };
      if (b === "Custom…") {
        const raw = await ctx.ui.input("Budget (e.g. 90, 90m, 1.5h, 2:30)", "90m");
        const parsed = parseBudget(raw);
        budget = parsed === "invalid" ? null : parsed;
      } else {
        budget = b === "No time limit" ? null : Number(b[0]) * 60;
      }

      if (checkpointsOn && !repo) {
        const ok = await ctx.ui.confirm(
          "Autopilot checkpoints",
          "This folder isn't a git repository. Initialize one so each item can be checkpointed (and rolled back)?",
        );
        if (ok) {
          const init = await initRepo(ctx.cwd);
          if (!init.ok) {
            checkpointsOn = false;
            persistProjectConfig(ctx.cwd, { checkpoints: false });
            configCache = null;
            notify(ctx, `Autopilot: git init failed — checkpoints off for this project.\n${init.out.slice(0, 300)}`, "warning");
          }
        } else {
          checkpointsOn = false;
          persistProjectConfig(ctx.cwd, { checkpoints: false });
          configCache = null;
        }
      }
    } else if (checkpointsOn && !repo) {
      checkpointsOn = false; // headless: never git-init unasked
    }

    let checkpoints: RunState["checkpoints"] = null;
    if (checkpointsOn) {
      const started = await startRunBranch(ctx.cwd, slug);
      if (started.ok) checkpoints = started.run;
      else notify(ctx, `Autopilot: could not create the run branch — checkpoints off for this run.\n${started.error.slice(0, 300)}`, "warning");
    }

    const marks: RunState["marks"] = {};
    for (const it of items) {
      const note = it.fields.blocked ?? it.fields.deferred;
      marks[it.id] = note ? { mark: it.mark, note } : { mark: it.mark };
    }
    run = {
      status: "running",
      goal,
      scope,
      budgetMinutes: budget,
      usedMs: 0,
      checkpoints,
      commits: [],
      attempts: {},
      marks,
      manualBuilt: [],
      current: null,
      stalls: 0,
      finished: 0,
      replanAt: -1,
      startedAt: new Date().toISOString(),
    };
    segmentStart = Date.now();
    finishRequested = false;
    setPlanning(false);
    leavePlaytest(ctx);
    // The blueprint decided what done means; let the scenarios gate (journeys) agree.
    if (bp.parsed.bar && loadScenariosConfig(ctx.cwd).bar === "unset") persistResultBar(ctx.cwd, bp.parsed.bar);
    await settleStarted(ctx, items);
    const first = pickNext(reconcile(ctx)?.items ?? items) ?? null;
    const startedBefore = first?.mark === "~";
    if (first) {
      run.current = first.id;
      mark(ctx, first.id, "~");
    }
    saveRun(ctx);
    syncTools(ctx);
    showStatus(ctx);
    const note =
      `Autopilot started: scope ${scope}, ${budget !== null ? `budget ${formatMinutes(budget)}` : "no time limit"}, ` +
      `${checkpoints ? `checkpoints on ${checkpoints.branch}` : "no checkpoints"}.`;
    notify(ctx, `${note} Esc or /autopilot pause stops it.`);
    return { started: true, first, note, startedBefore };
  }

  function report(ctx: ExtensionContext, items: BlueprintItem[]): string {
    if (!run) return "";
    const scoped = inScope(items, run.scope);
    const by = (m: Mark) => scoped.filter((i) => i.mark === m);
    const lines = [
      `Autopilot ${run.status === "done" ? "finished" : "stopped"}${run.stopReason ? ` — ${run.stopReason}` : ""} · ${formatMinutes(usedMinutes())} used`,
      `Done: ${by("x").map((i) => i.id).join(", ") || "none"}`,
    ];
    const blocked = by("!");
    if (blocked.length) lines.push(`Blocked: ${blocked.map((i) => `${i.id} (${i.fields.blocked ?? "?"})`).join("; ")}`);
    const deferred = by("-");
    if (deferred.length) lines.push(`Deferred: ${deferred.map((i) => `${i.id} (${i.fields.deferred ?? "?"})`).join("; ")}`);
    if (run.manualBuilt.length) lines.push(`Needs you (manual check): ${run.manualBuilt.join(", ")}`);
    const open = openInRun(items);
    if (open.length) lines.push(`Still open: ${open.map((i) => i.id).join(", ")} — /autopilot resume continues`);
    const bp = readBlueprint(ctx.cwd, planPaths(ctx).blueprintPath);
    const assumptions = bp?.text.match(/^\s*-\s+A-\d+.*$/gm) ?? [];
    if (assumptions.length) lines.push(`Assumptions made: ${assumptions.length} (see ## Assumptions in the blueprint)`);
    if (run.checkpoints) lines.push(`Checkpoints: branch ${run.checkpoints.branch} (started from ${run.checkpoints.from}); /autopilot rollback <id> undoes from an item on`);
    return lines.join("\n");
  }

  function stopRun(ctx: ExtensionContext, status: "paused" | "done", reason: string, items?: BlueprintItem[]) {
    if (!run) return;
    closeSegment();
    run.status = status;
    run.stopReason = reason;
    finishRequested = false;
    saveRun(ctx);
    syncTools(ctx);
    showStatus(ctx);
    const its = items ?? readBlueprint(ctx.cwd, planPaths(ctx).blueprintPath)?.parsed.items ?? [];
    notify(ctx, report(ctx, its), status === "done" ? "info" : "warning");
  }

  async function checkpoint(ctx: ExtensionContext, item: BlueprintItem, blocked: boolean) {
    if (!run?.checkpoints) return;
    const msg = `autopilot ${item.id}${blocked ? " (blocked)" : ""}: ${item.title.slice(0, 70)}`;
    const r = await commitCheckpoint(ctx.cwd, msg);
    if (r.ok) run.commits.push({ id: item.id, sha: r.out, blocked });
    else notify(ctx, `Autopilot: checkpoint commit for ${item.id} failed — ${r.out.slice(0, 200)}`, "warning");
  }

  // ---------- events ----------

  pi.on("session_start", async (_event, ctx) => {
    configCache = null;
    setPlanning(false);
    run = loadRun(ctx.cwd);
    if (run?.status === "running") {
      // pi restarted mid-run: never resume on our own.
      run.status = "paused";
      run.stopReason = "session restarted";
      saveRun(ctx);
      notify(ctx, `Autopilot: a run on "${run.goal}" was interrupted — /autopilot resume continues it, /autopilot status shows where it is.`);
    }
    syncTools(ctx);
    showStatus(ctx);
  });

  pi.on("input", async (_event, ctx) => {
    configCache = null;
    syncTools(ctx);
  });

  pi.on("agent_start", async () => {
    abortPending = false; // a continuation (or a new prompt) is running: not an Esc
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!abortPending) return;
    abortPending = false;
    if (run?.status === "running") stopRun(ctx, "paused", "stopped with Esc");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!run || run.status !== "running") return;
    // A user message during a run is steering: follow it, the run continues after.
    return {
      systemPrompt: `${event.systemPrompt}\n\nAUTOPILOT is running (blueprint ${planPaths(ctx).blueprintPath}, current item ${run.current ?? "—"}). A message from the user is steering — follow it, then continue the current item. Do not change the [ ] marks in the blueprint.`,
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!isEditTool(event.toolName) || event.isError) return;
    const p = extractEditPath(event.input);
    if (!p) return;
    // Notes in the blueprint (assumptions, references) are not progress on the item.
    const rel = path.relative(ctx.cwd, path.resolve(ctx.cwd, p)).replace(/\\/g, "/");
    if (rel.startsWith(".pi/blueprint/")) return;
    editSerial += 1;
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!run || run.status !== "running") return;
    if (ctx.signal?.aborted) {
      abortPending = true; // decided at agent_settled
      return;
    }
    if (isGateClaimed()) return; // a checking gate owns this turn's follow-up
    const config = cfg(ctx);

    await withGateWorkingMessage(ctx, "Autopilot — inference idle", async (status) => {
      let state = reconcile(ctx);
      if (!state) {
        stopRun(ctx, "paused", `blueprint ${planPaths(ctx).blueprintPath} is missing`);
        return;
      }
      const r = run!;

      // 1. The item being built: prove it.
      if (r.current) {
        const item = state.items.find((i) => i.id === r.current);
        if (!item || item.mark === "-") {
          r.current = null; // deleted or deferred while building
        } else {
          // Prove even when no edit tool ran: files changed through bash, or work an earlier
          // item already did, count as soon as the evidence passes.
          const edited = editSerial !== editsAtBrief;
          status.step(`proving ${item.id}`);
          const proof = await proveItem(ctx.cwd, item, ctx.signal, (t) => status.step(t));
          if (ctx.signal?.aborted) return;
          if (!edited && !proof.ok) {
            r.stalls += 1;
            if (r.stalls < config.stallStops) {
              saveRun(ctx);
              if (!tryClaimGate("autopilot")) return;
              pi.sendUserMessage(buildStallNudge(item, r.stalls, config.stallStops, proof.manual ? null : proof.report), { deliverAs: "followUp" });
              return;
            }
            // One stuck item must not end an unattended run: block it and move on. Several in a
            // row is the model or its server, not the item — then pause.
            r.stalledInRow = (r.stalledInRow ?? 0) + 1;
            mark(ctx, item.id, "!", `no progress after ${r.stalls} stops`);
            await checkpoint(ctx, item, true);
            r.current = null;
            r.finished += 1;
            r.stalls = 0;
            if (r.stalledInRow >= STALLED_ITEMS_BEFORE_PAUSE) {
              stopRun(ctx, "paused", `no progress on ${r.stalledInRow} items in a row (last: ${item.id})`, reconcile(ctx)?.items);
              return;
            }
            notify(ctx, `Autopilot: ${item.id} blocked — no progress after ${config.stallStops} stops. Moving on.`, "warning");
          } else if (proof.manual) {
            r.stalls = 0;
            r.stalledInRow = 0;
            if (!r.manualBuilt.includes(item.id)) r.manualBuilt.push(item.id);
            await checkpoint(ctx, item, false);
            r.current = null;
            r.finished += 1;
          } else if (proof.ok) {
            r.stalls = 0;
            r.stalledInRow = 0;
            mark(ctx, item.id, "x");
            r.attempts[item.id] = 0;
            await checkpoint(ctx, item, false);
            r.current = null;
            r.finished += 1;
            notify(ctx, `Autopilot: ${item.id} done.`);
          } else {
            r.stalls = 0;
            r.stalledInRow = 0;
            r.attempts[item.id] = (r.attempts[item.id] ?? 0) + 1;
            const attempt = r.attempts[item.id]!;
            if (attempt >= config.itemAttempts) {
              const why = proof.report.split(/\r?\n/).find((l) => /fail|error|missing|timed out/i.test(l))?.trim() ?? "evidence kept failing";
              mark(ctx, item.id, "!", why.slice(0, 140));
              await checkpoint(ctx, item, true);
              r.current = null;
              r.finished += 1;
              notify(ctx, `Autopilot: ${item.id} blocked after ${attempt} attempts — moving on.`, "warning");
            } else {
              saveRun(ctx);
              if (!tryClaimGate("autopilot")) return;
              editsAtBrief = editSerial;
              pi.sendUserMessage(buildRetry(item, proof.report, attempt + 1, config.itemAttempts), { deliverAs: "followUp" });
              return;
            }
          }
          saveRun(ctx);
          state = reconcile(ctx)!;
        }
      }

      // 1b. A moment whose items are now all built: check it as a whole before moving on.
      const planConfig = loadPlanConfig(ctx.cwd);
      const complete = pendingMoments(ctx.cwd, planConfig)[0];
      const momentCheck = complete ? momentContext(ctx.cwd, planConfig, complete.id) : null;
      if (momentCheck) {
        markAsked(ctx.cwd, planConfig, momentCheck.moment.id);
        saveRun(ctx);
        if (!tryClaimGate("autopilot")) return;
        editsAtBrief = editSerial;
        pi.sendUserMessage(buildMomentCheckPrompt(momentCheck.moment, momentCheck.items, momentCheck.exp, momentCheck.points), { deliverAs: "followUp" });
        return;
      }

      // 2. Nothing open (or the model says done): re-check every done item, then finish.
      const used = usedMinutes();
      const finished = r.finished;
      let next = pickNext(state.items);
      if (!next || finishRequested) {
        if (next) {
          finishRequested = false; // claimed done with items open: continue below
        } else {
          for (const done of inScope(state.items, r.scope).filter((i) => i.mark === "x")) {
            status.step(`re-checking ${done.id}`);
            const again = await proveItem(ctx.cwd, done, ctx.signal);
            if (ctx.signal?.aborted) return;
            if (!again.ok && !again.manual) mark(ctx, done.id, " ");
          }
          state = reconcile(ctx)!;
          next = pickNext(state.items);
          if (!next) {
            // Product bar: every item passed, but "passes" is not "a person can use it".
            if (resultBar(ctx) === "product" && !r.playtested) {
              r.playtested = true;
              saveRun(ctx);
              if (!tryClaimGate("autopilot")) return;
              editsAtBrief = editSerial;
              const journeys = findJourneySpecs(ctx.cwd, loadScenariosConfig(ctx.cwd));
              pi.sendUserMessage(buildPlaytest(journeys, pi.getActiveTools().includes("play")), { deliverAs: "followUp" });
              return;
            }
            stopRun(ctx, "done", "scope complete", state.items);
            return;
          }
          notify(ctx, `Autopilot: a done item no longer passes — reopened ${next.id}.`, "warning");
        }
      }

      // 3. Budget: stop at a clean boundary; re-plan when behind.
      const open = openInRun(state.items);
      const decision = budgetDecision({ usedMinutes: used, budgetMinutes: r.budgetMinutes, finished, open: open.length, replanAt: r.replanAt });
      if (decision === "stop") {
        stopRun(ctx, "paused", `time budget reached (${formatMinutes(used)} of ${formatMinutes(r.budgetMinutes!)})`, state.items);
        return;
      }
      if (decision === "replan") {
        r.replanAt = finished;
        saveRun(ctx);
        if (!tryClaimGate("autopilot")) return;
        editsAtBrief = editSerial;
        pi.sendUserMessage(buildReplan(r.budgetMinutes! - used, open), { deliverAs: "followUp" });
        return;
      }

      // 4. Next item.
      r.current = next.id;
      if (next.mark !== "~") mark(ctx, next.id, "~");
      r.stalls = 0;
      saveRun(ctx);
      showStatus(ctx);
      if (!tryClaimGate("autopilot")) return;
      const fresh = reconcile(ctx)!;
      await sendBrief(ctx, fresh.items.find((i) => i.id === next!.id) ?? next, fresh.items, fresh.text);
    });
    showStatus(ctx);
  });

  // ---------- tools ----------

  pi.registerTool({
    name: "start_autopilot",
    label: "Start Autopilot",
    description:
      "Propose an autopilot run: the user approves once, then you work through the blueprint item by item until the chosen scope is built and proven, " +
      "without the user having to say 'continue'. Call this when the user wants the work carried through to completion on its own " +
      "(e.g. 'build it to spec and come back when it's done', 'just make the whole game'). Do not call it for ordinary single tasks. " +
      "Without a blueprint it returns instructions to write one first.",
    promptSnippet: "Autopilot: carry a build to completion (user approves)",
    parameters: Type.Object({
      goal: Type.String({ description: "One line: what is being built." }),
      scope: Type.Optional(Type.Union([Type.Literal("v1"), Type.Literal("v2"), Type.Literal("all")], { description: "Suggested scope tier." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      if (run?.status === "running") {
        return { content: [{ type: "text", text: `Autopilot is already running (current item ${run.current ?? "—"}).` }], details: {} };
      }
      const bp = readBlueprint(ctx.cwd, planPaths(ctx).blueprintPath);
      if (!bp) {
        setPlanning(true);
        syncTools(ctx);
        return {
          content: [{ type: "text", text: buildBlueprintProcedure({ blueprintPath: planPaths(ctx).blueprintPath, refsDir: planPaths(ctx).refsDir, budgetMinutes: null, imageSearch: hasImageSearch(ctx.cwd), forAutopilot: true }) }],
          details: { needsBlueprint: true },
        };
      }
      const problems = checkPlan(ctx.cwd, loadPlanConfig(ctx.cwd)).problems;
      if (problems.length > 0) {
        setPlanning(true);
        syncTools(ctx);
        return {
          content: [{ type: "text", text: `Fix the blueprint first (${planPaths(ctx).blueprintPath}), then call start_autopilot again:\n- ${problems.join("\n- ")}` }],
          details: { problems },
        };
      }
      const outcome = await approveAndStart(ctx, params.goal, params.scope);
      if (!outcome.started) {
        if (outcome.disable) {
          sessionDisabled = true;
          syncTools(ctx);
        }
        return {
          content: [{ type: "text", text: `${outcome.reason} Continue in normal mode; do not call start_autopilot again unless the user asks.` }],
          details: { started: false },
        };
      }
      if (!outcome.first) {
        stopRun(ctx, "done", "nothing open in this scope");
        return { content: [{ type: "text", text: "Every item in this scope is already done — nothing to build." }], details: { started: true } };
      }
      const state = reconcile(ctx)!;
      const item = state.items.find((i) => i.id === outcome.first!.id) ?? outcome.first;
      const isSpec = !/^(verify|manual)$/i.test(item.proves.trim());
      const refs = refImagesFor(ctx.cwd, state.text, item.id);
      const brief = buildBrief({
        item,
        specPath: isSpec ? resolveSpecPath(ctx.cwd, item.proves) : null,
        summary: formatSummary(state.items, run!.scope),
        progress: tierCounts(inScope(state.items, run!.scope)),
        timeNote: timeNote(),
        attempt: 1,
        maxAttempts: config.itemAttempts,
        refs: refs.map((r) => path.relative(ctx.cwd, r).replace(/\\/g, "/")),
        context: planContext(ctx, item, state.text),
        startedBefore: outcome.startedBefore,
      });
      editsAtBrief = editSerial;
      const text = `${outcome.note}\n\n${brief}`;
      if (refs.length === 0) return { content: [{ type: "text", text }], details: { started: true } };
      const { images, paths } = await loadVisionImages(refs, loadScenariosConfig(ctx.cwd));
      return { content: images.length ? await presentVisionToSession(ctx, text, images, paths) : [{ type: "text", text }], details: { started: true } };
    },
  });

  pi.registerTool({
    name: "defer_items",
    label: "Defer Items",
    description:
      "Autopilot: take items out of this run (they stay in the blueprint, marked deferred with your reason) — when re-planning for the time budget, " +
      "or when an item truly cannot be built here.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { description: "Item ids, e.g. ['R-12']." }),
      reason: Type.String({ description: "One line: why." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!run || run.status !== "running") return { content: [{ type: "text", text: "No autopilot run is active." }], details: {}, isError: true };
      const state = reconcile(ctx);
      const done: string[] = [];
      const skipped: string[] = [];
      for (const id of params.ids) {
        const item = state?.items.find((i) => i.id === id.toUpperCase());
        if (!item || item.mark === "x" || item.mark === "!") {
          skipped.push(id);
          continue;
        }
        mark(ctx, item.id, "-", params.reason);
        if (run.current === item.id) run.current = null;
        done.push(item.id);
      }
      saveRun(ctx);
      showStatus(ctx);
      const text = `${done.length ? `Deferred ${done.join(", ")}.` : "Nothing deferred."}${skipped.length ? ` Not deferred (unknown, done or blocked): ${skipped.join(", ")}.` : ""}`;
      return { content: [{ type: "text", text }], details: { deferred: done } };
    },
  });

  pi.registerTool({
    name: "finish_autopilot",
    label: "Finish Autopilot",
    description:
      "Autopilot: say the run's scope is done. The extension checks — open items and failing evidence send you back to work. Never claim done to stop early.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!run || run.status !== "running") return { content: [{ type: "text", text: "No autopilot run is active." }], details: {}, isError: true };
      const state = reconcile(ctx);
      const open = state ? openInRun(state.items).filter((i) => i.id !== run!.current) : [];
      if (open.length > 0) return { content: [{ type: "text", text: buildFinishCheck(open) }], details: { done: false } };
      finishRequested = true;
      return {
        content: [{ type: "text", text: "Noted. When you stop, autopilot proves the current item and re-checks every done item before finishing the run." }],
        details: { done: true },
      };
    },
  });

  // ---------- commands ----------

  pi.registerCommand("autopilot", {
    description: "Autopilot — start | pause | resume | status | rollback <id> | off [project] | on",
    handler: async (args, ctx) => {
      const config = cfg(ctx);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "start").toLowerCase();

      if (sub === "off") {
        sessionDisabled = true;
        if (parts[1]?.toLowerCase() === "project") {
          persistProjectConfig(ctx.cwd, { enabled: false });
          configCache = null;
        }
        syncTools(ctx);
        ctx.ui.notify(parts[1]?.toLowerCase() === "project" ? "Autopilot off for this project (saved)." : "Autopilot off for this session.", "info");
        return;
      }
      if (sub === "on") {
        sessionDisabled = false;
        if (!loadConfig(ctx.cwd).enabled) persistProjectConfig(ctx.cwd, { enabled: true });
        configCache = null;
        syncTools(ctx);
        ctx.ui.notify("Autopilot available — the model offers it when you want work carried through.", "info");
        return;
      }

      if (sub === "status") {
        const r = run ?? loadRun(ctx.cwd);
        const bp = readBlueprint(ctx.cwd, planPaths(ctx).blueprintPath);
        if (!r) {
          ctx.ui.notify(bp ? `No autopilot run yet. Blueprint: ${tierCounts(bp.parsed.items)}. /autopilot starts one.` : "No blueprint and no run. /blueprint <what to build> writes one.", "info");
          return;
        }
        run = r;
        if (r.status !== "done") reconcile(ctx);
        const items = readBlueprint(ctx.cwd, planPaths(ctx).blueprintPath)?.parsed.items ?? [];
        ctx.ui.notify(`${report(ctx, items)}\n\n${formatSummary(items, r.scope)}`, "info");
        return;
      }

      if (sub === "pause") {
        if (!run || run.status !== "running") {
          ctx.ui.notify("No autopilot run is active.", "info");
          return;
        }
        stopRun(ctx, "paused", "paused by you");
        if (!ctx.isIdle()) ctx.abort();
        return;
      }

      if (sub === "resume") {
        run = run ?? loadRun(ctx.cwd);
        if (!run || run.status === "done") {
          ctx.ui.notify("Nothing to resume. /autopilot starts a new run.", "info");
          return;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify("Wait until the agent is idle, then /autopilot resume.", "warning");
          return;
        }
        if (run.checkpoints && (await currentBranch(ctx.cwd)) !== run.checkpoints.branch) {
          const sw = await git(ctx.cwd, ["switch", run.checkpoints.branch]);
          if (!sw.ok) {
            ctx.ui.notify(`Switch to ${run.checkpoints.branch} first (git switch failed: ${sw.out.slice(0, 200)}).`, "warning");
            return;
          }
        }
        run.status = "running";
        run.stopReason = undefined;
        run.stalls = 0;
        segmentStart = Date.now();
        leavePlaytest(ctx);
        const before = reconcile(ctx);
        if (before) await settleStarted(ctx, before.items);
        const state = reconcile(ctx);
        const next = state ? pickNext(state.items) : undefined;
        if (!state || !next) {
          stopRun(ctx, "done", "scope complete", state?.items);
          return;
        }
        run.current = next.id;
        const startedBefore = next.mark === "~";
        if (!startedBefore) mark(ctx, next.id, "~");
        saveRun(ctx);
        syncTools(ctx);
        showStatus(ctx);
        const fresh = reconcile(ctx)!;
        await sendBrief(ctx, fresh.items.find((i) => i.id === next.id) ?? next, fresh.items, fresh.text, { resumed: true, startedBefore });
        return;
      }

      if (sub === "rollback") {
        const id = parts[1]?.toUpperCase();
        run = run ?? loadRun(ctx.cwd);
        if (!run?.checkpoints) {
          ctx.ui.notify("This run has no checkpoints to roll back to.", "warning");
          return;
        }
        const at = id ? run.commits.findIndex((c) => c.id === id) : -1;
        if (at < 0) {
          ctx.ui.notify(`No checkpoint for ${id ?? "(no id)"}. Checkpointed: ${run.commits.map((c) => c.id).join(", ") || "none"}.`, "warning");
          return;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify("Wait until the agent is idle, then roll back.", "warning");
          return;
        }
        const undone = run.commits.slice(at).map((c) => c.id);
        const ok = await ctx.ui.confirm(
          "Autopilot rollback",
          `Reset ${run.checkpoints.branch} to before ${id}? This undoes: ${undone.join(", ")} (all uncommitted changes on the branch are lost too).`,
        );
        if (!ok) return;
        const reset = await rollbackBefore(ctx.cwd, run.checkpoints.branch, run.commits[at]!.sha);
        if (!reset.ok) {
          ctx.ui.notify(`Rollback failed: ${reset.out.slice(0, 300)}`, "error");
          return;
        }
        run.commits = run.commits.slice(0, at);
        for (const u of undone) {
          run.marks[u] = { mark: " " };
          delete run.attempts[u];
          run.manualBuilt = run.manualBuilt.filter((m) => m !== u);
        }
        run.current = null;
        if (run.status === "running") run.status = "paused";
        reconcile(ctx);
        saveRun(ctx);
        showStatus(ctx);
        ctx.ui.notify(`Rolled back ${undone.join(", ")}. /autopilot resume continues from ${id}.`, "info");
        return;
      }

      if (sub === "start") {
        if (!available(ctx)) {
          ctx.ui.notify("Autopilot is off (/autopilot on).", "warning");
          return;
        }
        if (run?.status === "running") {
          ctx.ui.notify("Autopilot is already running. /autopilot status", "info");
          return;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify("Wait until the agent is idle, then /autopilot.", "warning");
          return;
        }
        const bp = readBlueprint(ctx.cwd, planPaths(ctx).blueprintPath);
        if (!bp) {
          ctx.ui.notify("No blueprint yet — /blueprint <what to build> writes one first.", "warning");
          return;
        }
        const problems = checkPlan(ctx.cwd, loadPlanConfig(ctx.cwd)).problems;
        if (problems.length > 0) {
          ctx.ui.notify(`Blueprint needs fixing first:\n- ${problems.slice(0, 8).join("\n- ")}`, "warning");
          return;
        }
        const outcome = await approveAndStart(ctx, bp.parsed.goal || "the blueprint");
        if (!outcome.started) {
          if (outcome.disable) {
            sessionDisabled = true;
            syncTools(ctx);
          }
          return;
        }
        if (!outcome.first) {
          stopRun(ctx, "done", "nothing open in this scope");
          return;
        }
        const fresh = reconcile(ctx)!;
        await sendBrief(ctx, fresh.items.find((i) => i.id === outcome.first!.id) ?? outcome.first, fresh.items, fresh.text, {
          startedBefore: outcome.startedBefore,
        });
        return;
      }

      ctx.ui.notify("Usage: /autopilot [start] | pause | resume | status | rollback <id> | off [project] | on", "info");
    },
  });
}
