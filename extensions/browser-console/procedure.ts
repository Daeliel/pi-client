import { webLaneDetails, webToolingCore } from "../shared/web-tooling-guide";

/** Short Lane B core — web details only when web procedure is injected. */
export const BROWSER_CORE = `
## Lane B — browser_* (CDP observe only)

Observe while coding — these tools do NOT drive UI and do NOT prove flows.

Use: browser_errors, browser_network_errors, browser_reload, browser_navigate, browser_screenshot (cosmetic).
Do NOT use for clicks or acceptance proof → Lane A (run_scenarios).
Tools auto-connect / auto-launch debug Chrome when needed.
`.trim();

/** For a model that cannot see images: no browser_screenshot. */
export const BROWSER_CORE_BLIND = BROWSER_CORE.replace(", browser_screenshot (cosmetic)", "");

export function buildBrowserProcedure(includeWebGuide: boolean, blind = false): string {
  const core = blind ? BROWSER_CORE_BLIND : BROWSER_CORE;
  if (!includeWebGuide) return core;
  return `${webToolingCore(blind)}\n\n${webLaneDetails(blind)}\n\n${core}`;
}

/** @deprecated Prefer buildBrowserProcedure(includeWebGuide). */
export const BROWSER_PROCEDURE = buildBrowserProcedure(true);
