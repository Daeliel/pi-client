import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, type BrowserConsoleConfig } from "./config";
import { CdpBrowser, isWebFile, formatReportForConfig, formatNetworkReport, formatStatus, isFailureEntry, sleep } from "./cdp";
import { ensureDebugBrowserRunning, isCdpConnectionError } from "./launch";
import { BROWSER_CORE } from "./procedure";
import type { ConsoleEntry } from "./types";
import type { PageTarget } from "./types";
import { ensurePlaywrightProjectDeps } from "../scenarios/engine";
import { loadConfig as loadScenariosConfig } from "../scenarios/config";
import { buildPlaywrightConfigTemplate } from "../scenarios/templates";
import { capturePageScreenshot, loadVisionImages } from "../scenarios/vision";
import { presentVisionToSession } from "../shared/vision-relay";
import { resetGateClaim, tryClaimGate, isGateClaimed } from "../shared/gate-orchestrator";
import { detectStacks, shouldInjectWebProcedure } from "../shared/stack-detect";
import { withGateWorkingMessage } from "../shared/working-status";

const EDIT_TOOLS = new Set(["write", "edit", "create", "multiedit", "apply_patch", "str_replace"]);
const STATE_TYPE = "foundation-browser-console-state";

interface PersistedState {
  changedWebFiles?: string[];
  fixAttempts?: number;
}

function extractPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "filename", "file"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function failureEntries(browser: CdpBrowser, config: BrowserConsoleConfig): ConsoleEntry[] {
  return browser.getBuffered(config.includeWarnings);
}

function ensureMinimalPlaywrightConfig(cwd: string): void {
  const rel = ".pi/playwright.config.ts";
  const abs = path.join(cwd, rel);
  if (fs.existsSync(abs)) return;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const detection = detectStacks(cwd);
  fs.writeFileSync(abs, buildPlaywrightConfigTemplate(detection.playwright), "utf8");
}

export default function (pi: ExtensionAPI) {
  const browser = new CdpBrowser();
  const changedWebFiles = new Set<string>();
  let fixAttempts = 0;
  let configCache: BrowserConsoleConfig | null = null;

  function cfg(ctx: ExtensionContext): BrowserConsoleConfig {
    if (!configCache) configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  function persist() {
    pi.appendEntry<PersistedState>(STATE_TYPE, {
      changedWebFiles: [...changedWebFiles],
      fixAttempts,
    });
  }

  async function connectWithLaunch(
    config: BrowserConsoleConfig,
    urlPatterns?: string[],
    openUrl?: string,
  ): Promise<PageTarget> {
    try {
      return await browser.connect(config, urlPatterns);
    } catch (e) {
      const msg = (e as Error).message;
      if (!config.autoLaunchBrowser || !isCdpConnectionError(msg)) throw e;
      await ensureDebugBrowserRunning(config, openUrl ?? config.launchUrl);
      return await browser.connect(config, urlPatterns);
    }
  }

  async function ensureConnect(
    ctx: ExtensionContext,
    config: BrowserConsoleConfig,
    openUrl?: string,
  ): Promise<boolean> {
    if (browser.connected) return true;
    try {
      await connectWithLaunch(config, undefined, openUrl);
      if (ctx.hasUI) {
        ctx.ui.notify(`Browser console: connected to ${browser.targetInfo?.title ?? "tab"}`, "info");
      }
      return true;
    } catch (e) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Browser console: could not connect to ${config.cdpHost}:${config.cdpPort} — ${(e as Error).message}`,
          "warning",
        );
      }
      return false;
    }
  }

  async function requireConnection(
    ctx: ExtensionContext,
    config: BrowserConsoleConfig,
    openUrl?: string,
  ): Promise<void> {
    const ok = await ensureConnect(ctx, config, openUrl);
    if (!ok || !browser.connected) {
      throw new Error(
        "Browser CDP not available after auto-launch attempt. " +
          "Use browser_screenshot for visuals (Playwright fallback), or set browserExecutable in browser-console.config.json.",
      );
    }
  }

  async function listPagesWithLaunch(config: BrowserConsoleConfig, port: number) {
    const host = config.cdpHost;
    try {
      return await browser.listPages(host, port);
    } catch (e) {
      const msg = (e as Error).message;
      if (!config.autoLaunchBrowser || !isCdpConnectionError(msg)) throw e;
      await ensureDebugBrowserRunning({ ...config, cdpPort: port }, config.launchUrl);
      return await browser.listPages(host, port);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) {
        const data = entry.data as PersistedState | undefined;
        changedWebFiles.clear();
        for (const f of data?.changedWebFiles ?? []) changedWebFiles.add(f);
        fixAttempts = data?.fixAttempts ?? 0;
      }
    }

    const config = cfg(ctx);
    if (!config.enabled) return;

    if (config.autoConnect) {
      await ensureConnect(ctx, config);
    } else if (ctx.hasUI) {
      ctx.ui.notify(
        "Browser console: start Chrome with --remote-debugging-port=9222, open your app, then /browser connect",
        "info",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    await browser.disconnect();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    resetGateClaim();
    configCache = null;
    fixAttempts = 0;
    const config = cfg(ctx);
    if (!config.blocking) {
      changedWebFiles.clear();
      persist();
    }
    if (!config.enabled) return;
    // Keep Lane B short — scenarios extension owns the A/B decision table when web is relevant.
    if (!shouldInjectWebProcedure(ctx.cwd, changedWebFiles)) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${BROWSER_CORE}`,
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || !config.checkOnEdit || !EDIT_TOOLS.has(event.toolName)) return;

    const p = extractPath(event.input);
    if (!p || !isWebFile(p)) return;

    if (!changedWebFiles.has(p)) {
      changedWebFiles.add(p);
      persist();
    }
    if (event.isError) return;

    if (!browser.connected) {
      if (!config.autoConnect) return;
      const ok = await ensureConnect(ctx, config);
      if (!ok) return;
    }

    try {
      const issues = await browser.checkAfterEdit(config, ctx.signal);
      if (issues.length === 0) return;
      const report = formatReportForConfig(issues, `[browser console] Issues after editing ${p}:`, config);
      return {
        isError: true,
        content: [...event.content, { type: "text", text: `\n\n${report}` }],
      };
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const note = `\n\n[browser console] Check failed: ${(e as Error).message}`;
      return {
        content: [...event.content, { type: "text", text: note }],
      };
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const config = cfg(ctx);
    if (!config.enabled || !config.blocking || changedWebFiles.size === 0) return;
    if (isGateClaimed()) return;

    await withGateWorkingMessage(ctx, "Checking browser console — inference idle", async () => {
      if (!browser.connected) {
        if (config.autoConnect) await ensureConnect(ctx, config);
        if (!browser.connected) return;
      }

      const issues = failureEntries(browser, config);
      if (ctx.signal?.aborted) return;

      if (issues.length === 0) {
        changedWebFiles.clear();
        fixAttempts = 0;
        persist();
        return;
      }

      if (fixAttempts >= config.maxFixAttempts) {
        ctx.ui.notify(
          `Browser console still has errors after ${config.maxFixAttempts} attempts — stopping the fix loop. Run /browser errors`,
          "error",
        );
        changedWebFiles.clear();
        fixAttempts = 0;
        persist();
        return;
      }

      if (!tryClaimGate("browser")) return;

      fixAttempts += 1;
      persist();
      const report = formatReportForConfig(
        issues,
        `Browser console errors remain (attempt ${fixAttempts}/${config.maxFixAttempts}). Fix before finishing:`,
        config,
      );
      pi.sendUserMessage(report, { deliverAs: "followUp" });
    });
  });

  pi.registerTool({
    name: "browser_connect",
    label: "Browser Connect",
    description:
      "[Lane B — CDP observe] Connect to live debug Chrome. Rarely needed — tools auto-connect. " +
      "Does not share state with Playwright (Lane A).",
    parameters: Type.Object({
      port: Type.Optional(Type.Number({ description: "CDP port (default from config, usually 9222)." })),
      urlMatch: Type.Optional(
        Type.String({
          description: "Substring to pick a tab URL (overrides config urlMatch for this connect).",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const connectConfig = { ...config, cdpPort: params.port ?? config.cdpPort };
      const patterns = params.urlMatch ? [params.urlMatch] : config.urlMatch;
      const target = await connectWithLaunch(connectConfig, patterns);
      return {
        content: [
          {
            type: "text",
            text: `Connected to "${target.title}" at ${target.url} (CDP ${connectConfig.cdpHost}:${connectConfig.cdpPort})`,
          },
        ],
        details: { url: target.url, title: target.title },
      };
    },
  });

  pi.registerTool({
    name: "browser_list_pages",
    label: "Browser List Pages",
    description: "List open browser tabs via CDP. Auto-launches debug Chrome if CDP is unreachable.",
    parameters: Type.Object({
      port: Type.Optional(Type.Number({ description: "CDP port (default from config)." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const port = params.port ?? config.cdpPort;
      const pages = await listPagesWithLaunch(config, port);
      const lines = pages.map((p) => `- ${p.title} — ${p.url}`);
      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : "(no pages)" }],
        details: { pages },
      };
    },
  });

  pi.registerTool({
    name: "browser_status",
    label: "Browser Status",
    description: "Show CDP connection status and buffered console error counts.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const text = formatStatus(browser.status(config.includeWarnings));
      return {
        content: [{ type: "text", text }],
        details: browser.status(config.includeWarnings),
      };
    },
  });

  pi.registerTool({
    name: "browser_console",
    label: "Browser Console",
    description: "Return recent browser console messages (errors/warnings by default).",
    parameters: Type.Object({
      level: Type.Optional(
        Type.String({
          description: "error | warn | all — default: errors + uncaught (warn only if includeWarnings in config).",
        }),
      ),
      clear: Type.Optional(Type.Boolean({ description: "Clear buffer after reading." })),
      reload: Type.Optional(Type.Boolean({ description: "Reload tab before reading." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      if (!browser.connected) await requireConnection(ctx, config);
      if (params.reload) {
        await browser.reload(true);
        await browser.checkAfterEdit({ ...config, autoReloadOnEdit: false }, signal);
      }
      const level = params.level ?? "error";
      let entries = browser.getAllBuffered();
      if (level === "error") {
        entries = entries.filter((e) => isFailureEntry(e, false));
      } else if (level === "warn") {
        entries = entries.filter((e) => e.type === "warn");
      }
      const report = formatReportForConfig(entries, "Browser console:", config);
      if (params.clear) browser.clearBuffer();
      return {
        content: [{ type: "text", text: report }],
        details: { count: entries.length },
      };
    },
  });

  pi.registerTool({
    name: "browser_errors",
    label: "Browser Errors",
    description:
      "[Lane B — CDP observe] Console/uncaught errors on the live debug Chrome tab. " +
      "Does not prove UI flows — use run_scenarios for that (Lane A).",
    parameters: Type.Object({
      clear: Type.Optional(Type.Boolean()),
      reload: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      if (!browser.connected) await requireConnection(ctx, config);
      if (params.reload) {
        await browser.reload(true);
        await browser.checkAfterEdit({ ...config, autoReloadOnEdit: false }, signal);
      }
      const entries = browser.getBuffered(config.includeWarnings);
      const report = formatReportForConfig(entries, "Browser errors:", config);
      if (params.clear) browser.clearBuffer();
      return {
        content: [{ type: "text", text: report }],
        details: { count: entries.length },
        isError: entries.length > 0,
      };
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "[Lane B — CDP observe] Optional snapshot of live debug Chrome. Cosmetic only — NOT proof after run_scenarios passes. " +
      "Cannot click. For click+proof use Playwright specs (Lane A). Auto-launches CDP or falls back to Playwright capture.",
    promptSnippet: "Live-tab screenshot only (Lane B — not proof)",
    promptGuidelines: [
      "Do NOT use after run_scenarios passed to verify the same click — different browser.",
      "Do NOT use to drive or prove UI — write Playwright specs instead.",
      "Use for optional live Chrome layout peek, or when user asks how live tab looks.",
    ],
    parameters: Type.Object({
      label: Type.Optional(Type.String({ description: "Short label for this capture." })),
      urlPath: Type.Optional(
        Type.String({
          description: "Page path for Playwright fallback (default /). Edit .pi/playwright.config.ts baseURL/webServer if needed.",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const label = params.label ? ` (${params.label})` : "";
      const urlPath = params.urlPath ?? "/";

      if (!browser.connected) {
        await ensureConnect(ctx, config, config.launchUrl);
      }

      if (browser.connected) {
        try {
          const shot = await browser.captureScreenshot({ format: "jpeg", quality: 80 });
          const url = browser.targetInfo?.url ?? "attached tab";
          const intro = `Browser screenshot${label} of ${url} (live Chrome via CDP):`;
          const images = [{ type: "image" as const, mimeType: shot.mimeType, data: shot.data }];
          const content = await presentVisionToSession(ctx, intro, images, []);
          return {
            content,
            details: { url, mode: "cdp" },
          };
        } catch {
          // fall through to Playwright
        }
      }

      if (!config.playwrightFallback) {
        throw new Error(
          "CDP screenshot failed and playwrightFallback is disabled. Enable it in browser-console.config.json.",
        );
      }

      ensureMinimalPlaywrightConfig(ctx.cwd);
      await ensurePlaywrightProjectDeps(ctx.cwd);
      const scenariosConfig = loadScenariosConfig(ctx.cwd);
      const outputRel = ".pi/browser-capture.jpg";
      const capture = await capturePageScreenshot(ctx.cwd, scenariosConfig, urlPath, outputRel, signal);
      if (!capture.ok) {
        throw new Error(
          `Screenshot failed. CDP: not connected. Playwright: ${capture.error ?? "unknown error"}. ` +
            "Ensure the dev server is running and .pi/playwright.config.ts webServer/baseURL match this app.",
        );
      }

      const abs = path.join(ctx.cwd, capture.outputPath);
      const { images, paths } = await loadVisionImages([abs], scenariosConfig);
      const intro = `Browser screenshot${label} at ${urlPath} (Playwright — CDP was unavailable):`;
      const content = await presentVisionToSession(ctx, intro, images, paths);
      return {
        content,
        details: { ok: true, path: capture.outputPath, mode: "playwright" },
      };
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description:
      "Navigate the attached browser tab to a URL. Keeps the same CDP connection — use this instead of killing/restarting the browser when you need a different page.",
    parameters: Type.Object({
      url: Type.String({ description: "Full URL or site-relative path (e.g. http://localhost:5173/settings or /settings)." }),
      waitMs: Type.Optional(
        Type.Number({ description: "Milliseconds to wait after navigation before returning (default from config)." }),
      ),
      clear: Type.Optional(Type.Boolean({ description: "Clear the console buffer after navigating (default true)." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      const rawUrl = params.url.trim();
      if (!browser.connected) {
        const launchUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : config.launchUrl;
        await requireConnection(ctx, config, launchUrl);
      }

      let url = rawUrl;
      if (url.startsWith("/")) {
        const base = browser.targetInfo?.url;
        if (base) {
          try {
            url = new URL(url, base).href;
          } catch {
            // keep as-is; CDP will report if invalid
          }
        }
      }

      if (params.clear !== false) browser.clearBuffer();
      const wait = params.waitMs ?? config.reloadWaitMs;
      const result = await browser.navigate(url, wait, signal);
      const issues = browser.getBuffered(config.includeWarnings);
      const suffix =
        issues.length > 0
          ? `\n\nConsole after navigation:\n${formatReportForConfig(issues, undefined, config)}`
          : "\n\n(no console errors after navigation)";
      return {
        content: [
          {
            type: "text",
            text: `Navigated to ${result.url}${result.title ? ` ("${result.title}")` : ""}${suffix}`,
          },
        ],
        details: { url: result.url, title: result.title, errorCount: issues.length },
      };
    },
  });

  pi.registerTool({
    name: "browser_reload",
    label: "Browser Reload",
    description: "Reload the current URL in the attached browser tab (use after editing web assets). Does not change the URL — use browser_navigate for that.",
    parameters: Type.Object({
      waitMs: Type.Optional(Type.Number({ description: "Wait after reload before returning (default from config)." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      if (!browser.connected) await requireConnection(ctx, config);
      await browser.reload(true);
      const wait = params.waitMs ?? config.reloadWaitMs;
      if (wait > 0) await sleep(wait, signal);
      const issues = browser.getBuffered(config.includeWarnings);
      const suffix =
        issues.length > 0
          ? `\n\nAfter reload:\n${formatReportForConfig(issues, undefined, config)}`
          : "\n\n(no console errors after reload)";
      return {
        content: [{ type: "text", text: `Reloaded ${browser.targetInfo?.url ?? "tab"}${suffix}` }],
        details: { errorCount: issues.length },
      };
    },
  });

  pi.registerTool({
    name: "browser_network_errors",
    label: "Browser Network Errors",
    description:
      "[Lane B — CDP observe] Failed HTTP requests (4xx/5xx, load failures) on the live tab. Workflow B dev guardrail.",
    parameters: Type.Object({
      clear: Type.Optional(Type.Boolean({ description: "Clear network buffer after reading." })),
      reload: Type.Optional(Type.Boolean({ description: "Reload tab before reading." })),
      minStatus: Type.Optional(
        Type.Number({ description: "Minimum HTTP status to report (default 400). Load failures always included." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      if (!browser.connected) await requireConnection(ctx, config);
      if (params.reload) {
        browser.clearBuffer();
        await browser.reload(true);
        await browser.checkAfterEdit({ ...config, autoReloadOnEdit: false }, signal);
      }
      const minStatus = params.minStatus ?? 400;
      const failures = browser.getNetworkFailures().filter(
        (f) => f.errorText !== undefined || (f.status !== undefined && f.status >= minStatus),
      );
      const report = formatNetworkReport(failures, "Failed network requests:");
      // Report/isError must reflect what was found — clear only empties the buffer for next time.
      if (params.clear) browser.clearBuffer();
      return {
        content: [{ type: "text", text: report }],
        details: { count: failures.length, cleared: Boolean(params.clear) },
        isError: failures.length > 0,
      };
    },
  });

  pi.registerTool({
    name: "browser_disconnect",
    label: "Browser Disconnect",
    description: "Disconnect from the browser CDP session without closing the browser window.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      await browser.disconnect();
      return {
        content: [{ type: "text", text: "Browser console disconnected." }],
        details: { connected: false },
      };
    },
  });

  pi.registerCommand("browser", {
    description: "Browser console via CDP — connect | navigate | network | status | console | errors | reload | pages | disconnect",
    handler: async (args, ctx) => {
      const config = cfg(ctx);
      if (!config.enabled) {
        ctx.ui.notify("Browser console extension is disabled in config.", "warning");
        return;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() ?? "status";

      try {
        if (sub === "connect") {
          const port = parts[1] ? Number(parts[1]) : undefined;
          if (parts[1] && Number.isNaN(port)) {
            ctx.ui.notify("Usage: /browser connect [port]", "warning");
            return;
          }
          const connectConfig = { ...config, cdpPort: port ?? config.cdpPort };
          const target = await connectWithLaunch(connectConfig);
          ctx.ui.notify(`Connected: ${target.title} — ${target.url}`, "info");
          return;
        }

        if (sub === "disconnect") {
          await browser.disconnect();
          ctx.ui.notify("Browser console disconnected.", "info");
          return;
        }

        if (sub === "pages") {
          const pages = await browser.listPages(config.cdpHost, config.cdpPort);
          const text = pages.length
            ? pages.map((p) => `${p.title} — ${p.url}`).join("\n")
            : "(no tabs — is Chrome running with --remote-debugging-port?)";
          ctx.ui.notify(text, "info");
          return;
        }

        if (sub === "status") {
          ctx.ui.notify(formatStatus(browser.status(config.includeWarnings)), "info");
          return;
        }

        if (sub === "console") {
          if (!browser.connected) {
            ctx.ui.notify("Not connected. Run /browser connect first.", "warning");
            return;
          }
          const entries = browser.getAllBuffered();
          const report = formatReportForConfig(entries, "Browser console:", config);
          ctx.ui.notify(report, entries.some((e) => isFailureEntry(e, config.includeWarnings)) ? "error" : "info");
          return;
        }

        if (sub === "errors") {
          if (!browser.connected) {
            ctx.ui.notify("Not connected. Run /browser connect first.", "warning");
            return;
          }
          const entries = browser.getBuffered(config.includeWarnings);
          const report = formatReportForConfig(entries, "Browser errors:", config);
          if (entries.length > 0) {
            ctx.ui.notify(report, "error");
            pi.sendUserMessage(`Browser console errors:\n\n${report}`);
          } else {
            ctx.ui.notify("No browser errors in buffer.", "info");
          }
          return;
        }

        if (sub === "reload") {
          if (!browser.connected) {
            ctx.ui.notify("Not connected. Run /browser connect first.", "warning");
            return;
          }
          await browser.reload(true);
          await browser.checkAfterEdit(config, undefined);
          const issues = browser.getBuffered(config.includeWarnings);
          ctx.ui.notify(
            issues.length ? formatReportForConfig(issues, "After reload:", config) : "Reloaded — no console errors.",
            issues.length ? "error" : "info",
          );
          return;
        }

        if (sub === "navigate" || sub === "goto") {
          if (!browser.connected) {
            ctx.ui.notify("Not connected. Run /browser connect first.", "warning");
            return;
          }
          const rawUrl = parts.slice(1).join(" ").trim();
          if (!rawUrl) {
            ctx.ui.notify("Usage: /browser navigate <url>", "warning");
            return;
          }
          browser.clearBuffer();
          const result = await browser.navigate(rawUrl, config.reloadWaitMs, undefined);
          const issues = browser.getBuffered(config.includeWarnings);
          const suffix = issues.length ? `\n${formatReportForConfig(issues, "Console:", config)}` : " — no console errors";
          ctx.ui.notify(`Navigated to ${result.url}${suffix}`, issues.length ? "error" : "info");
          return;
        }

        if (sub === "network") {
          if (!browser.connected) {
            ctx.ui.notify("Not connected. Run /browser connect first.", "warning");
            return;
          }
          const failures = browser.getNetworkFailures();
          const report = formatNetworkReport(failures, "Failed network requests:");
          ctx.ui.notify(report, failures.length ? "error" : "info");
          return;
        }

        ctx.ui.notify(
          "Usage: /browser connect [port] | navigate <url> | network | status | pages | console | errors | reload | disconnect",
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`Browser console: ${(e as Error).message}`, "error");
      }
    },
  });
}
