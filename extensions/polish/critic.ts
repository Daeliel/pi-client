import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VisionImageContent } from "../scenarios/vision";
import { completeVision, type AnyModel, type VisionCompleteResult } from "../shared/model-complete";
import { listVisionModels, resolveVisionModel, type VisionModelResolution } from "../shared/vision-relay";

export type CriticModelResolution = VisionModelResolution;
export type CriticCallResult = VisionCompleteResult;

/**
 * Resolve the configured critic model ("provider/modelId").
 * Rejects text-only models and models with no auth configured — the caller falls back to the session model.
 */
export function resolveCriticModel(ctx: ExtensionContext, spec: string): CriticModelResolution {
  return resolveVisionModel(ctx, spec, {
    emptyReason: "no criticModel configured",
    kind: "critic model",
  });
}

export { listVisionModels };

/**
 * One-shot completion on a model that is NOT the session model.
 */
export async function runCriticCompletion(
  ctx: ExtensionContext,
  model: AnyModel,
  system: string,
  userText: string,
  images: VisionImageContent[],
  signal?: AbortSignal,
): Promise<CriticCallResult> {
  return completeVision(ctx, model, system, userText, images, { signal, maxTokens: 600 });
}
