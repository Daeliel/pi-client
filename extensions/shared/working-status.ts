import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * While foundation gates run on agent_end, Pi still shows the Working indicator
 * (extensions are awaited before the UI clears it) but the GPU is idle.
 * Relabel so "Working..." is not mistaken for an in-flight LLM call.
 */
export async function withGateWorkingMessage<T>(
  ctx: ExtensionContext,
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (ctx.hasUI) {
    ctx.ui.setWorkingMessage(message);
  }
  try {
    return await fn();
  } finally {
    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage();
    }
  }
}
