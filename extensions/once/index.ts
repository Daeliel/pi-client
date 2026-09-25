import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listOnceModifiers, parseOnceArgs } from "../shared/once";

/**
 * /once <modifier...> <prompt> — apply one-shot modifiers to a single prompt.
 *
 * Modifiers are registered by other foundation extensions via shared/once.ts
 * (polish registers its levels). This extension only owns the command.
 */
export default function (pi: ExtensionAPI) {
  function helpText(): string {
    const mods = listOnceModifiers();
    if (mods.length === 0) return "No one-shot modifiers registered.";
    const width = Math.max(...mods.map((m) => m.name.length));
    const lines = mods.map((m) => `  ${m.name.padEnd(width)}  ${m.description}  (${m.owner})`);
    return ["Usage: /once <modifier> [<modifier> ...] <prompt>", "Applies to that one prompt and its follow-up passes only.", "", ...lines].join("\n");
  }

  pi.registerCommand("once", {
    description: "Run one prompt with one-shot modifiers, e.g. /once ultimate build me a snake game",
    getArgumentCompletions: (prefix: string) => {
      // Complete only the modifier words at the front of the args.
      const parts = prefix.split(/\s+/);
      const current = parts[parts.length - 1] ?? "";
      const head = parts.slice(0, -1);
      if (head.some((w) => !listOnceModifiers().some((m) => m.name === w.toLowerCase()))) return null;
      const items = listOnceModifiers()
        .filter((m) => !head.includes(m.name) && m.name.startsWith(current.toLowerCase()))
        .map((m) => ({ value: [...head, m.name].join(" "), label: m.name, description: m.description }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseOnceArgs(args);
      if (parsed.unknownFirst) {
        ctx.ui.notify(`Unknown modifier "${parsed.unknownFirst}".\n\n${helpText()}`, "warning");
        return;
      }
      if (parsed.modifiers.length === 0) {
        ctx.ui.notify(helpText(), "info");
        return;
      }
      if (!parsed.prompt) {
        ctx.ui.notify(`No prompt after ${parsed.modifiers.map((m) => m.name).join(" ")}.\n\n${helpText()}`, "warning");
        return;
      }
      let text = parsed.prompt;
      for (const mod of parsed.modifiers) {
        mod.apply();
        if (mod.transform) text = mod.transform(text);
      }
      ctx.ui.notify(`Once: ${parsed.modifiers.map((m) => m.name).join(" + ")} for this prompt.`, "info");
      if (ctx.isIdle()) {
        pi.sendUserMessage(text);
      } else {
        pi.sendUserMessage(text, { deliverAs: "followUp" });
      }
    },
  });
}
