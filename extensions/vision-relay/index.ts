import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  inputImagesToRelay,
  listVisionChoices,
  loadVisionRelayConfig,
  persistVisionRelay,
  pickRelayModel,
  presentVisionToSession,
  relayWanted,
  resolveVisionModel,
  sessionSeesImages,
  type VisionChoice,
} from "../shared/vision-relay";
import { trimImages } from "../shared/image-budget";
import { checkEyes } from "../shared/eyes";

export default function (pi: ExtensionAPI) {
  // Every request carries the whole conversation: keep its images under the byte budget.
  let warned = false;
  pi.on("context", async (event, ctx) => {
    const budget = loadVisionRelayConfig(ctx.cwd).maxImageBytesPerRequest;
    const trimmed = trimImages(event.messages, budget);
    if (!trimmed) return;
    if (!warned && ctx.hasUI) {
      warned = true;
      ctx.ui.notify(
        `Left ${trimmed.dropped} older image(s) out of the request to stay under ${Math.round(budget / 1048576)} MiB (the session keeps them). ` +
          "Set maxImageBytesPerRequest in vision.config.json to change it.",
        "info",
      );
    }
    return { messages: trimmed.messages };
  });

  /**
   * A text-only model with nothing that can describe images for it: say so when it is picked,
   * not at the first screenshot. Once per model and reason, and in the background — a down
   * server takes a moment to time out.
   */
  let lastWarning = "";
  function warnIfBlind(ctx: ExtensionContext) {
    if (!ctx.hasUI || !ctx.model || sessionSeesImages(ctx)) return;
    const session = `${ctx.model.provider}/${ctx.model.id}`;
    void checkEyes(ctx).then((eyes) => {
      if (!eyes.blind) return;
      const warning = `${session}|${eyes.reason}`;
      if (warning === lastWarning) return;
      lastWarning = warning;
      ctx.ui.notify(
        `Vision: ${session} cannot see images, and ${eyes.reason}. Checks will not ask it for screenshots; visual checks are left to you. /vision for details.`,
        "warning",
      );
    }, () => {});
  }
  pi.on("session_start", async (_event, ctx) => warnIfBlind(ctx));
  pi.on("model_select", async (_event, ctx) => warnIfBlind(ctx));

  pi.on("input", async (event, ctx) => {
    const images = inputImagesToRelay(event.images);
    if (images.length === 0) return;
    if (!relayWanted(ctx, loadVisionRelayConfig(ctx.cwd))) return;

    const intro = event.text.trim() || "User attached image(s).";
    const parts = await presentVisionToSession(ctx, intro, images, [], { source: "user" });
    const text = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    return { action: "transform" as const, text, images: [] };
  });

  const NO_VISION_MODEL =
    "No model that can see images is set up. To add one: load a vision model on a server you already use " +
    "(LM Studio and Ollama list every loaded model; llama.cpp needs a second server or router mode) on a provider " +
    'with "liveModels": true, or add a model with "input": ["text", "image"] to ~/.pi/agent/models.json. Then /vision again.';

  const label = (c: VisionChoice) => `${c.spec} · ${c.where}${c.up ? "" : " · not answering"}`;

  /** Pick the model that reads images, and when it is used. Saved for every project. */
  async function pickInteractively(ctx: ExtensionContext) {
    const config = loadVisionRelayConfig(ctx.cwd);
    const choices = await listVisionChoices(ctx);
    const session = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const others = choices.filter((c) => c.spec !== session);
    if (others.length === 0) {
      ctx.ui.notify(NO_VISION_MODEL, "info");
      return;
    }
    const auto = await pickRelayModel(ctx, "");
    const autoLabel = `Auto — ${auto.model ? `${auto.model.provider}/${auto.model.id} now (same server first, skips ones that are down)` : "none answers now"}`;
    const offLabel = "Off — no image descriptions";
    const options = [autoLabel, ...others.map(label), offLabel];
    const current = config.enabled ? (config.relayModel || "auto") : "off";
    const picked = await ctx.ui.select(`Model that reads images (now: ${current})`, options);
    if (!picked) return;
    if (picked === offLabel) {
      const file = persistVisionRelay(ctx.cwd, { enabled: false }, "user");
      ctx.ui.notify(`Vision: off. Images are attached as they are; a model that cannot see gets none. Saved to ${file}.`, "info");
      return;
    }
    const choice = others.find((c) => label(c) === picked);
    const whenText = "Only when the main model cannot see images";
    const alwaysText = "Always — also instead of the main model's own vision";
    const when = await ctx.ui.select("When should it read images?", [whenText, alwaysText]);
    if (!when) return;
    const file = persistVisionRelay(
      ctx.cwd,
      { enabled: true, relayModel: choice ? choice.spec : "", overrideModelVision: when === alwaysText },
      "user",
    );
    const name = choice ? choice.spec : "auto";
    const notes = [`Vision: ${name} reads images ${when === alwaysText ? "for every model" : "for models that cannot see"}. Saved to ${file}.`];
    if (choice && !choice.up) notes.push("Its server is not answering right now — images go undescribed until it is back.");
    if (choice?.where.startsWith("cloud")) notes.push(`Screenshots and pasted images will be sent to ${choice.where.slice("cloud: ".length)}.`);
    ctx.ui.notify(notes.join("\n"), choice && !choice.up ? "warning" : "info");
  }

  pi.registerCommand("vision", {
    description: "Choose the model that reads images (picker) — or status | model <provider/id> | always | only-blind | on | off [project]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0 && ctx.hasUI) return pickInteractively(ctx);
      const sub = parts[0]?.toLowerCase() ?? "status";
      const scope = parts[parts.length - 1]?.toLowerCase() === "project" ? "project" : "user";

      if (sub === "always" || sub === "only-blind") {
        const file = persistVisionRelay(ctx.cwd, { overrideModelVision: sub === "always" }, scope);
        ctx.ui.notify(
          `Vision: the chosen model reads images ${sub === "always" ? "for every model, also ones that can see" : "only for models that cannot see"} (saved to ${file}).`,
          "info",
        );
        return;
      }
      if (sub === "on" || sub === "off") {
        const file = persistVisionRelay(ctx.cwd, { enabled: sub === "on" }, scope);
        ctx.ui.notify(`Vision relay ${sub} (saved to ${file}).`, "info");
        return;
      }

      if (sub === "model") {
        const spec = parts[1] ?? "";
        if (!spec || spec === "project") {
          ctx.ui.notify("Usage: /vision model <provider/modelId> [project]", "warning");
          return;
        }
        if (spec === "off" || spec === "auto") {
          const file = persistVisionRelay(ctx.cwd, { relayModel: "" }, scope);
          ctx.ui.notify(`Vision relay model cleared (auto-pick). Saved to ${file}.`, "info");
          return;
        }
        const res = resolveVisionModel(ctx, spec, { kind: "relay model" });
        if (!res.model) {
          ctx.ui.notify(`Not set: ${res.reason}`, "error");
          return;
        }
        const file = persistVisionRelay(ctx.cwd, { relayModel: spec }, scope);
        ctx.ui.notify(`Vision relay ${spec} saved (${scope}) → ${file}. Used when the session model is text-only.`, "info");
        return;
      }

      const config = loadVisionRelayConfig(ctx.cwd);
      const session = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
      const sees = sessionSeesImages(ctx) ? "sees images" : "text-only";
      const picked = await pickRelayModel(ctx, config.relayModel);
      const models = (await listVisionChoices(ctx)).map(label);
      ctx.ui.notify(
        [
          `Vision relay: ${config.enabled ? "ON" : "OFF"} · model: ${config.relayModel || "(auto)"}` +
            (picked.model ? ` → ${picked.model.provider}/${picked.model.id}` : ` — ${picked.reason}`),
          `Session: ${session} (${sees})` +
            (relayWanted(ctx, config) ? " — screenshots and pasted images are described, not attached" : " — images attach as usual"),
          `Used: ${config.overrideModelVision ? "always, also instead of a model's own vision" : "only for models that cannot see"}`,
          "",
          "Models that can see images:",
          ...(models.length > 0 ? models.map((m) => `  ${m}`) : ["  (none)"]),
          "",
          models.length > 0 ? "Choose: /vision   or /vision model <provider/model> · /vision always|only-blind · /vision off" : NO_VISION_MODEL,
        ].join("\n"),
        "info",
      );
    },
  });
}
