import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  LEVEL_DESCRIPTIONS,
  POLISH_LEVELS,
  isPolishSetting,
  levelAtLeast,
  loadConfig,
  persistCriticModel,
  persistLevel,
  type PolishConfig,
  type PolishLevel,
  type PolishSetting,
} from "./config";
import { inferLevel, isVagueImprovePrompt, parseLevelPrefix } from "./infer";
import {
  addSurfaceFiles,
  emptyInventory,
  findSurface,
  formatInventory,
  loadInventory,
  markPolished,
  pickNextSurface,
  recordWeaknesses,
  reopenSurface,
  saveInventory,
  seedFromScenarios,
  surfacesMentioned,
  surfacesTouchingFiles,
  upsertSurface,
  type Inventory,
  type OpenWeakness,
  type Surface,
} from "./inventory";
import {
  buildExternalCriticPrompts,
  buildExternalFixPrompt,
  buildPolishProcedure,
  buildSelfCritiquePrompt,
  parseCriticReply,
} from "./procedure";
import { listVisionModels, resolveCriticModel, runCriticCompletion } from "./critic";
import { presentVisionToSession } from "../shared/vision-relay";
import { loadConfig as loadScenariosConfig } from "../scenarios/config";
import { capturePageScreenshot, loadVisionImages, type VisionImageContent } from "../scenarios/vision";
import { isGateClaimed, resetGateClaim, tryClaimGate, registerGateReset } from "../shared/gate-orchestrator";
import { extractEditPath, isEditTool } from "../shared/edit-tools";
import { registerOnceModifier } from "../shared/once";
import { detectStacks, isWebPath } from "../shared/stack-detect";
import { withGateWorkingMessage } from "../shared/working-status";
import { syncOwnedTools } from "../shared/tool-activation";

const STATE_TYPE = "foundation-polish-state";
const WIDGET_KEY = "polish";
const TOOLS = ["polish_report", "polish_surfaces"];

interface PersistedState {
  sessionLevel?: PolishSetting | null;
  changedUiFiles?: string[];
}

/** Per-user-prompt bookkeeping. Reset whenever a real (non-extension) prompt arrives. */
interface TaskState {
  level: PolishLevel;
  source: "once" | "session" | "config" | "auto";
  reason: string;
  /** "make it look good" — every surface is fair game. */
  vague: boolean;
  /** Surface ids named in the prompt. */
  mentioned: string[];
  /** Surface ids created during this task. */
  created: string[];
  /** Surface ids the model declared via polish_surfaces focus. */
  focus: string[];
  passesBySurface: Record<string, number>;
  editSerialAtPass: Record<string, number>;
  /** Surfaces that will get no more passes this task (cap reached, stopped, or exhausted). */
  stopped: Set<string>;
  /** Surface currently being fixed — edits during the pass are attributed to it. */
  activeSurface: string | null;
  /** Surface id whose self-critique pass is waiting for polish_report. */
  awaitingReport: string | null;
  reopened: string[];
  warned: Set<string>;
  plannedNotice: boolean;
  skippedNotice: boolean;
}

/** UI source files only — never specs, tests, or anything under .pi/. */
function isPolishableUiFile(p: string): boolean {
  const n = p.replace(/\\/g, "/").toLowerCase();
  if (n.includes("/.pi/") || n.startsWith(".pi/")) return false;
  if (/\.(test|spec)\.[a-z]+$/.test(n)) return false;
  if (/(^|\/)(node_modules|dist|build)\//.test(n)) return false;
  return isWebPath(n);
}

function firstLine(s: string | undefined): string {
  return (s ?? "").split(/\r?\n/)[0]?.slice(0, 160) ?? "";
}

function shorten(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export default function (pi: ExtensionAPI) {
  registerGateReset(pi);
  let configCache: PolishConfig | null = null;
  let sessionLevel: PolishSetting | null = null;
  let promptLevel: PolishLevel | null = null;
  let newUserPrompt = false;
  let lastAnnounced: string | null = null;
  let editSerial = 0;
  const changedUiFiles = new Set<string>();
  let inventory: Inventory = emptyInventory();
  let task: TaskState | null = null;

  // /once <level> <prompt> — armed here, consumed by the next before_agent_start.
  for (const level of POLISH_LEVELS) {
    registerOnceModifier({
      name: level,
      description: `Polish ${level}: ${LEVEL_DESCRIPTIONS[level]}`,
      owner: "polish",
      apply: () => {
        promptLevel = level;
        newUserPrompt = true;
      },
    });
  }

  function cfg(ctx: ExtensionContext): PolishConfig {
    if (!configCache) configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  function persist() {
    pi.appendEntry<PersistedState>(STATE_TYPE, { sessionLevel, changedUiFiles: [...changedUiFiles] });
  }

  function notify(ctx: ExtensionContext, msg: string, kind: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(msg, kind);
  }

  function warnOnce(ctx: ExtensionContext, key: string, msg: string) {
    if (!task || task.warned.has(key)) return;
    task.warned.add(key);
    notify(ctx, msg, "warning");
  }

  function reloadInventory(ctx: ExtensionContext) {
    inventory = loadInventory(ctx.cwd, cfg(ctx).inventoryPath);
  }

  function save(ctx: ExtensionContext) {
    saveInventory(ctx.cwd, cfg(ctx).inventoryPath, inventory);
  }

  function freshTask(level: PolishLevel, source: TaskState["source"], reason: string): TaskState {
    return {
      level,
      source,
      reason,
      vague: false,
      mentioned: [],
      created: [],
      focus: [],
      passesBySurface: {},
      editSerialAtPass: {},
      stopped: new Set(),
      activeSurface: null,
      awaitingReport: null,
      reopened: [],
      warned: new Set(),
      plannedNotice: false,
      skippedNotice: false,
    };
  }

  // ---------- visibility ----------

  function setStatus(ctx: ExtensionContext, detail?: string) {
    if (!ctx.hasUI) return;
    if (!task || !cfg(ctx).enabled) {
      ctx.ui.setStatus("polish", undefined);
      return;
    }
    const base = `polish: ${task.level}${task.source === "auto" ? " (auto)" : task.source === "once" ? " (once)" : ""}`;
    ctx.ui.setStatus("polish", detail ? `${base} · ${detail}` : base);
  }

  function setWidget(ctx: ExtensionContext, lines: string[] | undefined) {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET_KEY, lines);
  }

  /** Widget + footer for a pass in progress. */
  function showPass(ctx: ExtensionContext, surface: Surface, passNumber: number, cap: number, weaknesses: OpenWeakness[] | null, scopeSize: number) {
    const head = `Polish · ${task?.level} · pass ${passNumber}/${cap} on "${surface.name}" · ${scopeSize} surface${scopeSize === 1 ? "" : "s"} in scope`;
    const body =
      weaknesses === null
        ? "  waiting for the model to name the three weakest things (polish_report)"
        : weaknesses.length === 0
          ? "  nothing weak found"
          : weaknesses.map((w) => `  fixing: ${shorten(w.text, 90)}${w.namings > 1 ? ` (${w.namings}x)` : ""}`).join("\n");
    setWidget(ctx, [head, body]);
    setStatus(ctx, `${passNumber}/${cap} ${surface.name}`);
  }

  function clearPassDisplay(ctx: ExtensionContext) {
    setWidget(ctx, undefined);
    setStatus(ctx);
  }

  // ---------- scope ----------

  /** Resolve the level for a new task: /once > session override > config; "auto" infers. */
  function resolveLevel(ctx: ExtensionContext, prompt: string): TaskState {
    const config = cfg(ctx);
    if (promptLevel) {
      const t = freshTask(promptLevel, "once", "/once for this prompt");
      promptLevel = null;
      return t;
    }
    const setting = sessionLevel ?? config.level;
    const source: TaskState["source"] = sessionLevel ? "session" : "config";
    if (setting !== "auto") return freshTask(setting, source, `${source} setting`);
    const inferred = inferLevel(prompt, detectStacks(ctx.cwd).hasWebUi);
    return freshTask(inferred.level, "auto", inferred.reason);
  }

  /** undefined = everything (vague request); otherwise the in-scope surface ids. */
  function computeScope(): Set<string> | undefined {
    if (!task || task.vague) return undefined;
    const ids = new Set<string>([...task.mentioned, ...task.created, ...task.focus]);
    for (const s of surfacesTouchingFiles(inventory, changedUiFiles)) ids.add(s.id);
    return ids;
  }

  function scopeNames(scope: Set<string> | undefined): string[] {
    if (!scope) return inventory.surfaces.map((s) => s.name);
    return inventory.surfaces.filter((s) => scope.has(s.id)).map((s) => s.name);
  }

  // ---------- session ----------

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) {
        const data = entry.data as PersistedState | undefined;
        sessionLevel = data?.sessionLevel ?? null;
        changedUiFiles.clear();
        for (const f of data?.changedUiFiles ?? []) changedUiFiles.add(f);
      }
    }
    configCache = null;
    if (!cfg(ctx).enabled) return;
    reloadInventory(ctx);
    if (ctx.hasUI && inventory.surfaces.length > 0) {
      const raw = inventory.surfaces.filter((s) => s.status === "raw").length;
      const polished = inventory.surfaces.length - raw;
      ctx.ui.notify(`Polish inventory: ${polished} polished · ${raw} raw. /polish status for detail.`, "info");
    }
  });

  /**
   * Polish tools only while polish can run. `newPrompt` is the text of a fresh user
   * prompt (its level is not resolved yet — infer it the same way before_agent_start
   * will); follow-ups keep the current task's level.
   */
  function syncTools(ctx: ExtensionContext, newPrompt?: string) {
    const config = cfg(ctx);
    let level: PolishSetting = newPrompt === undefined && task ? task.level : (promptLevel ?? sessionLevel ?? config.level);
    if (level === "auto" && newPrompt !== undefined) level = inferLevel(newPrompt, detectStacks(ctx.cwd).hasWebUi).level;
    syncOwnedTools(pi, TOOLS, config.enabled && level !== "off" ? TOOLS : []);
  }

  // Real user input starts a new task. (/once arrives as extension input with the flags already armed.)
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      syncTools(ctx, newUserPrompt ? event.text : undefined);
      return { action: "continue" as const };
    }
    newUserPrompt = true;
    configCache = null;
    const parsed = parseLevelPrefix(event.text);
    if (parsed) promptLevel = parsed.level;
    syncTools(ctx, parsed ? parsed.text : event.text);
    if (parsed) return { action: "transform" as const, text: parsed.text };
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    resetGateClaim();
    configCache = null;
    const config = cfg(ctx);
    if (!config.enabled) {
      setStatus(ctx);
      return;
    }
    reloadInventory(ctx);

    const isNewTask = newUserPrompt || task === null;
    newUserPrompt = false;
    if (isNewTask) {
      task = resolveLevel(ctx, event.prompt);
      task.vague = isVagueImprovePrompt(event.prompt);
      task.mentioned = surfacesMentioned(inventory, event.prompt).map((s) => s.id);
      clearPassDisplay(ctx);

      if (task.source === "auto" && config.announceAuto) {
        const key = `${task.level}|${task.reason}`;
        if (key !== lastAnnounced) {
          lastAnnounced = key;
          const hint = task.level === "off" ? " To polish anyway: /once standard <prompt>." : " Change: /polish <level>, or /once <level> <prompt>.";
          notify(ctx, `Polish: auto → ${task.level} (${task.reason}).${hint}`);
        }
      }

      // Vague request naming polished surfaces → reopen them. Vague with nothing raw left → revisit everything.
      if (task.level !== "off" && task.vague) {
        let targets = inventory.surfaces.filter((s) => task!.mentioned.includes(s.id) && s.status === "polished");
        const anyRaw = inventory.surfaces.some((s) => s.status === "raw");
        if (targets.length === 0 && task.mentioned.length === 0 && !anyRaw) {
          targets = inventory.surfaces.filter((s) => s.status === "polished");
        }
        for (const s of targets) {
          reopenSurface(s, "reopened by user request");
          task.reopened.push(s.id);
        }
        if (targets.length > 0) {
          save(ctx);
          notify(ctx, `Polish: reopened ${targets.map((s) => s.name).join(", ")} for another look.`);
        }
      }
    }
    setStatus(ctx);

    if (!task || task.level === "off") return;

    const scope = computeScope();
    const procedure = buildPolishProcedure({
      level: task.level,
      passes: config.passes[task.level],
      inventoryText: formatInventory(inventory),
      hasResearchTools: pi.getActiveTools().includes("web_search"),
      reopened: inventory.surfaces.filter((s) => task!.reopened.includes(s.id)),
      vague: task.vague,
      scopeNames: scope ? scopeNames(scope) : [],
    });
    return { systemPrompt: `${event.systemPrompt}\n\n${procedure}` };
  });

  pi.on("tool_result", async (event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled) return;

    if (isEditTool(event.toolName)) {
      const p = extractEditPath(event.input);
      if (!p || event.isError) return;
      editSerial += 1;
      if (!isPolishableUiFile(p)) return;
      if (!changedUiFiles.has(p)) {
        changedUiFiles.add(p);
        persist();
      }
      // Edits made while fixing a surface belong to that surface — this is how scope learns.
      if (task?.activeSurface) {
        const s = inventory.surfaces.find((x) => x.id === task!.activeSurface);
        if (s) {
          addSurfaceFiles(s, [p]);
          save(ctx);
        }
      }
      return;
    }

    // define_scenarios already lists every user-visible web flow — that is the inventory.
    if (event.toolName === "define_scenarios" && !event.isError) {
      const input = event.input as { scenarios?: unknown } | undefined;
      if (Array.isArray(input?.scenarios)) {
        reloadInventory(ctx);
        const { added, touched } = seedFromScenarios(inventory, input.scenarios as Array<{ title?: unknown; kind?: unknown; testFile?: unknown }>);
        if (task) {
          for (const s of added) task.created.push(s.id);
          // Scenarios (re)defined in this task are what the task is about.
          for (const s of touched) if (!task.focus.includes(s.id)) task.focus.push(s.id);
        }
        if (touched.length > 0) save(ctx);
      }
    }
  });

  // ---------- the gate ----------

  pi.on("agent_end", async (_event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || !task) return;
    const level = task.level;
    const cap = config.passes[level];
    if (cap === 0) {
      if (changedUiFiles.size > 0) {
        changedUiFiles.clear();
        persist();
      }
      return;
    }
    if (changedUiFiles.size === 0) return;
    if (isGateClaimed()) return; // verify/scenarios/QA is red or waiting — not our turn
    if (ctx.signal?.aborted) return;

    await withGateWorkingMessage(ctx, "Polish pass — inference idle", async () => {
      reloadInventory(ctx);
      if (inventory.surfaces.length === 0) {
        const app = upsertSurface(inventory, "App", loadScenariosConfig(ctx.cwd).qaShot.urlPath || "/");
        task!.created.push(app.id);
        save(ctx);
      }

      const scope = computeScope();
      if (scope && scope.size === 0) {
        if (!task!.skippedNotice) {
          task!.skippedNotice = true;
          notify(
            ctx,
            `Polish (${level}): skipped — could not tell which surface this request was about. ` +
              `Name a surface in the prompt (see /polish status), or ask vaguely ("make it look good") to polish everything.`,
          );
        }
        finishTask(ctx, false);
        return;
      }

      const inScope = scope ? inventory.surfaces.filter((s) => scope.has(s.id)) : inventory.surfaces;
      if (!task!.plannedNotice) {
        task!.plannedNotice = true;
        const eligible = inScope.filter((s) => s.status === "raw" || level === "ultimate");
        if (eligible.length > 0) {
          notify(
            ctx,
            `Polish (${level}): up to ${cap} pass${cap === 1 ? "" : "es"} on ${eligible.length} surface${eligible.length === 1 ? "" : "s"} — ` +
              `${eligible.map((s) => s.name).join(", ")}. Each pass re-runs verify/scenarios. Esc stops it.`,
          );
        }
      }

      // One follow-up per turn: walk surfaces until one needs a pass or all are settled.
      for (let guard = 0; guard < inventory.surfaces.length + 1; guard++) {
        const surface = pickNextSurface(inventory, level, task!.stopped, scope);
        if (!surface) {
          finishTask(ctx, true);
          return;
        }
        const done = task!.passesBySurface[surface.id] ?? 0;

        if (done >= cap) {
          // Passes used up; the last critique was acted on. Honest cap: call it polished.
          if (surface.status === "raw") markPolished(surface);
          task!.stopped.add(surface.id);
          save(ctx);
          notify(ctx, `Polish: ${surface.name} — ${cap} pass${cap === 1 ? "" : "es"} done, marked polished.`);
          continue;
        }

        if (done > 0 && task!.editSerialAtPass[surface.id] === editSerial) {
          // Weaknesses were named but nothing was edited — more talk will not help.
          surface.note = `stopped: weaknesses named, no edits followed (pass ${done})`;
          task!.stopped.add(surface.id);
          save(ctx);
          notify(ctx, `Polish: ${surface.name} — weaknesses were named but no edits followed. Left raw; see /polish status.`, "warning");
          continue;
        }

        const sent = await runPass(ctx, config, surface, done + 1, cap, inScope.length);
        if (sent) return;
      }
    });
  });

  function finishTask(ctx: ExtensionContext, report: boolean) {
    changedUiFiles.clear();
    persist();
    if (task) task.activeSurface = null;
    clearPassDisplay(ctx);
    if (!report) return;
    const raw = inventory.surfaces.filter((s) => s.status === "raw");
    if (raw.length > 0) {
      notify(ctx, `Polish: done for now — ${raw.length} surface(s) still raw: ${raw.map((s) => s.name).join(", ")}.`);
    }
  }

  /**
   * One critique pass. Returns true when a follow-up was queued (turn continues),
   * false when the surface settled without one (critic said NONE, or the loop stopped).
   */
  async function runPass(
    ctx: ExtensionContext,
    config: PolishConfig,
    surface: Surface,
    passNumber: number,
    cap: number,
    scopeSize: number,
  ): Promise<boolean> {
    const scen = loadScenariosConfig(ctx.cwd);
    const shotRel = path.posix.join(config.shotDir.replace(/\\/g, "/"), `shot-${surface.id}.jpg`);
    let images: VisionImageContent[] = [];
    if (!fs.existsSync(path.join(ctx.cwd, scen.playwrightConfig))) {
      // No Playwright scaffold yet (define_scenarios creates it) — do not spawn a doomed capture.
      warnOnce(ctx, "capture", `Polish: no ${scen.playwrightConfig} — critique runs without a screenshot until scenarios scaffold it.`);
    } else {
      const capture = await capturePageScreenshot(ctx.cwd, scen, surface.urlPath, shotRel, ctx.signal);
      if (ctx.signal?.aborted) return true;
      if (capture.ok) {
        images = (await loadVisionImages([path.join(ctx.cwd, capture.outputPath)], scen)).images;
      } else {
        warnOnce(ctx, "capture", `Polish: could not capture ${surface.urlPath} (${firstLine(capture.error)}). Critique runs without a screenshot.`);
      }
    }

    const promptOpts = { surface, level: task!.level, passNumber, passCap: cap, hasScreenshot: images.length > 0, priorOpen: [...surface.open] };

    // showcase+: independent critic on a different (vision) model.
    if (levelAtLeast(task!.level, "showcase")) {
      const res = resolveCriticModel(ctx, config.criticModel);
      if (!res.model) {
        warnOnce(ctx, "critic-model", `Polish: ${res.reason}. Using the session model as critic. Set one with /polish critic <provider/model>.`);
      } else if (images.length === 0) {
        warnOnce(ctx, "critic-noshot", "Polish: no screenshot — the external critic needs one. Using the session model this pass.");
      } else {
        setWidget(ctx, [`Polish · ${task!.level} · pass ${passNumber}/${cap} on "${surface.name}"`, `  critic ${res.model.provider}/${res.model.id} is looking at the screenshot…`]);
        const prompts = buildExternalCriticPrompts(promptOpts);
        const reply = await runCriticCompletion(ctx, res.model, prompts.system, prompts.user, images, ctx.signal);
        if (ctx.signal?.aborted) return true;
        const criticName = `${res.model.provider}/${res.model.id}`;
        if (!reply.ok) {
          warnOnce(ctx, "critic-fail", `Polish: critic ${criticName} failed (${firstLine(reply.error)}). Using the session model this pass.`);
        } else {
          const parsed = parseCriticReply(reply.text);
          if (parsed.unparsed) {
            warnOnce(ctx, "critic-parse", `Polish: critic ${criticName} replied in an unexpected format. Using the session model this pass.`);
          } else {
            surface.passes += 1;
            task!.passesBySurface[surface.id] = passNumber;
            task!.editSerialAtPass[surface.id] = editSerial;
            if (parsed.none) {
              markPolished(surface);
              task!.stopped.add(surface.id);
              save(ctx);
              notify(ctx, `Polish pass ${passNumber}/${cap} — ${surface.name}: critic found nothing to improve. Marked polished.`);
              return false;
            }
            const rec = recordWeaknesses(surface, parsed.weaknesses, config.maxNamings);
            if (rec.exhausted.length > 0) {
              const w = rec.exhausted[0]!;
              surface.note = `stopped: "${w.text}" named ${w.namings}x`;
              task!.stopped.add(surface.id);
              save(ctx);
              notify(
                ctx,
                `Polish: ${surface.name} — "${w.text}" is still weak after ${w.namings} attempts. Left raw. Give a specific instruction, or accept it.`,
                "error",
              );
              return false;
            }
            save(ctx);
            if (!tryClaimGate("polish")) return true;
            task!.activeSurface = surface.id;
            showPass(ctx, surface, passNumber, cap, surface.open, scopeSize);
            notify(
              ctx,
              `Polish pass ${passNumber}/${cap} — ${surface.name}: critic named ${surface.open.length} weakness(es)` +
                (rec.repeated.length > 0 ? `, ${rec.repeated.length} repeated from last pass` : "") +
                ". Model is fixing them.",
            );
            const text = buildExternalFixPrompt({ ...promptOpts, weaknesses: surface.open, criticModel: criticName });
            const content = await presentVisionToSession(ctx, text, images, [path.join(ctx.cwd, shotRel)]);
            pi.sendUserMessage(content, { deliverAs: "followUp" });
            return true;
          }
        }
      }
    }

    // standard (or fallback): the session model critiques itself and reports via polish_report.
    surface.passes += 1;
    task!.passesBySurface[surface.id] = passNumber;
    task!.editSerialAtPass[surface.id] = editSerial;
    task!.awaitingReport = surface.id;
    save(ctx);
    if (!tryClaimGate("polish")) return true;
    task!.activeSurface = surface.id;
    showPass(ctx, surface, passNumber, cap, null, scopeSize);
    notify(ctx, `Polish pass ${passNumber}/${cap} — ${surface.name}: asking the model for the three weakest things.`);
    const text = buildSelfCritiquePrompt(promptOpts);
    if (images.length > 0) {
      const content = await presentVisionToSession(ctx, text, images, [path.join(ctx.cwd, shotRel)]);
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    } else {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
    return true;
  }

  // ---------- tools ----------

  pi.registerTool({
    name: "polish_report",
    label: "Polish Report",
    description:
      "Record the weakest things on a surface during a polish pass, BEFORE fixing them. " +
      "Pass an empty list when the surface genuinely holds up. Repeats are detected: the same weakness named again means the earlier fix did not land.",
    promptSnippet: "Record polish-pass weaknesses before fixing them",
    parameters: Type.Object({
      surface: Type.String({ description: "Surface name as listed in the polish inventory." }),
      weaknesses: Type.Array(Type.String({ description: "<element> — <what is weak> — <what it should be>" }), {
        maxItems: 3,
        description: "At most three. Empty when nothing is weak.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      reloadInventory(ctx);
      let surface = findSurface(inventory, params.surface);
      if (!surface && task?.awaitingReport) surface = inventory.surfaces.find((s) => s.id === task!.awaitingReport);
      if (!surface) {
        surface = upsertSurface(inventory, params.surface);
        task?.created.push(surface.id);
      }
      if (task) task.awaitingReport = null;
      const passNumber = task?.passesBySurface[surface.id] ?? surface.passes;
      const cap = config.passes[task?.level ?? "standard"];
      const scope = computeScope();
      const scopeSize = scope ? scope.size : inventory.surfaces.length;

      const named = params.weaknesses.map((w) => w.trim()).filter(Boolean);
      if (named.length === 0) {
        markPolished(surface);
        task?.stopped.add(surface.id);
        save(ctx);
        showPass(ctx, surface, passNumber, cap, [], scopeSize);
        notify(ctx, `Polish pass ${passNumber}/${cap} — ${surface.name}: model reports nothing weak. Marked polished.`);
        return {
          content: [{ type: "text", text: `Recorded: "${surface.name}" holds up. Marked polished. Nothing to fix — finish normally.` }],
          details: { surface: surface.id, polished: true },
        };
      }

      const rec = recordWeaknesses(surface, named, config.maxNamings);
      const lines: string[] = [`Recorded ${named.length} weakness(es) for "${surface.name}".`];

      if (rec.exhausted.length > 0) {
        const w = rec.exhausted[0]!;
        surface.note = `stopped: "${w.text}" named ${w.namings}x`;
        task?.stopped.add(surface.id);
        save(ctx);
        notify(
          ctx,
          `Polish: ${surface.name} — "${w.text}" is still weak after ${w.namings} attempts. Left raw. Give a specific instruction, or accept it.`,
          "error",
        );
        lines.push(
          "",
          `STOP on "${w.text}": named ${w.namings} times — do NOT attempt it again. Leave it and tell the user it stayed open.`,
        );
        const others = surface.open.filter((o) => o.namings < config.maxNamings);
        if (others.length > 0) lines.push(`Still fix the others: ${others.map((o) => o.text).join("; ")}.`);
        showPass(ctx, surface, passNumber, cap, others, scopeSize);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { surface: surface.id, exhausted: true } };
      }

      save(ctx);
      showPass(ctx, surface, passNumber, cap, surface.open, scopeSize);
      notify(
        ctx,
        `Polish pass ${passNumber}/${cap} — ${surface.name}: ${named.length} weakness(es) named` +
          (rec.repeated.length > 0 ? `, ${rec.repeated.length} repeated from last pass` : "") +
          ". Model is fixing them.",
      );
      for (const w of rec.repeated) {
        lines.push(`"${w.text}" was named before (${w.namings}x) — your previous fix did not land. Do something DIFFERENT this time and say what.`);
      }
      if (rec.resolved.length > 0) lines.push(`Cleared (not named again): ${rec.resolved.map((r) => r.text).join("; ")}.`);
      lines.push("", 'Now fix each one in the code — write "Fixing: <weakness>" before each edit — then finish normally.');
      return { content: [{ type: "text", text: lines.join("\n") }], details: { surface: surface.id, repeated: rec.repeated.length } };
    },
  });

  pi.registerTool({
    name: "polish_surfaces",
    label: "Polish Surfaces",
    description:
      "Manage the polish inventory of user-facing surfaces (screens, menus, pages). " +
      "add registers a new surface with its URL path; focus marks a listed surface as what the current task is about; " +
      "reopen marks a polished surface raw again; list shows all.",
    promptSnippet: "Register, focus or list user-facing surfaces for polish passes",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("focus"), Type.Literal("reopen")]),
      name: Type.Optional(Type.String({ description: "Surface name (add/focus/reopen)." })),
      urlPath: Type.Optional(Type.String({ description: "Path appended to the Playwright baseURL, e.g. /settings (add)." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      reloadInventory(ctx);
      const reply = (text: string, isError = false) => ({
        content: [{ type: "text" as const, text }],
        details: { action: params.action, surfaces: inventory.surfaces.length },
        isError,
      });
      if (params.action === "add") {
        if (!params.name?.trim()) return reply("add needs a name.", true);
        const before = inventory.surfaces.length;
        const s = upsertSurface(inventory, params.name, params.urlPath);
        if (inventory.surfaces.length > before) task?.created.push(s.id);
        if (task && !task.focus.includes(s.id)) task.focus.push(s.id);
        save(ctx);
        const verb = inventory.surfaces.length > before ? "Added" : "Updated";
        return reply(`${verb} surface "${s.name}" (${s.urlPath}) — ${s.status}. In scope for this task.`);
      }
      if (params.action === "focus") {
        const s = params.name ? findSurface(inventory, params.name) : undefined;
        if (!s) return reply(`No surface named "${params.name ?? ""}". Use add to register it.`, true);
        if (task && !task.focus.includes(s.id)) task.focus.push(s.id);
        return reply(`"${s.name}" is in scope for this task's polish passes.`);
      }
      if (params.action === "reopen") {
        const s = params.name ? findSurface(inventory, params.name) : undefined;
        if (!s) return reply(`No surface named "${params.name ?? ""}".`, true);
        reopenSurface(s, "reopened by agent");
        task?.stopped.delete(s.id);
        if (task && !task.focus.includes(s.id)) task.focus.push(s.id);
        save(ctx);
        return reply(`Reopened "${s.name}" — it will get polish passes again.`);
      }
      return reply(formatInventory(inventory));
    },
  });

  // ---------- /polish ----------

  pi.registerCommand("polish", {
    description: "Polish level: off | basic | standard | showcase | ultimate | auto — plus status, reopen, clear, critic",
    getArgumentCompletions: (prefix: string) => {
      const items = [...POLISH_LEVELS, "auto", "status", "reopen", "clear", "critic", "doctor"].map((v) => ({ value: v, label: v }));
      const filtered = items.filter((i) => i.value.startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      configCache = null;
      const config = cfg(ctx);
      reloadInventory(ctx);
      const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const word = sub.toLowerCase();

      if (word === "" || word === "help") {
        const effective = sessionLevel ?? config.level;
        const lines = [
          `Polish level: ${effective}${sessionLevel ? " (this session)" : " (config)"}` +
            (task ? ` · current task: ${task.level} (${task.source})` : ""),
          "",
          ...(["auto", ...POLISH_LEVELS] as Array<PolishLevel | "auto">).map((l) => {
            const passes = l === "auto" ? "" : ` · ${config.passes[l]} pass${config.passes[l] === 1 ? "" : "es"}`;
            return `  ${l.padEnd(9)} ${LEVEL_DESCRIPTIONS[l]}${passes}`;
          }),
          "",
          "Set for this session:  /polish <level>",
          "Set permanently:       /polish <level> user|project",
          "One prompt only:       /once <level> <prompt>",
          "Also: /polish status · reopen <surface> · clear · critic [provider/model|off|list] · doctor",
          "",
          "Surfaces:",
          formatInventory(inventory),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (isPolishSetting(word)) {
        const scope = rest[0]?.toLowerCase();
        if (scope === "user" || scope === "project") {
          const file = persistLevel(ctx.cwd, word, scope);
          sessionLevel = null;
          persist();
          configCache = null;
          ctx.ui.notify(`Polish level ${word} saved (${scope}) → ${file}\n${LEVEL_DESCRIPTIONS[word]}`, "info");
        } else {
          sessionLevel = word;
          persist();
          ctx.ui.notify(`Polish level ${word} for this session.\n${LEVEL_DESCRIPTIONS[word]}\nAdd "user" or "project" to make it stick. One prompt only: /once <level> <prompt>.`, "info");
        }
        // Apply to the current task immediately so the next agent_end/turn uses it.
        if (task && word !== "auto") {
          task.level = word;
          task.source = "session";
        }
        setStatus(ctx);
        syncTools(ctx);
        return;
      }

      if (word === "status") {
        const scope = computeScope();
        const t = task
          ? `Current task: level ${task.level} (${task.source}: ${task.reason}) · ${task.vague ? "vague request — all surfaces in scope" : `scope: ${scopeNames(scope).join(", ") || "(none matched yet)"}`}` +
            ` · passes: ${
              Object.entries(task.passesBySurface)
                .map(([id, n]) => `${id}=${n}`)
                .join(", ") || "none yet"
            } · stopped: ${[...task.stopped].join(", ") || "none"}`
          : "No task yet this session.";
        ctx.ui.notify(`${t}\nChanged UI files pending: ${changedUiFiles.size}\n\nSurfaces:\n${formatInventory(inventory)}`, "info");
        return;
      }

      if (word === "reopen") {
        const name = rest.join(" ");
        const s = findSurface(inventory, name);
        if (!s) {
          ctx.ui.notify(`No surface named "${name}".\n${formatInventory(inventory)}`, "warning");
          return;
        }
        reopenSurface(s, "reopened by user");
        task?.stopped.delete(s.id);
        if (task && !task.focus.includes(s.id)) task.focus.push(s.id);
        save(ctx);
        ctx.ui.notify(`Reopened "${s.name}" — it gets polish passes again on the next UI change.`, "info");
        return;
      }

      if (word === "clear") {
        const ok = ctx.hasUI ? await ctx.ui.confirm("Clear polish inventory", `Forget all ${inventory.surfaces.length} surface(s) and their history?`) : true;
        if (!ok) return;
        inventory = emptyInventory();
        save(ctx);
        ctx.ui.notify("Polish inventory cleared.", "info");
        return;
      }

      if (word === "critic") {
        const arg = rest[0] ?? "";
        const scope = rest[1]?.toLowerCase() === "project" ? "project" : "user";
        if (arg === "" || arg === "list") {
          const models = listVisionModels(ctx);
          const current = config.criticModel ? resolveCriticModel(ctx, config.criticModel) : null;
          const sessionSees = ctx.model?.input?.includes("image") ? "sees images" : "text-only";
          ctx.ui.notify(
            [
              `Critic model: ${config.criticModel || "(none — session model critiques itself)"}` +
                (current && !current.model ? ` — ${current.reason}` : ""),
              `Session model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"} (${sessionSees})`,
              "",
              "Vision-capable models with auth:",
              ...(models.length > 0 ? models.map((m) => `  ${m}`) : ["  (none)"]),
              "",
              "Set: /polish critic <provider/model> [project]   Clear: /polish critic off",
            ].join("\n"),
            "info",
          );
          return;
        }
        if (arg === "off") {
          const file = persistCriticModel(ctx.cwd, "", scope);
          configCache = null;
          ctx.ui.notify(`Critic model cleared (${scope}) → ${file}`, "info");
          return;
        }
        const res = resolveCriticModel(ctx, arg);
        if (!res.model) {
          ctx.ui.notify(`Not set: ${res.reason}`, "error");
          return;
        }
        const file = persistCriticModel(ctx.cwd, arg, scope);
        configCache = null;
        ctx.ui.notify(`Critic model ${arg} saved (${scope}) → ${file}. Used at showcase and ultimate.`, "info");
        return;
      }

      if (word === "doctor") {
        const scen = loadScenariosConfig(ctx.cwd);
        const pwConfig = path.join(ctx.cwd, scen.playwrightConfig);
        const hasPw = fs.existsSync(pwConfig);
        const critic = config.criticModel ? resolveCriticModel(ctx, config.criticModel) : null;
        ctx.ui.notify(
          [
            `enabled: ${config.enabled} · level: ${sessionLevel ?? config.level} · passes: ${POLISH_LEVELS.map((l) => `${l}=${config.passes[l]}`).join(" ")} · maxNamings: ${config.maxNamings}`,
            `screenshots: ${hasPw ? `ok (${scen.playwrightConfig})` : `no ${scen.playwrightConfig} — passes run without screenshots until define_scenarios scaffolds it`}`,
            `critic: ${config.criticModel ? (critic?.model ? `${config.criticModel} ok` : `${config.criticModel} — ${critic?.reason}`) : "none (session model)"}`,
            `inventory: ${config.inventoryPath} (${inventory.surfaces.length} surfaces)`,
          ].join("\n"),
          "info",
        );
        return;
      }

      ctx.ui.notify(`Unknown: /polish ${args}. Try /polish for help.`, "warning");
    },
  });
}
