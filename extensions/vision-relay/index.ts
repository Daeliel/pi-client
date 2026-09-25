import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  inputImagesToRelay,
  listVisionModels,
  loadVisionRelayConfig,
  persistVisionRelay,
  pickRelayModel,
  presentVisionToSession,
  resolveVisionModel,
  sessionSeesImages,
} from "../shared/vision-relay";

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    const images = inputImagesToRelay(event.images);
    if (images.length === 0) return;
    if (!loadVisionRelayConfig(ctx.cwd).enabled) return;
    if (sessionSeesImages(ctx)) return;

    const intro = event.text.trim() || "User attached image(s).";
    const parts = await presentVisionToSession(ctx, intro, images, [], { source: "user" });
    const text = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    return { action: "transform" as const, text, images: [] };
  });

  pi.registerCommand("vision", {
    description: "Vision relay for text-only sessions — status | model <provider/id> | on | off [project]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() ?? "status";
      const scope = parts[parts.length - 1]?.toLowerCase() === "project" ? "project" : "user";

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
      const picked = pickRelayModel(ctx, config.relayModel);
      const models = listVisionModels(ctx);
      ctx.ui.notify(
        [
          `Vision relay: ${config.enabled ? "ON" : "OFF"} · model: ${config.relayModel || "(auto)"}` +
            (picked.model ? ` → ${picked.model.provider}/${picked.model.id}` : ` — ${picked.reason}`),
          `Session: ${session} (${sees})` +
            (sessionSeesImages(ctx) ? " — images attach as usual" : " — screenshots and pasted images are described, not attached"),
          "",
          "Vision-capable models with auth:",
          ...(models.length > 0 ? models.map((m) => `  ${m}`) : ["  (none)"]),
          "",
          "Set: /vision model <provider/model> [project]   Auto: /vision model auto   Off: /vision off",
        ].join("\n"),
        "info",
      );
    },
  });
}
