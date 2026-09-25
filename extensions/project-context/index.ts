import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureAgentsMd } from "../shared/agents-md";
import { reportConfigErrors } from "../shared/json-config";

const AUTO_SCAFFOLD_REASONS = new Set(["startup", "new"]);

/** AGENTS.md created this session before context files were loaded — inject once on first turn. */
let pendingAgentsInject: string | null = null;

function formatAgentsInject(agentsPath: string, content: string): string {
  return `${content.trim()}\n\n<!-- injected from ${agentsPath} (auto-scaffolded this session) -->`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    reportConfigErrors(ctx);
    if (!AUTO_SCAFFOLD_REASONS.has(event.reason)) return;

    const result = ensureAgentsMd(ctx.cwd);
    if (!result.created || !result.path) return;

    pendingAgentsInject = result.path;
    ctx.ui.notify(
      `Created ${result.path} — fill in project notes. Loaded for this session; /reload after edits.`,
      "info",
    );
  });

  // session_start cannot call ctx.reload() — only ExtensionCommandContext has it.
  // Inject the new file on the first agent turn instead.
  pi.on("before_agent_start", async (event, ctx) => {
    // Every foundation extension reads its JSON config through shared/json-config;
    // broken files are collected there and shown once, from here.
    reportConfigErrors(ctx);
    if (!pendingAgentsInject) return;

    const agentsPath = pendingAgentsInject;
    pendingAgentsInject = null;

    if (!fs.existsSync(agentsPath)) return;

    const alreadyLoaded = event.systemPromptOptions.contextFiles?.some(
      (file) => file.path === agentsPath || file.path.endsWith("AGENTS.md"),
    );
    if (alreadyLoaded) return;

    const content = fs.readFileSync(agentsPath, "utf8");
    return {
      systemPrompt: `${event.systemPrompt}\n\n${formatAgentsInject(agentsPath, content)}`,
    };
  });

  pi.registerCommand("agents-init", {
    description: "Create AGENTS.md from template if missing (project root)",
    handler: async (_args, ctx) => {
      const result = ensureAgentsMd(ctx.cwd);
      if (result.created && result.path) {
        ctx.ui.notify(`Created ${result.path} — reloading…`, "info");
        await ctx.reload();
        return;
      }
      if (result.path) {
        ctx.ui.notify(`Context file already present: ${result.path}`, "info");
        return;
      }
      ctx.ui.notify(result.skippedReason ?? "AGENTS.md was not created", "warning");
    },
  });
}
