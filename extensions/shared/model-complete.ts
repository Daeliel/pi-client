import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VisionImageContent } from "../scenarios/vision";

export type AnyModel = NonNullable<ExtensionContext["model"]>;

export interface VisionCompleteResult {
  ok: boolean;
  text: string;
  error?: string;
}

type OneShotContext = {
  systemPrompt?: string;
  messages: Array<{
    role: "user";
    content: Array<{ type: "text"; text: string } | VisionImageContent>;
    timestamp: number;
  }>;
};

type CompleteSimpleFn = (m: AnyModel, c: OneShotContext, o?: Record<string, unknown>) => Promise<unknown>;

/**
 * One-shot completion on a model that is NOT the session model.
 *
 * Newer pi exposes ctx.modelRegistry.complete(model, context); older builds need
 * pi-ai's completeSimple with the registry-resolved auth. Both are tried, in that order,
 * with loose typing so the extension compiles against either version.
 */
export async function completeVision(
  ctx: ExtensionContext,
  model: AnyModel,
  system: string,
  userText: string,
  images: VisionImageContent[],
  opts?: { signal?: AbortSignal; maxTokens?: number },
): Promise<VisionCompleteResult> {
  const maxTokens = opts?.maxTokens ?? 600;
  const signal = opts?.signal;
  const context: OneShotContext = {
    systemPrompt: system,
    messages: [{ role: "user", content: [{ type: "text", text: userText }, ...images], timestamp: Date.now() }],
  };

  const registry = ctx.modelRegistry as unknown as {
    complete?: (m: AnyModel, c: OneShotContext, o?: Record<string, unknown>) => Promise<unknown>;
    getApiKeyAndHeaders: (m: AnyModel) => Promise<Record<string, unknown>>;
  };

  try {
    let response: unknown;
    if (typeof registry.complete === "function") {
      response = await registry.complete(model, context, { signal, maxTokens });
    } else {
      const auth = await registry.getApiKeyAndHeaders(model);
      if (auth.ok === false) return { ok: false, text: "", error: String(auth.error ?? "auth failed") };
      const completeSimple = await loadCompleteSimple();
      if (!completeSimple) return { ok: false, text: "", error: "pi-ai completeSimple not available in this pi build" };
      response = await completeSimple(model, context, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal,
        maxTokens,
      });
    }
    const text = extractText(response);
    const stop = (response as { stopReason?: string; errorMessage?: string }) ?? {};
    if (stop.stopReason === "error") return { ok: false, text, error: stop.errorMessage ?? "model error" };
    return { ok: true, text };
  } catch (e: unknown) {
    return { ok: false, text: "", error: e instanceof Error ? e.message : String(e) };
  }
}

async function loadCompleteSimple(): Promise<CompleteSimpleFn | null> {
  for (const spec of ["@earendil-works/pi-ai/compat", "@earendil-works/pi-ai"]) {
    try {
      const mod = (await import(spec)) as { completeSimple?: CompleteSimpleFn };
      if (typeof mod.completeSimple === "function") return mod.completeSimple;
    } catch {
      /* try next */
    }
  }
  return null;
}

function extractText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => Boolean(c) && (c as { type?: string }).type === "text")
    .map((c) => c.text)
    .join("\n");
}
