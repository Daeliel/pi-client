import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readBlueprint, tierCounts } from "./blueprint";
import { checkPlan, formatCoverage } from "./check";
import { rereadDue, runReread } from "./reread";
import { loadConfig, persistProjectConfig, type PlanConfig } from "./config";
import { autopilotRunning, clearActive, markActive } from "./marks";
import { buildMomentCheckPrompt, markAsked, momentContext, pendingMoments, recordCheck, screenCheck } from "./moment-check";
import { isGateClaimed, tryClaimGate } from "../shared/gate-orchestrator";
import { planSummary } from "./summary";
import { itemContext, parseExperience } from "./walkthrough";
import { buildBlueprintProcedure } from "./procedure";
import { braveImageSearch, saveReference } from "./references";
import { addSource, pointsPath, readPoints, readSources, textWords } from "./sources";
import { hasImageSearch, setOffered, setPlanning, syncPlanTools } from "./state";
import { loadConfig as loadResearchConfig } from "../research/config";
import { loadConfig as loadScenariosConfig } from "../scenarios/config";
import { loadVisionImages } from "../scenarios/vision";
import { presentVisionToSession } from "../shared/vision-relay";
import { playtestOn } from "../shared/playtest";

/**
 * plan — the project's plan (blueprint): written from whatever the user gives, checked for
 * shape, kept with its reference images. Autopilot is one way of working through it; turning
 * autopilot off never turns planning off. See DESIGN.md.
 */
export default function (pi: ExtensionAPI) {
  let configCache: PlanConfig | null = null;

  function cfg(ctx: ExtensionContext): PlanConfig {
    if (!configCache) configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  pi.on("session_start", async (_event, ctx) => {
    configCache = null;
    setPlanning(false);
    setOffered(false);
    clearActive();
    syncPlanTools(pi, ctx);
  });

  pi.on("input", async (_event, ctx) => {
    configCache = null;
    syncPlanTools(pi, ctx);
  });

  // The plan in view in every prompt — a few lines, never the file.
  pi.on("before_agent_start", async (event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled) return;
    const summary = planSummary(ctx.cwd, config);
    if (!summary) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${summary}` };
  });

  // A moment whose items are all built gets checked as a whole — in normal development
  // here, during an autopilot run by autopilot. Last gate: only when nothing else follows up.
  pi.on("agent_end", async (_event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || ctx.signal?.aborted || isGateClaimed() || autopilotRunning(ctx.cwd, config.blueprintPath)) return;
    if (playtestOn()) return; // playtest mode: the user is the check

    const pending = pendingMoments(ctx.cwd, config)[0];
    if (!pending) return;
    const c = momentContext(ctx.cwd, config, pending.id);
    if (!c || !tryClaimGate("plan")) return;
    markAsked(ctx.cwd, config, pending.id);
    pi.sendUserMessage(buildMomentCheckPrompt(c.moment, c.items, c.exp, c.points), { deliverAs: "followUp" });
  });

  pi.registerTool({
    name: "moment_check",
    label: "Moment Check",
    description:
      "Report a moment check: your narration of the moment as the code now behaves, every difference from the plan, and a screenshot of the moment. " +
      "A separate look that sees only the screenshot answers questions about it; you compare.",
    parameters: Type.Object({
      moment: Type.String({ description: "Moment id, e.g. M-03." }),
      narration: Type.String({ description: "What the person sees and what happens when they do each thing — from the code as it is now." }),
      differences: Type.Array(Type.String(), { description: "Each difference from the moment's fields or the source's words. Empty if none." }),
      screenshot: Type.Optional(Type.String({ description: "Project path of a screenshot of this moment." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const id = params.moment.trim().toUpperCase();
      const c = momentContext(ctx.cwd, config, id);
      if (!c) return { content: [{ type: "text", text: `No moment ${params.moment} in the walkthrough.` }], details: { ok: false }, isError: true };
      const screen = params.screenshot ? await screenCheck(ctx, params.screenshot, c.moment) : { skipped: "no screenshot given" };
      recordCheck(ctx.cwd, config, id, params.differences.length, "answers" in screen ? "answered" : /see images/.test(screen.skipped) ? "no vision model" : "no screenshot");
      const parts = [
        params.differences.length
          ? `Differences you found (${params.differences.length}):\n${params.differences.map((d) => `  - ${d}`).join("\n")}`
          : "You found no differences between the code and the plan.",
        "answers" in screen
          ? `${screen.answers}\n\nCompare these with ${id}'s fields: anything the person needs that this look could not get from the screen ("cannot tell", or a wrong answer) is missing from the screen.`
          : `Screen check skipped: ${screen.skipped}.`,
        `For every difference and every gap, add an item to the current tier of the blueprint (\`· moment: ${id}\`, serving the same points) — or fix it now if it is small. Then continue.`,
      ];
      if (ctx.hasUI) ctx.ui.notify(`Plan: ${id} checked — ${params.differences.length} difference(s)${"answers" in screen ? ", screen looked at" : ""}.`, "info");
      return { content: [{ type: "text", text: parts.join("\n\n") }], details: { ok: true, differences: params.differences.length, screen: "answers" in screen } };
    },
  });

  pi.registerTool({
    name: "plan_item",
    label: "Plan Item",
    description:
      "Before building an item of the plan (R-nn): get it with its moment — what the person experiences — and the source's own words for what it serves. " +
      "Its box is ticked when its evidence passes.",
    parameters: Type.Object({ id: Type.String({ description: "Item id, e.g. R-11." }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const bp = readBlueprint(ctx.cwd, config.blueprintPath);
      const item = bp?.parsed.items.find((i) => i.id === params.id.trim().toUpperCase());
      if (!bp || !item) {
        const ids = bp?.parsed.items.map((i) => i.id).join(", ") ?? "none";
        return { content: [{ type: "text", text: `No item ${params.id} in the plan. Items: ${ids}.` }], details: { ok: false }, isError: true };
      }
      markActive(item.id);
      const points = readPoints(ctx.cwd, config.blueprintPath)?.points ?? [];
      const context = itemContext(item, parseExperience(bp.text), points);
      const lines = [
        `${item.id} [${item.mark}] ${item.title}`,
        item.fields.input ? `The user does it by: ${item.fields.input}` : "",
        `Evidence: ${item.proves || "(none — add · proves: to the item)"}${/^(verify|manual)$/i.test(item.proves) ? "" : " — must drive the real UI for this item"}`,
        context,
        "Build this item; when its evidence passes, its box is ticked. Do not change the marks by hand.",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n\n") }], details: { ok: true, id: item.id } };
    },
  });

  pi.registerTool({
    name: "propose_plan",
    label: "Propose Plan",
    description:
      "Offer to plan before building, when the work is plan-sized: a new app or game, a design doc to implement, an overhaul — " +
      "or when a project has grown into one (a design doc appeared or grew a lot, many sessions of feature work on the same product, " +
      "or you find yourself keeping your own build-order or task file). Not for fixes or single features. The user decides.",
    promptSnippet: "Offer to plan a large build first (user decides)",
    parameters: Type.Object({
      reason: Type.String({ description: "One line: why this is plan-sized." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      setOffered(true);
      if (!ctx.hasUI) {
        syncPlanTools(pi, ctx);
        return {
          content: [{ type: "text", text: `Ask the user in chat whether to plan first (${params.reason}); if they agree, call write_blueprint.` }],
          details: { asked: false },
        };
      }
      const yes = await ctx.ui.confirm(
        "Plan first?",
        `${params.reason}\n\nWrite a plan before building — your sources kept as given, what they say quoted, the experience moment by moment — so nothing is lost or misread along the way?`,
      );
      if (!yes) {
        persistProjectConfig(ctx.cwd, { offerDeclined: true });
        configCache = null;
        syncPlanTools(pi, ctx);
        return {
          content: [{ type: "text", text: "The user declined a plan for this project. Continue without one, and do not offer again." }],
          details: { planned: false },
        };
      }
      setPlanning(true);
      syncPlanTools(pi, ctx);
      const procedure = buildBlueprintProcedure({
        blueprintPath: config.blueprintPath,
        refsDir: config.refsDir,
        budgetMinutes: null,
        imageSearch: hasImageSearch(ctx.cwd),
        forAutopilot: false,
      });
      return { content: [{ type: "text", text: `The user wants a plan first.\n\n${procedure}` }], details: { planned: true } };
    },
  });

  pi.registerTool({
    name: "write_blueprint",
    label: "Write Blueprint",
    description:
      "Get the procedure and format for a blueprint: a tiered, checkable build plan saved to the project. " +
      "Call it when the user wants a plan or design doc for an app ('blueprint me an app that works like Photoshop'), " +
      "or before building something large. It does not build anything.",
    promptSnippet: "Write a buildable blueprint (plan only)",
    parameters: Type.Object({
      budgetMinutes: Type.Optional(Type.Number({ description: "Time the user has for building it, if they said — v1 is sized to fit." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      setPlanning(true);
      syncPlanTools(pi, ctx);
      const exists = readBlueprint(ctx.cwd, config.blueprintPath);
      const prefix = exists
        ? `A blueprint already exists at ${config.blueprintPath} (${tierCounts(exists.parsed.items) || "no items"}). Extend or correct it rather than starting over, unless the user asked for a new one.\n\n`
        : "";
      const text =
        prefix +
        buildBlueprintProcedure({
          blueprintPath: config.blueprintPath,
          refsDir: config.refsDir,
          budgetMinutes: typeof params.budgetMinutes === "number" ? params.budgetMinutes : null,
          imageSearch: hasImageSearch(ctx.cwd),
          forAutopilot: false,
        });
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "add_source",
    label: "Add Source",
    description:
      "Register what the plan is built from, kept as given: the user's request (pass it as text, verbatim), a document in the project (file), " +
      "or an image (file). Call again for a source after reading its changes — that records the new version.",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Project path of a document or image, e.g. 'DESIGN.md' or 'refs/game.png'." })),
      text: Type.Optional(Type.String({ description: "The user's words, verbatim (saved as a source file)." })),
      note: Type.Optional(Type.String({ description: "'given by user' (default) or 'found by model'." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      setPlanning(true);
      syncPlanTools(pi, ctx);
      try {
        const { source, refreshed } = addSource(ctx.cwd, config.blueprintPath, params);
        const total = textWords(readSources(ctx.cwd, config.blueprintPath));
        const size = source.kind === "text" ? `${source.words} words` : "image";
        const next =
          source.kind === "text"
            ? `List what it says in ${pointsPath(config.blueprintPath)}: one point per line, quoting its own words — \`- S-01 (${source.id} where) "…"\` (shorten long quotes with "…").`
            : `List what the image shows in ${pointsPath(config.blueprintPath)}: \`- S-nn (${source.id} where in the image) "what is there"\`, and what it cannot show.`;
        const reread =
          total > config.rereadAboveWords
            ? `\nThe text sources are ${total} words together (over ${config.rereadAboveWords}): a second, fresh read will check that your points miss nothing.`
            : "";
        return {
          content: [{ type: "text", text: `${refreshed ? "Recorded the new version of" : "Registered"} ${source.id} — ${source.file} (${size}).\n${next}${reread}` }],
          details: { id: source.id, refreshed },
        };
      } catch (e) {
        return { content: [{ type: "text", text: `add_source: ${(e as Error).message}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "blueprint_check",
    label: "Check Blueprint",
    description:
      "Validate the plan: the blueprint's shape (goal, bar, tiers, items, evidence, checkable wording) and its link to the sources " +
      "(every point quoted verbatim and served or listed as not covered; changed sources). Lists what to fix.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      // Long sources get a second, fresh read before the plan is trusted (once per version).
      const before = checkPlan(ctx.cwd, config);
      if (before.parsed && rereadDue(ctx.cwd, config) && !before.problems.some((p) => /^No sources|^No .*POINTS\.md|changed since/.test(p))) {
        const r = await runReread(ctx, config, (t) => ctx.hasUI && ctx.ui.setWorkingMessage(t));
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
        if (!r.ok) return { content: [{ type: "text", text: `The fresh read of the sources failed (${r.error}); call blueprint_check again.` }], details: { ok: false }, isError: true };
      }
      const result = checkPlan(ctx.cwd, config);
      if (!result.parsed) return { content: [{ type: "text", text: result.problems[0]! }], details: { ok: false }, isError: true };
      if (result.problems.length > 0) {
        return { content: [{ type: "text", text: `Plan problems:\n- ${result.problems.join("\n- ")}` }], details: { ok: false, problems: result.problems } };
      }
      return {
        content: [{ type: "text", text: `Plan OK: ${tierCounts(result.parsed.items)} · ${formatCoverage(result.coverage)}.` }],
        details: { ok: true, coverage: result.coverage },
      };
    },
  });

  pi.registerTool({
    name: "save_reference_image",
    label: "Save Reference Image",
    description:
      "Keep a reference image for the blueprint: download an image URL (from find_reference_images or any image-search tool) or copy a local image the user gave. " +
      "Returns the saved path and shows you the image so you can describe it under ## References. Reference only — never copy it into the app.",
    parameters: Type.Object({
      source: Type.String({ description: "Image URL, or a path to an image in the project." }),
      name: Type.String({ description: "Short file name stem, e.g. 'aseprite-main-ui'." }),
      via: Type.Optional(Type.String({ description: "Where it came from (search tool or 'user')." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      try {
        const saved = await saveReference(ctx.cwd, config.refsDir, params.source, params.name, signal);
        const text =
          `Saved ${saved.file}. Add it under ## References as:\n` +
          `- **REF-nn** ${saved.file.replace(/^\.pi\/blueprint\//, "")} — <what it shows> → <R-ids> · cannot show: <…> · source: ${saved.source}${params.via ? ` · via: ${params.via}` : ""}`;
        const { images, paths } = await loadVisionImages([path.resolve(ctx.cwd, saved.file)], loadScenariosConfig(ctx.cwd));
        const content = images.length ? await presentVisionToSession(ctx, text, images, paths) : [{ type: "text" as const, text }];
        return { content, details: { file: saved.file } };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not save the image: ${(e as Error).message}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "find_reference_images",
    label: "Find Reference Images",
    description:
      "Image search (via the research extension's Brave key) for blueprint references. Returns image URLs; keep the useful ones with save_reference_image. " +
      "If you have another image-search tool, you may use that instead.",
    parameters: Type.Object({
      query: Type.String({ description: "What to look for, e.g. 'pixel art editor UI layers panel'." }),
      count: Type.Optional(Type.Number({ description: "Results (default 6, max 20)." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const hits = await braveImageSearch(params.query, params.count ?? 6, loadResearchConfig(ctx.cwd), signal);
        if (hits.length === 0) return { content: [{ type: "text", text: "No images found — try other words." }], details: { count: 0 } };
        const text = hits.map((h, i) => `${i + 1}. ${h.title || "(untitled)"}\n   image: ${h.imageUrl}\n   page: ${h.pageUrl}`).join("\n");
        return { content: [{ type: "text", text: `${text}\n\nSave the useful ones with save_reference_image (via: brave).` }], details: { count: hits.length } };
      } catch (e) {
        const msg = (e as Error).message;
        const text =
          msg === "NO_API_KEY"
            ? "No search key configured (/research setup). Ask the user for reference images instead."
            : msg === "NO_IMAGE_PLAN"
              ? "The Brave key's plan does not include image search. Use another image-search tool if you have one, or ask the user for reference images."
              : `Image search failed: ${msg}`;
        return { content: [{ type: "text", text }], details: {}, isError: true };
      }
    },
  });

  pi.registerCommand("blueprint", {
    description: "Write a buildable blueprint (plan only): /blueprint <what to build>",
    handler: async (args, ctx) => {
      const config = cfg(ctx);
      const ask = args.trim();
      if (!ask) {
        const bp = readBlueprint(ctx.cwd, config.blueprintPath);
        ctx.ui.notify(bp ? `Blueprint ${config.blueprintPath}: ${tierCounts(bp.parsed.items) || "no items"}.` : "Usage: /blueprint <what to build>", "info");
        return;
      }
      setPlanning(true);
      syncPlanTools(pi, ctx);
      const procedure = buildBlueprintProcedure({
        blueprintPath: config.blueprintPath,
        refsDir: config.refsDir,
        budgetMinutes: null,
        imageSearch: hasImageSearch(ctx.cwd),
        forAutopilot: false,
      });
      pi.sendUserMessage(`${ask}\n\n${procedure}`);
    },
  });
}
