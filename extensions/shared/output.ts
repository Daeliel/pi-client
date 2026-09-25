/** Helpers for turning tool/command output into something a small model can read. */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Remove terminal colour/cursor escape codes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Shorten long output while keeping both ends. Test runners and compilers print
 * the summary (which tests failed, the error count) at the END, so cutting only
 * the tail — the old behaviour — threw away exactly the part the model needs.
 */
export function clipMiddle(text: string, max: number, headShare = 0.35): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = Math.floor(max * headShare);
  const tail = max - head;
  const omitted = t.length - head - tail;
  return `${t.slice(0, head)}\n…(${omitted} chars omitted)…\n${t.slice(t.length - tail)}`;
}

/**
 * Environment for child processes whose output is shown to the model: no colour codes.
 * Deliberately does NOT set CI — Playwright configs use `reuseExistingServer: !process.env.CI`.
 */
export function plainOutputEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...extra };
}
