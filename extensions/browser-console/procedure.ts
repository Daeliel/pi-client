import { WEB_TOOLING_CORE, WEB_LANE_DETAILS } from "../shared/web-tooling-guide";

/** Short Lane B core — web details only when web procedure is injected. */
export const BROWSER_CORE = `
## Lane B — browser_* (CDP observe only)

Observe while coding — these tools do NOT drive UI and do NOT prove flows.

Use: browser_errors, browser_network_errors, browser_reload, browser_navigate, browser_screenshot (cosmetic).
Do NOT use for clicks or acceptance proof → Lane A (run_scenarios).
Tools auto-connect / auto-launch debug Chrome when needed.
`.trim();

export function buildBrowserProcedure(includeWebGuide: boolean): string {
  if (!includeWebGuide) return BROWSER_CORE;
  return `${WEB_TOOLING_CORE}\n\n${WEB_LANE_DETAILS}\n\n${BROWSER_CORE}`;
}

/** @deprecated Prefer buildBrowserProcedure(includeWebGuide). */
export const BROWSER_PROCEDURE = buildBrowserProcedure(true);
