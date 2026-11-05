import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "../shared/config-paths";

/**
 * Live model lists for your own servers. A provider in ~/.pi/agent/models.json with
 * `"liveModels": true` gets its models from the server's /models endpoint — load a model
 * on the server and it is in /model, no editing. The models listed in models.json stay
 * as templates: a live model takes thinking levels, sampling and limits from the closest
 * one by name, and the server's own context window and image support win over them.
 */

/** Startup waits this long for each server (Pi waits for extension factories). */
export const STARTUP_TIMEOUT_MS = 2500;
const REFRESH_TIMEOUT_MS = 8000;
/** Flags that pick the model or continue a session: then the model in use is not a fallback. */
const CHOSEN_ON_COMMAND_LINE = /(^|\s)(--model|--models|-m|--continue|-c|--resume|-r|--session)(\s|=|$)/;

interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  liveModels?: boolean;
  models?: Array<Record<string, unknown> & { id: string }>;
}

export interface LiveProvider {
  name: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  templates: Array<Record<string, unknown> & { id: string }>;
}

/**
 * What an OpenAI-compatible /models lists. The window and image support are not standard:
 * vLLM adds `max_model_len`, llama.cpp `meta.n_ctx` and `architecture.input_modalities`, some
 * gateways `context_window` / `context_length` and `capabilities`. Servers that list neither
 * (LM Studio, Ollama, older llama.cpp) are asked through their own API — see `enrichServed`.
 */
export interface ServedModel {
  id: string;
  context_window?: number;
  context_length?: number;
  max_model_len?: number;
  capabilities?: string[];
  meta?: { n_ctx?: number };
  architecture?: { input_modalities?: string[] };
}

export function liveProviders(modelsJson: unknown): LiveProvider[] {
  const providers = (modelsJson as { providers?: Record<string, ProviderEntry> } | null)?.providers ?? {};
  const out: LiveProvider[] = [];
  for (const [name, p] of Object.entries(providers)) {
    if (p?.liveModels !== true || typeof p.baseUrl !== "string") continue;
    out.push({
      name,
      baseUrl: p.baseUrl.replace(/\/+$/, ""),
      api: p.api ?? "openai-completions",
      apiKey: p.apiKey,
      headers: p.headers,
      compat: p.compat,
      templates: Array.isArray(p.models) ? p.models.filter((m) => typeof m?.id === "string") : [],
    });
  }
  return out;
}

const tokens = (id: string) => id.toLowerCase().split(/[-_.:/\s]+/).filter(Boolean);

/** The listed model a served one is a variant of: most shared name parts, at least two. */
export function pickTemplate<T extends { id: string }>(id: string, templates: T[]): T | undefined {
  const exact = templates.find((t) => t.id === id);
  if (exact) return exact;
  const want = new Set(tokens(id));
  let best: T | undefined;
  let bestScore = 1;
  for (const t of templates) {
    const score = tokens(t.id).filter((x) => want.has(x)).length;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

const IMAGE_CAPS = new Set(["see", "vision", "image", "images", "multimodal"]);

export function toModelConfig(served: ServedModel, provider: LiveProvider): ProviderModelConfig {
  const t = pickTemplate(served.id, provider.templates) as Record<string, unknown> | undefined;
  const ctx = servedWindow(served) ?? (t?.contextWindow as number | undefined) ?? 131072;
  const caps = served.capabilities ?? served.architecture?.input_modalities;
  const input: ("text" | "image")[] = caps
    ? caps.some((c) => IMAGE_CAPS.has(c.toLowerCase()))
      ? ["text", "image"]
      : ["text"]
    : ((t?.input as ("text" | "image")[] | undefined) ?? ["text"]);
  const maxTokens = Math.min((t?.maxTokens as number | undefined) ?? Math.min(32768, Math.floor(ctx / 4)), ctx);
  const compat = { ...(provider.compat ?? {}), ...((t?.compat as Record<string, unknown> | undefined) ?? {}) };
  const model: Record<string, unknown> = {
    id: served.id,
    name: t?.id === served.id && typeof t.name === "string" ? t.name : served.id,
    api: provider.api,
    baseUrl: provider.baseUrl,
    reasoning: (t?.reasoning as boolean | undefined) ?? false,
    input,
    contextWindow: ctx,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  for (const k of ["thinkingLevelMap", "samplingParams", "headers", "promptCache"]) if (t?.[k] !== undefined) model[k] = t[k];
  if (Object.keys(compat).length) model.compat = compat;
  return model as unknown as ProviderModelConfig;
}

export function servedWindow(served: ServedModel): number | undefined {
  const n = served.context_window ?? served.context_length ?? served.max_model_len ?? served.meta?.n_ctx;
  return typeof n === "number" && n > 0 ? n : undefined;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(fetchFn: Fetch, url: string, init: RequestInit): Promise<unknown> {
  try {
    const res = await fetchFn(url, init);
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fill in the window and image support a server left out of /models, from where each kind of
 * server reports them. Each answer is checked by shape, so asking the wrong kind of server
 * costs a 404 and changes nothing.
 * - llama.cpp: GET /props — `default_generation_settings.n_ctx` (the window one request gets,
 *   after the slots split it) and `modalities.vision`.
 * - LM Studio: GET /api/v0/models — `loaded_context_length` and `type: "vlm"`.
 * - Ollama: GET /api/ps — `context_length` of the loaded model; POST /api/show — `capabilities`.
 *   A model's training length is not used: Ollama serves far less unless told otherwise.
 */
export async function enrichServed(provider: LiveProvider, served: ServedModel[], signal: AbortSignal, fetchFn: Fetch = fetch): Promise<ServedModel[]> {
  const isLlamaCpp = served.some((m) => m.meta !== undefined);
  const needWindow = served.some((m) => servedWindow(m) === undefined) || isLlamaCpp;
  const needImages = served.some((m) => !m.capabilities && !m.architecture?.input_modalities);
  if (!needWindow && !needImages) return served;
  const root = provider.baseUrl.replace(/\/v1$/, "");
  const key = resolveKey(provider.apiKey);
  const headers = { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(provider.headers ?? {}) };
  const init = { headers, signal };

  const [props, lms, ps] = await Promise.all([
    getJson(fetchFn, `${root}/props`, init),
    getJson(fetchFn, `${root}/api/v0/models`, init),
    getJson(fetchFn, `${root}/api/ps`, init),
  ]);
  const llama = props as { default_generation_settings?: { n_ctx?: number }; modalities?: { vision?: boolean } } | undefined;
  const lmsModels = ((lms as { data?: unknown[] } | undefined)?.data ?? []) as { id?: string; type?: string; loaded_context_length?: number }[];
  const ollamaLoaded = ((ps as { models?: unknown[] } | undefined)?.models ?? []) as { name?: string; model?: string; context_length?: number }[];
  const isOllama = Array.isArray((ps as { models?: unknown } | undefined)?.models);

  return Promise.all(
    served.map(async (m) => {
      const out: ServedModel = { ...m };
      const slotWindow = llama?.default_generation_settings?.n_ctx;
      if (typeof slotWindow === "number" && slotWindow > 0 && served.length === 1) {
        out.context_window = slotWindow; // more exact than meta.n_ctx when slots split the window
        if (!out.capabilities && typeof llama?.modalities?.vision === "boolean") out.capabilities = llama.modalities.vision ? ["text", "vision"] : ["text"];
      }
      const lm = lmsModels.find((x) => x.id === m.id);
      if (lm) {
        if (servedWindow(out) === undefined && typeof lm.loaded_context_length === "number") out.context_window = lm.loaded_context_length;
        if (!out.capabilities && typeof lm.type === "string") out.capabilities = lm.type === "vlm" ? ["text", "vision"] : ["text"];
      }
      const ol = ollamaLoaded.find((x) => x.name === m.id || x.model === m.id);
      if (ol && servedWindow(out) === undefined && typeof ol.context_length === "number") out.context_window = ol.context_length;
      if (isOllama && !out.capabilities) {
        const show = (await getJson(fetchFn, `${root}/api/show`, { ...init, method: "POST", body: JSON.stringify({ model: m.id }) })) as { capabilities?: string[] } | undefined;
        if (Array.isArray(show?.capabilities)) out.capabilities = show.capabilities.includes("vision") ? ["text", "vision"] : ["text"];
      }
      return out;
    }),
  );
}

/** settings.json may name the default model with its provider in front: `local-gpu/qwen3.6-27b`. */
export function bareModelId(provider: string, id: string): string {
  return id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
}

/** models.json key syntax: $VAR / ${VAR}, a leading !command, or the key itself. */
export function resolveKey(raw: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("!")) {
    try {
      return execSync(raw.slice(1), { encoding: "utf8", timeout: 5000, windowsHide: true }).trim() || undefined;
    } catch {
      return undefined;
    }
  }
  const resolved = raw.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => (m === "$$" ? "$" : (env[a ?? b] ?? "")));
  return resolved || undefined;
}

export async function fetchServed(provider: LiveProvider, signal: AbortSignal): Promise<ServedModel[]> {
  const key = resolveKey(provider.apiKey);
  const res = await fetch(`${provider.baseUrl}/models`, {
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(provider.headers ?? {}) },
    signal,
  });
  if (!res.ok) throw new Error(`${provider.name}: /models answered ${res.status}`);
  const body = (await res.json()) as { data?: ServedModel[] };
  return (body.data ?? []).filter((m) => typeof m?.id === "string");
}

// ---------- last seen lists: offline startup still shows what the server had ----------

const cacheFile = () => path.join(os.homedir(), CONFIG_DIR_NAME, "live-models.cache.json");

function readCache(): Record<string, ProviderModelConfig[]> {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as Record<string, ProviderModelConfig[]>;
  } catch {
    return {};
  }
}

function writeCache(name: string, models: ProviderModelConfig[]): void {
  try {
    const all = readCache();
    all[name] = models;
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), `${JSON.stringify(all, null, 2)}\n`, "utf8");
  } catch {
    /* a missing cache only costs the offline list */
  }
}

function readModelsJson(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(getAgentDir(), "models.json"), "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

export default async function (pi: ExtensionAPI) {
  const providers = liveProviders(readModelsJson());
  if (providers.length === 0) return;
  const cache = readCache();
  /** What each provider lists now. */
  const current = new Map<string, ProviderModelConfig[]>();
  const failed = new Map<string, string>();

  async function load(p: LiveProvider, timeoutMs: number, signal?: AbortSignal): Promise<ProviderModelConfig[]> {
    const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let served: ServedModel[];
    try {
      served = await fetchServed(p, s);
      if (served.length === 0) throw new Error("no model loaded");
      served = await enrichServed(p, served, s);
    } catch (e) {
      failed.set(p.name, e instanceof Error ? e.message : String(e));
      throw e;
    }
    const models = served.map((m) => toModelConfig(m, p));
    current.set(p.name, models);
    failed.delete(p.name);
    writeCache(p.name, models);
    return models;
  }

  // At startup, so the loaded model is there for the default model and `pi --list-models`.
  await Promise.all(
    providers.map(async (p) => {
      try {
        await load(p, STARTUP_TIMEOUT_MS);
      } catch {
        if (cache[p.name]?.length) current.set(p.name, cache[p.name]!);
      }
    }),
  );

  for (const p of providers) {
    const models = current.get(p.name);
    pi.registerProvider(p.name, {
      baseUrl: p.baseUrl,
      api: p.api as never,
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      ...(models?.length ? { models } : {}),
      // Opening /model refreshes every provider: whatever is loaded on the server now.
      async refreshModels(context) {
        const known = current.get(p.name) ?? [];
        if (!context.allowNetwork) {
          if (known.length) return known;
          throw new Error(`${p.name}: not checked yet`);
        }
        return load(p, REFRESH_TIMEOUT_MS, context.signal);
      },
    });
  }

  function servedIds(name: string): string[] {
    return (current.get(name) ?? []).map((m) => m.id);
  }

  /**
   * The model in use (or the default, when Pi could not find it and fell back) is no longer
   * what the server serves. One model served: switch to it. Several: say which.
   */
  async function checkCurrent(ctx: ExtensionContext, startedFresh = false) {
    const onLive = ctx.model && providers.some((x) => x.name === ctx.model!.provider);
    const wanted = onLive ? { provider: ctx.model!.provider, id: ctx.model!.id } : defaultModel();
    const p = wanted && providers.find((x) => x.name === wanted.provider);
    if (!wanted || !p) return;
    if (failed.has(p.name)) {
      if (ctx.hasUI) ctx.ui.notify(`${p.name}: could not read its model list (${failed.get(p.name)}) — showing the last one seen.`, "warning");
      return;
    }
    const ids = servedIds(p.name);
    if (ids.length === 0 || ids.includes(wanted.id)) return;
    // Switch from a model on this server, or from Pi's fallback when the default was not found
    // at a fresh start. A model you chose on another provider is left alone.
    if (ids.length === 1 && (onLive || !ctx.model || startedFresh)) {
      const model = ctx.modelRegistry.find(p.name, ids[0]!);
      if (model && (await pi.setModel(model))) {
        if (ctx.hasUI) ctx.ui.notify(`${p.name} now serves ${ids[0]} (${wanted.id} is not loaded) — switched to it.`, "info");
        return;
      }
    }
    if (ctx.hasUI) ctx.ui.notify(`${p.name} now serves ${ids.join(", ")} — ${wanted.id} is not loaded there. /model to switch.`, "warning");
  }

  function defaultModel(): { provider: string; id: string } | null {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf8").replace(/^﻿/, "")) as { defaultProvider?: string; defaultModel?: string };
      return s.defaultProvider && s.defaultModel ? { provider: s.defaultProvider, id: bareModelId(s.defaultProvider, s.defaultModel) } : null;
    } catch {
      return null;
    }
  }

  pi.on("session_start", async (event, ctx) => {
    await checkCurrent(ctx, event.reason === "startup" && !CHOSEN_ON_COMMAND_LINE.test(process.argv.slice(2).join(" ")));
  });

  pi.registerCommand("live-models", {
    description: "Models your own servers are serving now (providers with liveModels in models.json)",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      for (const p of providers) {
        try {
          await ctx.modelRegistry.refresh({ providers: [p.name], allowNetwork: true, force: true, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });
        } catch {
          /* reported below */
        }
        const ids = servedIds(p.name);
        lines.push(`${p.name}: ${failed.has(p.name) ? `unreachable (${failed.get(p.name)}); last seen ` : ""}${ids.length ? ids.join(", ") : "nothing"}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
      await checkCurrent(ctx);
    },
  });
}
