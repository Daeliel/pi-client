import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AXIS_DESCRIPTIONS, EXPAND_AXES, isExpandAxis, loadConfig, persistCriticModel, type ExpandAxis, type ExpandConfig } from "./config";
import {
  addIdeas,
  applyMap,
  autoPick,
  emptyLedger,
  findIdea,
  formatIdeas,
  formatLedgerSummary,
  formatMap,
  loadLedger,
  parsePillars,
  saveLedger,
  setStatus as setIdeaStatus,
  type Idea,
  type Ledger,
} from "./ledger";
import {
  buildBuildPrompt,
  buildExpandProcedure,
  buildExternalFitPrompts,
  buildExternalFixPrompt,
  buildIdeasPrompt,
  buildMapPrompt,
  buildSelfFitPrompt,
  parseFitReply,
} from "./procedure";
import { runCriticCompletion } from "../polish/critic";
import { isGateClaimed, resetGateClaim, tryClaimGate, registerGateReset } from "../shared/gate-orchestrator";
import { extractEditPath, isEditTool } from "../shared/edit-tools";
import { registerOnceModifier } from "../shared/once";
import { withGateWorkingMessage } from "../shared/working-status";

const WIDGET_KEY = "expand";
const MAX_CRITIC_FILE_CHARS = 20_000;
const MAX_CRITIC_TOTAL_CHARS = 60_000;

type Mode = "idle" | "map" | "ideas" | "build";

interface TaskState {
  mode: Mode;
  axes: ExpandAxis[];
  focus: string;
  autoBudget: number | null;
  /** Idea numbers being built this task. */
  building: number[];
  fitDone: number;
  editSerialAtFit: number;
  changedFiles: Set<string>;
  warned: Set<string>;
}

function firstLine(s: string | undefined): string {
  return (s ?? "").split(/\r?\n/)[0]?.slice(0, 160) ?? "";
}

function parseNumbers(words: string[]): number[] {
  const out: number[] = [];
  for (const w of words) {
    for (const part of w.split(",")) {
      const n = Number.parseInt(part.replace(/^#/, ""), 10);
      if (Number.isFinite(n) && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** Leading axis words become axes; the rest is the focus text. */
function splitAxesAndFocus(words: string[]): { axes: ExpandAxis[]; focus: string } {
  const axes: ExpandAxis[] = [];
  let i = 0;
  while (i < words.length && isExpandAxis(words[i]!.toLowerCase())) {
    const a = words[i]!.toLowerCase() as ExpandAxis;
    if (!axes.includes(a)) axes.push(a);
    i += 1;
  }
  return { axes: axes.length > 0 ? axes : [...EXPAND_AXES], focus: words.slice(i).join(" ") };
}

export default function (pi: ExtensionAPI) {
  registerGateReset(pi);
  let configCache: ExpandConfig | null = null;
  let ledger: Ledger = emptyLedger();
  let task: TaskState = idleTask();
  /** Set by commands/modifiers right before they send a prompt: keep `task` through the next before_agent_start. */
  let taskArmed = false;
  let resetOnNextStart = false;
  let editSerial = 0;
  let cwdForOnce = "";

  function idleTask(): TaskState {
    return { mode: "idle", axes: [...EXPAND_AXES], focus: "", autoBudget: null, building: [], fitDone: 0, editSerialAtFit: -1, changedFiles: new Set(), warned: new Set() };
  }

  function cfg(ctx: ExtensionContext): ExpandConfig {
    if (!configCache) configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  function reload(ctx: ExtensionContext) {
    ledger = loadLedger(ctx.cwd, cfg(ctx).ledgerPath);
  }

  function save(ctx: ExtensionContext) {
    saveLedger(ctx.cwd, cfg(ctx).ledgerPath, ledger);
  }

  function notify(ctx: ExtensionContext, msg: string, kind: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(msg, kind);
  }

  function warnOnce(ctx: ExtensionContext, key: string, msg: string) {
    if (task.warned.has(key)) return;
    task.warned.add(key);
    notify(ctx, msg, "warning");
  }

  function arm(next: Partial<TaskState> & { mode: Mode }) {
    task = { ...idleTask(), ...next };
    taskArmed = true;
  }

  // ---------- visibility ----------

  function buildingIdeas(): Idea[] {
    return task.building.map((n) => findIdea(ledger, n)).filter((i): i is Idea => Boolean(i));
  }

  function showState(ctx: ExtensionContext, detail?: string) {
    if (!ctx.hasUI) return;
    if (task.mode === "idle") {
      ctx.ui.setStatus("expand", undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const fitCap = cfg(ctx).fitPasses;
    if (task.mode === "build") {
      const ideas = buildingIdeas();
      ctx.ui.setStatus("expand", `expand: building ${ideas.map((i) => `#${i.n}`).join(" ")} · fit ${task.fitDone}/${fitCap}`);
      ctx.ui.setWidget(WIDGET_KEY, [
        `Expand · building ${ideas.length} idea${ideas.length === 1 ? "" : "s"} · fit check ${task.fitDone}/${fitCap}${detail ? ` · ${detail}` : ""}`,
        ...ideas.map((i) => `  #${i.n} ${i.title} [${i.axis}/${i.size}]`),
      ]);
      return;
    }
    const label = task.mode === "map" ? "mapping the project" : `ideas (${task.axes.join(", ")})${task.autoBudget !== null ? ` · auto ${task.autoBudget}` : ""}`;
    ctx.ui.setStatus("expand", `expand: ${label}`);
    ctx.ui.setWidget(WIDGET_KEY, [`Expand · ${label}${detail ? ` · ${detail}` : ""}`]);
  }

  function finish(ctx: ExtensionContext, msg?: string) {
    task = idleTask();
    showState(ctx);
    if (msg) notify(ctx, msg);
  }

  // ---------- /once modifiers ----------

  function onceIdeas(axes: ExpandAxis[], name: string, description: string) {
    registerOnceModifier({
      name,
      description,
      owner: "expand",
      apply: () => {
        arm({ mode: "ideas", axes });
      },
      transform: (prompt) => {
        if (cwdForOnce) ledger = loadLedger(cwdForOnce, loadConfig(cwdForOnce).ledgerPath);
        task.focus = prompt;
        return buildIdeasPrompt({ ledger, axes, focus: prompt, count: loadConfig(cwdForOnce || process.cwd()).ideasPerPass, autoBudget: null });
      },
    });
  }
  for (const axis of EXPAND_AXES) onceIdeas([axis], axis, `Expand ideas, ${axis}: ${AXIS_DESCRIPTIONS[axis]}`);
  onceIdeas([...EXPAND_AXES], "expand", "Expand ideas on every axis; the prompt is the focus.");

  // ---------- session ----------

  pi.on("session_start", async (_event, ctx) => {
    configCache = null;
    cwdForOnce = ctx.cwd;
    if (!cfg(ctx).enabled) return;
    reload(ctx);
    const inProgress = ledger.ideas.filter((i) => i.status === "picked" || i.status === "building");
    if (ctx.hasUI && inProgress.length > 0) {
      ctx.ui.notify(`Expand: ${inProgress.length} idea(s) still in progress — ${inProgress.map((i) => `#${i.n} ${i.title}`).join(", ")}. /expand status.`, "info");
    }
  });

  pi.on("input", async (event) => {
    if (event.source !== "extension") resetOnNextStart = true;
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    resetGateClaim();
    configCache = null;
    cwdForOnce = ctx.cwd;
    if (!cfg(ctx).enabled) return;
    reload(ctx);

    if (taskArmed) {
      taskArmed = false;
      resetOnNextStart = false;
    } else if (resetOnNextStart) {
      resetOnNextStart = false;
      if (task.mode !== "idle") {
        const left = buildingIdeas();
        task = idleTask();
        if (left.length > 0) notify(ctx, `Expand: new prompt — leaving #${left.map((i) => i.n).join(", #")} marked "building". /expand done <n> or /expand build <n> to resume.`);
      }
    }
    showState(ctx);
    if (task.mode === "idle" || task.mode === "map") return;

    const procedure = buildExpandProcedure({
      ledger,
      mode: task.mode === "ideas" ? "ideas" : "build",
      axes: task.axes,
      focus: task.focus,
      building: buildingIdeas(),
    });
    return { systemPrompt: `${event.systemPrompt}\n\n${procedure}` };
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!isEditTool(event.toolName) || event.isError) return;
    const p = extractEditPath(event.input);
    if (!p) return;
    editSerial += 1;
    if (task.mode === "build") task.changedFiles.add(p);
  });

  // ---------- the gate: fit check after a build ----------

  pi.on("agent_end", async (_event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || task.mode !== "build" || task.building.length === 0) return;
    if (isGateClaimed()) return; // verify/scenarios/polish has the follow-up this turn
    if (ctx.signal?.aborted) return;
    reload(ctx);
    const ideas = buildingIdeas();
    if (ideas.length === 0) {
      finish(ctx);
      return;
    }

    const wantsFit = task.fitDone < config.fitPasses && task.changedFiles.size > 0 && task.editSerialAtFit !== editSerial;
    if (!wantsFit) {
      for (const i of ideas) setIdeaStatus(i, "done", task.fitDone > 0 ? `fit-checked ${task.fitDone}x` : undefined);
      save(ctx);
      const open = ledger.ideas.filter((i) => i.status === "proposed").length;
      finish(ctx, `Expand: done — #${ideas.map((i) => i.n).join(", #")} built${task.fitDone > 0 ? " and fit-checked" : ""}. ${open > 0 ? `${open} idea(s) still on the table: /expand status.` : "/expand ideas for more."}`);
      return;
    }

    await withGateWorkingMessage(ctx, "Expand fit check — inference idle", async () => {
      task.fitDone += 1;
      task.editSerialAtFit = editSerial;
      const passNumber = task.fitDone;
      showState(ctx, "reviewing fit");

      // Independent critic when configured (text-only is fine — it reads the changed files).
      const critic = resolveFitCritic(ctx, config.criticModel);
      if (critic.model) {
        const files = readChangedFiles(ctx);
        const criticName = `${critic.model.provider}/${critic.model.id}`;
        const allFindings: Array<{ idea: Idea; findings: string[] }> = [];
        let failed = false;
        for (const idea of ideas.slice(0, 3)) {
          const prompts = buildExternalFitPrompts({ idea, ledger, files });
          const reply = await runCriticCompletion(ctx, critic.model, prompts.system, prompts.user, [], ctx.signal);
          if (ctx.signal?.aborted) return;
          if (!reply.ok) {
            warnOnce(ctx, "critic-fail", `Expand: critic ${criticName} failed (${firstLine(reply.error)}). Session model reviews fit this pass.`);
            failed = true;
            break;
          }
          const parsed = parseFitReply(reply.text);
          if (parsed.unparsed) {
            warnOnce(ctx, "critic-parse", `Expand: critic ${criticName} replied in an unexpected format. Session model reviews fit this pass.`);
            failed = true;
            break;
          }
          if (!parsed.none) allFindings.push({ idea, findings: parsed.findings });
        }
        if (!failed) {
          if (allFindings.length === 0) {
            for (const i of ideas) setIdeaStatus(i, "done", `fit-checked by ${criticName}: fits`);
            save(ctx);
            finish(ctx, `Expand: critic ${criticName} found no fit problems. #${ideas.map((i) => i.n).join(", #")} done.`);
            return;
          }
          for (const f of allFindings) setIdeaStatus(f.idea, "building", `fit ${passNumber}: ${f.findings.join(" | ")}`);
          save(ctx);
          if (!tryClaimGate("expand")) return;
          showState(ctx, `fixing ${allFindings.reduce((n, f) => n + f.findings.length, 0)} finding(s)`);
          notify(ctx, `Expand fit check ${passNumber}/${config.fitPasses}: critic named ${allFindings.reduce((n, f) => n + f.findings.length, 0)} finding(s). Model is fixing them.`);
          const text = allFindings.map((f) => buildExternalFixPrompt(f.idea, f.findings, criticName, passNumber, config.fitPasses)).join("\n\n");
          pi.sendUserMessage(text, { deliverAs: "followUp" });
          return;
        }
      } else if (config.criticModel) {
        warnOnce(ctx, "critic-model", `Expand: ${critic.reason}. Session model reviews fit. Set one with /expand critic <provider/model>.`);
      }

      if (!tryClaimGate("expand")) return;
      showState(ctx, "asking the model for fit findings");
      notify(ctx, `Expand fit check ${passNumber}/${config.fitPasses}: asking the model whether #${ideas.map((i) => i.n).join(", #")} is reachable, explained, integrated and sane.`);
      pi.sendUserMessage(buildSelfFitPrompt(ideas, ledger, passNumber, config.fitPasses), { deliverAs: "followUp" });
    });
  });

  function resolveFitCritic(ctx: ExtensionContext, spec: string): { model: NonNullable<ExtensionContext["model"]> | null; reason?: string } {
    const trimmed = spec.trim();
    if (!trimmed) return { model: null, reason: "no criticModel configured" };
    const slash = trimmed.indexOf("/");
    if (slash <= 0) return { model: null, reason: `criticModel must be "provider/modelId", got "${trimmed}"` };
    const model = ctx.modelRegistry.find(trimmed.slice(0, slash), trimmed.slice(slash + 1));
    if (!model) return { model: null, reason: `critic model ${trimmed} not found in models.json` };
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { model: null, reason: `critic model ${trimmed} has no auth configured` };
    return { model };
  }

  function readChangedFiles(ctx: ExtensionContext): Array<{ path: string; content: string }> {
    const out: Array<{ path: string; content: string }> = [];
    let total = 0;
    for (const p of task.changedFiles) {
      const abs = path.isAbsolute(p) ? p : path.join(ctx.cwd, p);
      try {
        if (!fs.existsSync(abs)) continue;
        let content = fs.readFileSync(abs, "utf8");
        if (content.length > MAX_CRITIC_FILE_CHARS) content = `${content.slice(0, MAX_CRITIC_FILE_CHARS)}\n… (truncated)`;
        if (total + content.length > MAX_CRITIC_TOTAL_CHARS) break;
        total += content.length;
        out.push({ path: path.relative(ctx.cwd, abs).replace(/\\/g, "/"), content });
      } catch {
        /* unreadable — skip */
      }
    }
    return out;
  }

  // ---------- tools ----------

  const systemSchema = Type.Object({
    name: Type.String(),
    kind: Type.Union([Type.Literal("system"), Type.Literal("pool")]),
    count: Type.Optional(Type.Number({ description: "Pools only: how many entries exist." })),
    summary: Type.String({ description: "One line: what it does / what is in it." }),
    files: Type.Optional(Type.Array(Type.String())),
  });

  pi.registerTool({
    name: "expand_map",
    label: "Expand Map",
    description:
      "Record the project's systems map: systems, content pools with counts, known interactions and gaps (asymmetries, dead ends). " +
      "Feature ideas must build on entries in this map. merge: true updates counts/adds entries after a build; default replaces the map.",
    promptSnippet: "Record the systems map (systems, pools, interactions, gaps) for expand",
    parameters: Type.Object({
      systems: Type.Array(systemSchema),
      interactions: Type.Optional(Type.Array(Type.Object({ a: Type.String(), b: Type.String(), note: Type.String() }))),
      gaps: Type.Optional(Type.Array(Type.String({ description: "Concrete asymmetry or dead end, e.g. '12 weapons, 0 ranged'." }))),
      merge: Type.Optional(Type.Boolean({ description: "Update the existing map instead of replacing it." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      reload(ctx);
      const map = applyMap(ledger, params, params.merge === true);
      save(ctx);
      if (task.mode === "map") {
        showState(ctx, `${map.systems.length} systems/pools, ${map.gaps.length} gaps`);
        notify(ctx, `Expand: mapped ${map.systems.length} systems/pools, ${map.interactions.length} interactions, ${map.gaps.length} gaps. Next: /expand ideas [axis] [focus].`);
      }
      return {
        content: [{ type: "text", text: `Systems map ${params.merge ? "updated" : "recorded"} (${map.systems.length} entries, ${map.gaps.length} gaps):\n${formatMap(map)}` }],
        details: { systems: map.systems.length, gaps: map.gaps.length, merge: params.merge === true },
      };
    },
  });

  pi.registerTool({
    name: "expand_propose",
    label: "Expand Propose",
    description:
      "Propose feature ideas found by gap analysis. Each must name the existing system(s) it builds on and the gap it fills; ideas that don't are refused. " +
      "Rejected/done ideas are remembered and refused. In auto mode the tool picks the best and tells you to build them.",
    promptSnippet: "Propose expand ideas (title, axis, buildsOn, gap, size, fit, playerFacing)",
    parameters: Type.Object({
      ideas: Type.Array(
        Type.Object({
          title: Type.String({ description: "Short, specific. Not 'add a shop'." }),
          axis: Type.Union(EXPAND_AXES.map((a) => Type.Literal(a))),
          buildsOn: Type.Array(Type.String(), { description: "Existing systems/pools from the map." }),
          gap: Type.String({ description: "The asymmetry or missing piece this fills." }),
          size: Type.Union([Type.Literal("S"), Type.Literal("M"), Type.Literal("L")]),
          fit: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
          fitNote: Type.Optional(Type.String({ description: "Why it serves or strains the pillars." })),
          playerFacing: Type.Optional(Type.String({ description: "How the user sees/reaches it." })),
        }),
        { minItems: 1, maxItems: 12 },
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      reload(ctx);
      const { added, refused } = addIdeas(ledger, params.ideas);
      const lines: string[] = [];
      if (refused.length > 0) lines.push(`Refused ${refused.length}: ${refused.map((r) => `"${r.title}" (${r.why})`).join("; ")}.`);

      if (task.mode === "ideas" && task.autoBudget !== null) {
        const picked = autoPick(ledger, task.autoBudget, added);
        if (picked.length === 0) {
          save(ctx);
          lines.push("Auto mode: nothing with medium or high fit to pick. Present the list and stop.");
          lines.push(formatIdeas(ledger, ["proposed"]));
          return { content: [{ type: "text", text: lines.join("\n") }], details: { added: added.length, refused: refused.length, picked: 0 } };
        }
        for (const i of picked) setIdeaStatus(i, "building", "auto-picked");
        save(ctx);
        task.mode = "build";
        task.building = picked.map((i) => i.n);
        task.changedFiles.clear();
        task.fitDone = 0;
        showState(ctx);
        notify(ctx, `Expand auto: building ${picked.map((i) => `#${i.n} ${i.title}`).join(", ")}. Fit check follows. Esc stops it.`);
        lines.push(`Recorded ${added.length} idea(s). AUTO-PICKED ${picked.map((i) => `#${i.n}`).join(", ")} — build them now:`, "", buildBuildPrompt(picked, ledger));
        return { content: [{ type: "text", text: lines.join("\n") }], details: { added: added.length, refused: refused.length, picked: picked.length } };
      }

      save(ctx);
      showState(ctx, `${added.length} idea(s) on the table`);
      notify(ctx, `Expand: ${added.length} idea(s) proposed${refused.length > 0 ? `, ${refused.length} refused as generic/repeat` : ""}. Pick: /expand build <n> · reject: /expand reject <n> · or /expand auto <n>.`);
      lines.push(`Recorded ${added.length} idea(s):`, formatIdeas(ledger, ["proposed"]), "", "Now STOP: show the user this numbered list and how to pick. Write no code.");
      return { content: [{ type: "text", text: lines.join("\n") }], details: { added: added.length, refused: refused.length, picked: 0 } };
    },
  });

  pi.registerTool({
    name: "expand_fit",
    label: "Expand Fit",
    description: "Record fit findings for a built idea during a fit check, BEFORE fixing them. Empty list = it genuinely fits.",
    promptSnippet: "Record fit-check findings (reachable, explained, integrated, sane, pillars) before fixing",
    parameters: Type.Object({
      idea: Type.Number({ description: "Idea number (#n)." }),
      findings: Type.Array(Type.String({ description: "<question> — <what is off> — <what to do>" }), { maxItems: 3 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      reload(ctx);
      const idea = findIdea(ledger, params.idea);
      if (!idea) return { content: [{ type: "text", text: `No idea #${params.idea}.` }], details: { idea: params.idea }, isError: true };
      const findings = params.findings.map((f) => f.trim()).filter(Boolean);
      setIdeaStatus(idea, idea.status, findings.length > 0 ? `fit ${task.fitDone}: ${findings.join(" | ")}` : `fit ${task.fitDone}: fits`);
      save(ctx);
      showState(ctx, findings.length > 0 ? `fixing ${findings.length} finding(s) on #${idea.n}` : `#${idea.n} fits`);
      notify(ctx, findings.length > 0 ? `Expand fit: #${idea.n} — ${findings.length} finding(s). Model is fixing them.` : `Expand fit: #${idea.n} holds up.`);
      const text =
        findings.length > 0
          ? `Recorded ${findings.length} finding(s) for #${idea.n}. Now fix each — write "Fixing: <finding>" before each edit — then finish normally.`
          : `Recorded: #${idea.n} fits. Nothing to fix for it.`;
      return { content: [{ type: "text", text }], details: { idea: idea.n, findings: findings.length } };
    },
  });

  // ---------- /expand ----------

  function send(ctx: ExtensionContext, text: string) {
    if (ctx.isIdle()) pi.sendUserMessage(text);
    else pi.sendUserMessage(text, { deliverAs: "followUp" });
  }

  pi.registerCommand("expand", {
    description: "Take the project further: map · pillars · ideas [axis] [focus] · build <n> · auto <n> · reject <n> · status",
    getArgumentCompletions: (prefix: string) => {
      const words = prefix.split(/\s+/);
      if (words.length <= 1) {
        const items = ["map", "pillars", "ideas", "build", "auto", "reject", "done", "status", "critic", "clear"].map((v) => ({ value: v, label: v }));
        const f = items.filter((i) => i.value.startsWith(prefix.toLowerCase()));
        return f.length > 0 ? f : null;
      }
      if (words[0] === "ideas" || words[0] === "auto") {
        const cur = words[words.length - 1] ?? "";
        const f = EXPAND_AXES.filter((a) => a.startsWith(cur.toLowerCase())).map((a) => ({ value: [...words.slice(0, -1), a].join(" "), label: a, description: AXIS_DESCRIPTIONS[a] }));
        return f.length > 0 ? f : null;
      }
      return null;
    },
    handler: async (args, ctx) => {
      configCache = null;
      const config = cfg(ctx);
      reload(ctx);
      const words = args.trim().split(/\s+/).filter(Boolean);
      const sub = (words.shift() ?? "").toLowerCase();

      if (sub === "" || sub === "help") {
        ctx.ui.notify(
          [
            "Expand — take what exists further, by gap analysis.",
            "",
            "  /expand map                      read the code, record systems, pools, interactions, gaps",
            "  /expand pillars <a; b; c>        set 2–4 design pillars ideas are judged against",
            "  /expand ideas [axis..] [focus]   propose ideas, then you pick",
            "  /expand build <n> [<n> ...]      build picked ideas (spec → scenarios → code → fit check)",
            `  /expand auto <n> [axis..] [focus]  propose and build the top n by fit (max ${config.autoMax}), no questions`,
            "  /expand reject <n> ...           never propose again",
            "  /expand done <n> ...             mark built by hand",
            "  /expand status · critic [model] · clear",
            "  /once <axis> <focus>             one-shot ideas pass on one axis",
            "",
            "Axes:",
            ...EXPAND_AXES.map((a) => `  ${a.padEnd(8)} ${AXIS_DESCRIPTIONS[a]}`),
            "",
            formatLedgerSummary(ledger),
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "map") {
        arm({ mode: "map" });
        showState(ctx, "reading the code");
        send(ctx, buildMapPrompt(ledger));
        return;
      }

      if (sub === "pillars") {
        const text = words.join(" ");
        if (!text) {
          ctx.ui.notify(ledger.pillars.length > 0 ? `Pillars:\n${ledger.pillars.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}` : "No pillars set. /expand pillars fast runs; build variety; readable danger", "info");
          return;
        }
        const pillars = parsePillars(text);
        if (pillars.length === 0) {
          ctx.ui.notify("Separate pillars with ; or |", "warning");
          return;
        }
        ledger.pillars = pillars;
        save(ctx);
        ctx.ui.notify(`Pillars set (${pillars.length}):\n${pillars.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}`, "info");
        return;
      }

      if (sub === "ideas") {
        const { axes, focus } = splitAxesAndFocus(words);
        if (ledger.pillars.length === 0) warnOnce(ctx, "pillars", "Expand: no pillars set — ideas will be judged against what the code implies. Better: /expand pillars <a; b; c>.");
        arm({ mode: "ideas", axes, focus });
        showState(ctx);
        send(ctx, buildIdeasPrompt({ ledger, axes, focus, count: config.ideasPerPass, autoBudget: null }));
        return;
      }

      if (sub === "auto") {
        const n = Math.min(config.autoMax, Math.max(1, Number.parseInt(words[0] ?? "", 10) || 1));
        if (Number.isFinite(Number.parseInt(words[0] ?? "", 10))) words.shift();
        const { axes, focus } = splitAxesAndFocus(words);
        const ready = autoPick(ledger, n);
        if (ready.length >= n) {
          for (const i of ready) setIdeaStatus(i, "building", "auto-picked");
          save(ctx);
          arm({ mode: "build", building: ready.map((i) => i.n) });
          showState(ctx);
          ctx.ui.notify(`Expand auto: building ${ready.map((i) => `#${i.n} ${i.title}`).join(", ")} from the ideas already on the table. Fit check follows. Esc stops it.`, "info");
          send(ctx, buildBuildPrompt(ready, ledger));
          return;
        }
        arm({ mode: "ideas", axes, focus, autoBudget: n });
        showState(ctx);
        ctx.ui.notify(`Expand auto: proposing ideas, then building the top ${n} by fit without asking. Esc stops it.`, "info");
        send(ctx, buildIdeasPrompt({ ledger, axes, focus, count: config.ideasPerPass, autoBudget: n }));
        return;
      }

      if (sub === "build") {
        const ns = parseNumbers(words);
        const ideas = ns.map((n) => findIdea(ledger, n)).filter((i): i is Idea => Boolean(i));
        const missing = ns.filter((n) => !ideas.some((i) => i.n === n));
        if (ideas.length === 0) {
          ctx.ui.notify(`Nothing to build${missing.length > 0 ? ` — no idea #${missing.join(", #")}` : ""}.\n${formatIdeas(ledger)}`, "warning");
          return;
        }
        const closed = ideas.filter((i) => i.status === "done" || i.status === "rejected");
        if (closed.length > 0) {
          ctx.ui.notify(`#${closed.map((i) => i.n).join(", #")} already ${closed.map((i) => i.status).join("/")}. Reopen by proposing again.`, "warning");
          return;
        }
        for (const i of ideas) setIdeaStatus(i, "building", "picked by user");
        save(ctx);
        arm({ mode: "build", building: ideas.map((i) => i.n) });
        showState(ctx);
        if (missing.length > 0) ctx.ui.notify(`No idea #${missing.join(", #")} — skipped.`, "warning");
        send(ctx, buildBuildPrompt(ideas, ledger));
        return;
      }

      if (sub === "reject" || sub === "done") {
        const ns = parseNumbers(words);
        const hit: Idea[] = [];
        for (const n of ns) {
          const i = findIdea(ledger, n);
          if (!i) continue;
          setIdeaStatus(i, sub === "reject" ? "rejected" : "done", sub === "reject" ? "rejected by user" : "marked done by user");
          hit.push(i);
          const idx = task.building.indexOf(i.n);
          if (idx >= 0) task.building.splice(idx, 1);
        }
        save(ctx);
        if (task.mode === "build" && task.building.length === 0) finish(ctx);
        ctx.ui.notify(hit.length > 0 ? `${sub === "reject" ? "Rejected" : "Done"}: ${hit.map((i) => `#${i.n} ${i.title}`).join(", ")}.` : `No such idea${ns.length > 0 ? ` #${ns.join(", #")}` : ""}.`, hit.length > 0 ? "info" : "warning");
        return;
      }

      if (sub === "status") {
        const t =
          task.mode === "idle"
            ? "No expand task running."
            : task.mode === "build"
              ? `Task: building #${task.building.join(", #")} · fit ${task.fitDone}/${config.fitPasses} · ${task.changedFiles.size} file(s) changed`
              : `Task: ${task.mode}${task.mode === "ideas" ? ` (${task.axes.join(", ")}${task.focus ? ` · "${task.focus}"` : ""})` : ""}`;
        ctx.ui.notify(
          [t, "", formatLedgerSummary(ledger), "", "Systems map:", formatMap(ledger.map), "", "Ideas on the table / in progress:", formatIdeas(ledger), "", "Done:", formatIdeas(ledger, ["done"]), "", "Rejected:", ledger.ideas.filter((i) => i.status === "rejected").map((i) => `  #${i.n} ${i.title}`).join("\n") || "  (none)"].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "critic") {
        const arg = words[0] ?? "";
        const scope = words[1]?.toLowerCase() === "project" ? "project" : "user";
        if (arg === "") {
          const cur = config.criticModel ? resolveFitCritic(ctx, config.criticModel) : null;
          ctx.ui.notify(
            [
              `Fit critic: ${config.criticModel || "(none — session model reviews its own work)"}${cur && !cur.model ? ` — ${cur.reason}` : ""}`,
              "Any model with auth works (it reads the changed files; no screenshot needed).",
              "Set: /expand critic <provider/model> [project]   Clear: /expand critic off",
            ].join("\n"),
            "info",
          );
          return;
        }
        if (arg === "off") {
          const file = persistCriticModel(ctx.cwd, "", scope);
          configCache = null;
          ctx.ui.notify(`Fit critic cleared (${scope}) → ${file}`, "info");
          return;
        }
        const res = resolveFitCritic(ctx, arg);
        if (!res.model) {
          ctx.ui.notify(`Not set: ${res.reason}`, "error");
          return;
        }
        const file = persistCriticModel(ctx.cwd, arg, scope);
        configCache = null;
        ctx.ui.notify(`Fit critic ${arg} saved (${scope}) → ${file}.`, "info");
        return;
      }

      if (sub === "clear") {
        const ok = ctx.hasUI ? await ctx.ui.confirm("Clear expand ledger", `Forget the systems map, pillars and all ${ledger.ideas.length} idea(s)?`) : true;
        if (!ok) return;
        ledger = emptyLedger();
        save(ctx);
        finish(ctx, "Expand ledger cleared.");
        return;
      }

      ctx.ui.notify(`Unknown: /expand ${args}. Try /expand for help.`, "warning");
    },
  });
}
