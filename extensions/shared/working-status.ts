import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** What a gate is doing right now, shown after its label in the working indicator. */
export interface GateStatus {
  /** Replace the current step ("Scenario 3/10: login"); omit to show the label alone. */
  step(text?: string): void;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * While foundation gates run on agent_end, Pi still shows the Working indicator
 * (extensions are awaited before the UI clears it) but the GPU is idle.
 * Relabel so "Working..." is not mistaken for an in-flight LLM call, and keep the
 * label moving — current step plus elapsed time, ticking every second — so a long
 * Playwright run does not look the same as a hang.
 */
export async function withGateWorkingMessage<T>(
  ctx: ExtensionContext,
  message: string,
  fn: (status: GateStatus) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let current: string | undefined;
  const render = () => {
    if (!ctx.hasUI) return;
    const step = current ? ` — ${current}` : "";
    ctx.ui.setWorkingMessage(`${message}${step} · ${formatElapsed(Date.now() - started)}`);
  };
  const status: GateStatus = {
    step(text) {
      current = text;
      render();
    },
  };
  render();
  const ticker = ctx.hasUI ? setInterval(render, 1000) : undefined;
  ticker?.unref();
  try {
    return await fn(status);
  } finally {
    if (ticker) clearInterval(ticker);
    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage();
    }
  }
}
