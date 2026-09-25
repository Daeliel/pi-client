import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, foundationConfigPaths } from "./config-paths";
import { completeVision, type AnyModel } from "./model-complete";
import type { VisionImageContent } from "../scenarios/vision";

export interface VisionRelayConfig {
  /** Master switch. When false, images are attached as today even if the session is text-only. */
  enabled: boolean;
  /** "provider/modelId". Empty = first vision-capable model with auth (not the session model). */
  relayModel: string;
  maxTokens: number;
}

export const DEFAULT_CONFIG: VisionRelayConfig = {
  enabled: true,
  relayModel: "",
  maxTokens: 900,
};

export interface VisionModelResolution {
  model: AnyModel | null;
  reason?: string;
}

export type SessionVisionPart = { type: "text"; text: string } | VisionImageContent;

const CAPTION_SYSTEM = `You describe screenshots for a text-only coding agent that cannot see images.
Be concrete: which screen/page/state, visible text and controls, errors, layout problems (overlap, clipped, blank/white, misaligned).
Do not write code or suggest file edits. 400 words max.`;

function readJson(file: string): Partial<VisionRelayConfig> | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function loadVisionRelayConfig(cwd: string): VisionRelayConfig {
  const layers = foundationConfigPaths(cwd, "vision.config.json");
  let cfg: VisionRelayConfig = { ...DEFAULT_CONFIG };
  for (const file of layers) {
    const override = readJson(file);
    if (!override) continue;
    cfg = { ...cfg, ...override };
  }
  if (!Number.isFinite(cfg.maxTokens) || cfg.maxTokens < 100) cfg.maxTokens = DEFAULT_CONFIG.maxTokens;
  return cfg;
}

export function userVisionConfigPath(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, "vision.config.json");
}

export function projectVisionConfigPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, "vision.config.json");
}

export function persistVisionRelay(
  cwd: string,
  patch: Partial<VisionRelayConfig>,
  scope: "user" | "project",
): string {
  const target = scope === "user" ? userVisionConfigPath() : projectVisionConfigPath(cwd);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = readJson(target) ?? {};
  fs.writeFileSync(target, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, "utf8");
  return target;
}

export function sessionSeesImages(ctx: ExtensionContext): boolean {
  return Boolean(ctx.model?.input?.includes("image"));
}

export function listVisionModels(ctx: ExtensionContext): string[] {
  return ctx.modelRegistry
    .getAvailable()
    .filter((m) => m.input?.includes("image"))
    .map((m) => `${m.provider}/${m.id}`);
}

export function resolveVisionModel(
  ctx: ExtensionContext,
  spec: string,
  opts?: { emptyReason?: string; kind?: string },
): VisionModelResolution {
  const kind = opts?.kind ?? "vision model";
  const trimmed = spec.trim();
  if (!trimmed) return { model: null, reason: opts?.emptyReason ?? `no ${kind} configured` };
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return { model: null, reason: `${kind} must be "provider/modelId", got "${trimmed}"` };
  const provider = trimmed.slice(0, slash);
  const id = trimmed.slice(slash + 1);
  const model = ctx.modelRegistry.find(provider, id);
  if (!model) return { model: null, reason: `${kind} ${trimmed} not found in models.json` };
  if (!model.input?.includes("image")) {
    return { model: null, reason: `${kind} ${trimmed} is text-only (cannot see screenshots)` };
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    return { model: null, reason: `${kind} ${trimmed} has no auth configured` };
  }
  return { model };
}

/** Configured relay, or first vision model that is not the session model. */
export function pickRelayModel(ctx: ExtensionContext, configuredSpec: string): VisionModelResolution {
  const trimmed = configuredSpec.trim();
  if (trimmed) return resolveVisionModel(ctx, trimmed, { kind: "relay model" });
  const sessionKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
  const available = listVisionModels(ctx);
  const pick = available.find((m) => m !== sessionKey) ?? available[0];
  if (!pick) return { model: null, reason: "no vision-capable model with auth in models.json" };
  return resolveVisionModel(ctx, pick, { kind: "relay model" });
}

/** Pull Pi `input` event images into the shape the relay already captions. */
export function inputImagesToRelay(images: unknown): VisionImageContent[] {
  if (!Array.isArray(images)) return [];
  const out: VisionImageContent[] = [];
  for (const raw of images) {
    if (!raw || typeof raw !== "object") continue;
    const img = raw as Record<string, unknown>;
    if (img.type !== "image") continue;
    const mimeType = typeof img.mimeType === "string" ? img.mimeType : "";
    const data = typeof img.data === "string" ? img.data : "";
    if (!mimeType || !data) continue;
    out.push({ type: "image", mimeType, data });
  }
  return out;
}

export function formatRelayedMessage(
  intro: string,
  paths: string[],
  caption: string,
  relayName: string,
): string {
  const lines = [intro];
  if (paths.length > 0) {
    lines.push("", "Screenshots (described, not attached):", ...paths.map((p) => `  - ${p}`));
  }
  lines.push(
    "",
    `Vision relay (${relayName}) described the screenshot(s) because the session model is text-only:`,
    "",
    caption.trim(),
  );
  return lines.join("\n");
}

/**
 * Attach images when the session can see them; otherwise caption via a vision model
 * and send text only. Replaces raw image attach on text-only sessions — does not add a second path.
 */
export async function presentVisionToSession(
  ctx: ExtensionContext,
  intro: string,
  images: VisionImageContent[],
  paths: string[],
): Promise<SessionVisionPart[]> {
  if (images.length === 0) {
    return [{ type: "text", text: intro }];
  }

  const config = loadVisionRelayConfig(ctx.cwd);
  const { buildVisionContent, buildVisionMessage } = await import("../scenarios/vision");
  if (!config.enabled || sessionSeesImages(ctx)) {
    return buildVisionContent(intro, images, paths);
  }

  const picked = pickRelayModel(ctx, config.relayModel);
  if (!picked.model) {
    const note =
      `Vision relay: session model is text-only and ${picked.reason}. ` +
      `Screenshots stay on disk; the model cannot see them. /vision model <provider/id>`;
    if (ctx.hasUI) ctx.ui.notify(note, "warning");
    return [{ type: "text", text: `${buildVisionMessage(intro, paths)}\n\n${note}` }];
  }

  const relayName = `${picked.model.provider}/${picked.model.id}`;
  if (ctx.hasUI) {
    ctx.ui.notify(`Vision relay: ${relayName} describing ${images.length} screenshot(s) for the text-only session.`, "info");
    ctx.ui.setWorkingMessage("Vision relay: describing screenshot…");
  }

  const userText =
    images.length === 1
      ? "Describe this screenshot for a text-only coding agent."
      : `Describe these ${images.length} screenshots for a text-only coding agent. Label them in order.`;

  try {
    const reply = await completeVision(ctx, picked.model, CAPTION_SYSTEM, userText, images, {
      signal: ctx.signal,
      maxTokens: config.maxTokens,
    });
    if (!reply.ok || !reply.text.trim()) {
      const err = reply.error ?? "empty description";
      const note = `Vision relay (${relayName}) failed (${err}). Screenshots are on disk only.`;
      if (ctx.hasUI) ctx.ui.notify(note, "warning");
      return [{ type: "text", text: `${buildVisionMessage(intro, paths)}\n\n${note}` }];
    }
    return [{ type: "text", text: formatRelayedMessage(intro, paths, reply.text, relayName) }];
  } finally {
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
  }
}
