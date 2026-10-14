import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  apiKeySource,
  clearUserApiKey,
  loadConfig,
  maskApiKey,
  resolveApiKey,
  saveUserApiKey,
  type ResearchConfig,
} from "./config";
import {
  braveWebSearch,
  fetchPageContent,
  formatKeyError,
  formatSearchResults,
  SETUP_HELP,
} from "./engine";
import { RESEARCH_PROCEDURE } from "./procedure";
import { syncOwnedTools } from "../shared/tool-activation";

const TOOLS = ["web_search", "fetch_web_page"];

export default function (pi: ExtensionAPI) {
  let configCache: ResearchConfig | null = null;

  function cfg(ctx: ExtensionContext): ResearchConfig {
    if (!configCache) configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  function reloadConfig(ctx: ExtensionContext): ResearchConfig {
    configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  // web_search needs a key; fetch_web_page works without one.
  function syncTools(ctx: ExtensionContext) {
    const config = cfg(ctx);
    const wanted = !config.enabled ? [] : resolveApiKey(config) ? TOOLS : ["fetch_web_page"];
    syncOwnedTools(pi, TOOLS, wanted);
  }

  pi.on("input", async (_event, ctx) => {
    reloadConfig(ctx);
    syncTools(ctx);
  });

  pi.on("session_start", async (event, ctx) => {
    reloadConfig(ctx);
    syncTools(ctx);
    if (event.reason !== "startup" && event.reason !== "reload") return;
    const config = cfg(ctx);
    if (!config.enabled) return;
    if (resolveApiKey(config)) return;
    ctx.ui.notify("Web research: no Brave API key — run /research setup in Pi", "info");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const config = cfg(ctx);
    // Without a key web_search is not offered; the lane guide would only point at a missing tool.
    if (!config.enabled || !resolveApiKey(config)) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${RESEARCH_PROCEDURE}`,
    };
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "[Lane C — Research] Search the public web via Brave Search API. " +
      "Use for official docs, API behavior, and errors you cannot resolve from the repo alone — not for proving local UI.",
    promptSnippet: "Search web for docs (Lane C)",
    promptGuidelines: [
      "Use for framework/API documentation when local code and AGENTS.md are insufficient.",
      "Not for localhost app behavior — use run_scenarios or browser_* instead.",
      "One search, then act — do not search repeatedly without a code or test change.",
      "If setup is missing, tell the user to run /research setup.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query — include framework and symbol names." }),
      maxResults: Type.Optional(Type.Number({ description: "1–20 results (default from config)." })),
      includeContent: Type.Optional(
        Type.Boolean({ description: "Fetch readable page text for the top results (default true). Use fetch_web_page for more of one page." }),
      ),
      freshness: Type.Optional(
        Type.String({
          description: "Optional time filter: pd (day), pw (week), pm (month), py (year), or YYYY-MM-DDtoYYYY-MM-DD.",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      if (!config.enabled) {
        return {
          content: [{ type: "text", text: "Web research is disabled in research.config.json." }],
          details: { enabled: false },
          isError: true,
        };
      }
      try {
        const results = await braveWebSearch(
          params.query,
          config,
          {
            maxResults: params.maxResults,
            includeContent: params.includeContent,
            freshness: params.freshness,
          },
          signal,
        );
        return {
          content: [{ type: "text", text: formatSearchResults(results) }],
          details: { count: results.length, query: params.query },
        };
      } catch (e: unknown) {
        const msg = (e as Error).message ?? "search failed";
        if (msg === "NO_API_KEY") {
          return {
            content: [{ type: "text", text: formatKeyError("missing") }],
            details: { error: "NO_API_KEY" },
            isError: true,
          };
        }
        if (msg === "INVALID_API_KEY") {
          return {
            content: [{ type: "text", text: formatKeyError("invalid") }],
            details: { error: "INVALID_API_KEY" },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `web_search failed:\n${msg}` }],
          details: { error: msg },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "fetch_web_page",
    label: "Fetch Web Page",
    description:
      "[Lane C — Research] Fetch a public URL and return readable text (markdown-ish). " +
      "Use after web_search or when you have a doc URL — not for localhost.",
    promptSnippet: "Fetch public URL text (Lane C)",
    promptGuidelines: [
      "Use for official documentation URLs — not http://localhost or file:// paths.",
      "Use fetch_web_page with a URL you already have: from an error message, AGENTS.md, docs you know, or a search result.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Public https URL to fetch." }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      if (!config.enabled) {
        return {
          content: [{ type: "text", text: "Web research is disabled in research.config.json." }],
          details: { enabled: false },
          isError: true,
        };
      }
      const url = params.url.trim();
      if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url)) {
        return {
          content: [
            {
              type: "text",
              text: "Refusing localhost URL — use browser_* or run_scenarios for this app, not fetch_web_page.",
            },
          ],
          details: { url, error: "localhost refused" },
          isError: true,
        };
      }
      try {
        const text = await fetchPageContent(url, config, signal);
        return {
          content: [{ type: "text", text: `URL: ${url}\n\n${text}` }],
          details: { url },
        };
      } catch (e: unknown) {
        const msg = (e as Error).message ?? "unknown";
        return {
          content: [{ type: "text", text: `fetch_web_page failed:\n${msg}` }],
          details: { url, error: msg },
          isError: true,
        };
      }
    },
  });

  pi.registerCommand("research", {
    description: "Web research — setup | status | key <api-key> | key clear",
    handler: async (args, ctx) => {
      reloadConfig(ctx);
      const config = cfg(ctx);
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] ?? "status").toLowerCase();

      if (sub === "setup" || sub === "help") {
        ctx.ui.notify(SETUP_HELP, "info");
        return;
      }

      if (sub === "status") {
        const key = resolveApiKey(config);
        const source = apiKeySource(config);
        const lines = [
          `Research: ${config.enabled ? "enabled" : "disabled"}`,
          key ? `API key: ${maskApiKey(key)} (${source})` : "API key: not configured",
          "",
          "Commands:",
          "  /research setup     — how to get and save a key",
          "  /research key <key> — save key to ~/.pi/research.config.json",
          "  /research key clear — remove saved key (env var unchanged)",
        ];
        ctx.ui.notify(lines.join("\n"), key ? "info" : "warning");
        return;
      }

      if (sub === "key") {
        const action = parts[1]?.toLowerCase();
        if (action === "clear") {
          const cleared = clearUserApiKey();
          reloadConfig(ctx);
          syncTools(ctx);
          ctx.ui.notify(
            cleared ? "Removed saved API key from ~/.pi/research.config.json" : "No saved key in config file",
            "info",
          );
          return;
        }
        const rawKey = parts.slice(1).join(" ").trim();
        if (!rawKey) {
          ctx.ui.notify("Usage: /research key YOUR_BRAVE_API_KEY\nOr: /research key clear", "warning");
          return;
        }
        const savedTo = saveUserApiKey(rawKey);
        reloadConfig(ctx);
        syncTools(ctx);
        ctx.ui.notify(`Saved Brave API key to ${savedTo} (${maskApiKey(rawKey)}). Restart not required.`, "info");
        return;
      }

      ctx.ui.notify("Usage: /research setup | status | key <api-key> | key clear", "warning");
    },
  });
}
