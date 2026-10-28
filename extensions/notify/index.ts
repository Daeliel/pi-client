import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, foundationConfigPaths } from "../shared/config-paths";
import { readJsonConfig } from "../shared/json-config";
import { loadConfig as loadPlanConfig } from "../plan/config";
import { autopilotRunning } from "../plan/marks";

/**
 * A desktop notification when Pi needs you: a long run has finished, or a dialog
 * (autopilot approval, playtest's Good / Not right) has waited for an answer.
 * Windows: a toast (any terminal). Elsewhere: OSC 777 / Kitty OSC 99.
 */

interface NotifyConfig {
  enabled: boolean;
  /** Runs shorter than this end quietly — you were probably watching. */
  minSeconds: number;
  /** A dialog left unanswered this long is announced. */
  promptSeconds: number;
}

const DEFAULTS: NotifyConfig = { enabled: true, minSeconds: 30, promptSeconds: 15 };
/** A dialog that opens this soon after a run ends is what the run ended in: one notification, naming it. */
export const SETTLE_GRACE_MS = 1500;

function loadConfig(cwd: string): NotifyConfig {
  let cfg = DEFAULTS;
  for (const file of foundationConfigPaths(cwd, "notify.config.json")) {
    const o = readJsonConfig<Partial<NotifyConfig>>(file);
    if (o) cfg = { ...cfg, ...o };
  }
  return cfg;
}

function persistEnabled(enabled: boolean): string {
  const file = path.join(os.homedir(), CONFIG_DIR_NAME, "notify.config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readJsonConfig<Partial<NotifyConfig>>(file) ?? {};
  fs.writeFileSync(file, `${JSON.stringify({ ...existing, enabled }, null, 2)}\n`, "utf8");
  return file;
}

/** PowerShell's own app id: Windows 10 drops toasts from ids that are not registered. */
const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function toastScript(title: string, body: string): string {
  const t = "Windows.UI.Notifications";
  return [
    `[${t}.ToastNotificationManager, ${t}, ContentType = WindowsRuntime] > $null`,
    `$xml = [${t}.ToastNotificationManager]::GetTemplateContent([${t}.ToastTemplateType]::ToastText02)`,
    `$text = $xml.GetElementsByTagName('text')`,
    // .Item(n): indexing the live node list with [n] enumerates it, which fails.
    `$text.Item(0).AppendChild($xml.CreateTextNode(${psQuote(title)})) > $null`,
    `$text.Item(1).AppendChild($xml.CreateTextNode(${psQuote(body)})) > $null`,
    `[${t}.ToastNotificationManager]::CreateToastNotifier(${psQuote(POWERSHELL_APP_ID)}).Show([${t}.ToastNotification]::new($xml))`,
  ].join("; ");
}

/** Terminal escape codes cannot carry these. */
const oscSafe = (s: string) => s.replace(/[\x00-\x1f\x7f;]/g, " ");

function desktopNotify(title: string, body: string): void {
  if (process.platform === "win32" || process.env.WSL_DISTRO_NAME) {
    // Encoded, so no quoting survives the trip through the shell.
    const encoded = Buffer.from(toastScript(title, body), "utf16le").toString("base64");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true }, () => {});
  } else if (process.env.KITTY_WINDOW_ID) {
    process.stdout.write(`\x1b]99;i=1:d=0;${oscSafe(title)}\x1b\\\x1b]99;i=1:p=body;${oscSafe(body)}\x1b\\`);
  } else {
    process.stdout.write(`\x1b]777;notify;${oscSafe(title)};${oscSafe(body)}\x07`);
  }
}

type Sender = (title: string, body: string) => void;
let sender: Sender = desktopNotify;

/** Tests: catch notifications instead of showing them. */
export function setSender(fn: Sender | null): void {
  sender = fn ?? desktopNotify;
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface LastReply {
  text: string;
  error?: string;
}

function lastReply(ctx: ExtensionContext): LastReply | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i] as { type: string; message?: { role: string; content?: unknown; stopReason?: string; errorMessage?: string } };
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    const m = e.message;
    const text = Array.isArray(m.content)
      ? m.content
          .filter((c: { type?: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("\n")
      : typeof m.content === "string"
        ? m.content
        : "";
    return { text: text.trim(), error: m.stopReason === "error" ? (m.errorMessage ?? "error") : undefined };
  }
  return null;
}

/** What the finished run comes down to, in one line. */
export function doneMessage(reply: LastReply | null, autopilot: "none" | "ended" | "running"): string {
  if (reply?.error) return clip(`Stopped with an error: ${reply.error}`);
  if (autopilot === "ended") return "Autopilot run ended — /autopilot status shows the result.";
  if (autopilot === "running") return "Autopilot stopped and is waiting for you.";
  const lines = (reply?.text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  if (last.endsWith("?")) return clip(`Has a question: ${last}`);
  return lines.length ? clip(`Done: ${lines[0]!.replace(/^[#*>\s-]+/, "")}`) : "Done — ready for you.";
}

export default function (pi: ExtensionAPI) {
  let config = DEFAULTS;
  let runStart: number | null = null;
  let autopilotAtStart = false;
  /** agent_end has fired and the run has not settled yet: gates and dialogs may still come. */
  let settling = false;
  /** The run ended in a dialog, and that was announced: the run end says nothing more. */
  let announced = false;
  /** Run-end notification held back briefly: a dialog may follow. */
  let pending: NodeJS.Timeout | null = null;
  let promptTimer: NodeJS.Timeout | null = null;
  /** A run that just ended was long — the user is likely away. */
  let awayAfterRun = false;

  const title = (ctx: ExtensionContext) => `Pi · ${path.basename(ctx.cwd) || ctx.cwd}`;
  const apRunning = (ctx: ExtensionContext) => autopilotRunning(ctx.cwd, loadPlanConfig(ctx.cwd).blueprintPath);
  const isLong = (since: number) => Date.now() - since >= config.minSeconds * 1000;

  function clearTimers() {
    if (pending) clearTimeout(pending);
    pending = null;
    if (promptTimer) clearTimeout(promptTimer);
    promptTimer = null;
  }

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
  });

  // The user is here: nothing to announce.
  pi.on("input", async (event) => {
    if (event.source === "extension") return;
    clearTimers();
    awayAfterRun = false;
  });

  pi.on("agent_start", async (_event, ctx) => {
    settling = false;
    if (runStart !== null) return;
    config = loadConfig(ctx.cwd);
    runStart = Date.now();
    announced = false;
    autopilotAtStart = config.enabled && apRunning(ctx);
  });

  pi.on("agent_end", async () => {
    settling = true;
  });

  pi.on("agent_settled", async (event, ctx) => {
    const started = runStart;
    runStart = null;
    settling = false;
    if (announced) {
      announced = false;
      return;
    }
    if (!config.enabled || !ctx.hasUI || started === null) return;
    awayAfterRun = isLong(started);
    if (event.aborted || !awayAfterRun) return;
    const autopilot = autopilotAtStart ? (apRunning(ctx) ? "running" : "ended") : "none";
    const body = doneMessage(lastReply(ctx), autopilot);
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      sender(title(ctx), body);
    }, SETTLE_GRACE_MS);
  });

  pi.on("ui_prompt_start", async (event, ctx) => {
    if (!config.enabled || !ctx.hasUI) return;
    const what = clip(`Waiting for you: ${(event.title ?? "a question").split("\n")[0]!.trim()}`);
    // The run ended in this dialog (playtest's verdict, a gate's question): one notification, naming it.
    // Another extension's agent_settled may open it before ours runs, or after.
    if (pending || (settling && runStart !== null && isLong(runStart))) {
      if (pending) clearTimeout(pending);
      pending = null;
      announced = settling;
      sender(title(ctx), what);
      return;
    }
    if (promptTimer) clearTimeout(promptTimer);
    // Right after a long run the user is away: say so now. Otherwise only if it waits.
    const delay = awayAfterRun ? 0 : config.promptSeconds * 1000;
    promptTimer = setTimeout(() => {
      promptTimer = null;
      sender(title(ctx), what);
    }, delay);
  });

  pi.on("ui_prompt_end", async () => {
    if (promptTimer) clearTimeout(promptTimer);
    promptTimer = null;
    awayAfterRun = false;
  });

  pi.on("session_shutdown", async () => {
    clearTimers();
  });

  pi.registerCommand("notify", {
    description: "Desktop notification when Pi is done or waiting for you — on | off | test",
    handler: async (args, ctx) => {
      const wanted = args.trim().toLowerCase();
      if (wanted === "test") {
        sender(title(ctx), "Test notification — this is what Pi shows when it needs you.");
        ctx.ui.notify("Sent a test notification. Nothing appeared? Check Windows Settings → System → Notifications (Windows PowerShell must be allowed) and Focus Assist.", "info");
        return;
      }
      if (wanted !== "on" && wanted !== "off") {
        ctx.ui.notify(
          `Notifications: ${config.enabled ? "on" : "off"} — after runs of ${config.minSeconds}s or more, and when a dialog waits ${config.promptSeconds}s.\n/notify on|off — saved for every project. /notify test`,
          "info",
        );
        return;
      }
      const file = persistEnabled(wanted === "on");
      config = loadConfig(ctx.cwd);
      if (!config.enabled) clearTimers();
      ctx.ui.notify(`Notifications: ${wanted} (saved to ${file}).`, "info");
    },
  });
}
