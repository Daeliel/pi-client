/**
 * Integration harness: a real Pi AgentSession driven by Pi's scripted "faux" model,
 * with pi-client extensions loaded. Each test gets a temp project dir and a temp HOME
 * so user-level ~/.pi config never leaks in.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type FauxResponseStep,
  type JsonObject,
} from "@earendil-works/pi-ai";

export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall };

interface SeenContext {
  messages?: readonly unknown[];
  systemPrompt?: string;
  tools?: readonly { name: string }[];
}

/**
 * What the model is shown on a faux call: the system prompt, the active tool names, and the
 * last message that is not a system message. Pi 1.x sends the prompt and tools as system
 * messages in the transcript (toolsAdded/toolsRemoved), not as context.systemPrompt/tools;
 * the old fields are still read when present.
 */
export function seenBy(context: SeenContext): { systemPrompt: string; tools: string[]; last: unknown } {
  const messages = (context.messages ?? []) as never;
  const lastTurn = [...(context.messages ?? [])].reverse().find((m) => (m as { role?: string }).role !== "system");
  return {
    systemPrompt: context.systemPrompt ?? getCurrentSystemPrompt(messages),
    tools: (context.tools ?? getCurrentTools(messages)).map((t) => t.name),
    last: lastTurn,
  };
}
export type { FauxResponseStep };

export interface HarnessOptions {
  extensions: ExtensionFactory[];
  /** Files to create in the temp project (relative path → content). */
  files?: Record<string, string>;
  /** Session model input modalities. */
  input?: ("text" | "image")[];
  /** Extra models on the same faux provider (share its response queue), e.g. a vision relay. */
  extraModels?: { id: string; input: ("text" | "image")[] }[];
  /**
   * Give extensions a UI (ctx.hasUI true). Listed methods override no-op defaults;
   * select resolves undefined and confirm false unless overridden.
   */
  ui?: Record<string, (...args: never[]) => unknown>;
}

export interface Harness {
  cwd: string;
  home: string;
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  faux: ReturnType<typeof fauxProvider>;
  /** Every user-role message text the model saw, in order (includes extension follow-ups). */
  userMessages(): string[];
  /** Number of model calls made. */
  calls(): number;
  /**
   * Wait until the session has been idle for a moment. Commands send their prompt
   * without awaiting it, so waitForIdle() alone can return before that run starts.
   */
  settle(): Promise<void>;
  dispose(): void;
}

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-client-it-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  // Written before session_start, which is when browser-console auto-connects: a test
  // must never attach to (or launch) the developer's real debug Chrome — an open CDP
  // socket also keeps the test process alive forever.
  writeProjectConfig(cwd, "browser-console.config.json", { autoConnect: false, autoLaunchBrowser: false });
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const file = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  const faux = fauxProvider({
    provider: "faux",
    models: [
      { id: "small", input: opts.input ?? ["text"], reasoning: true, contextWindow: 131072, maxTokens: 8192 },
      ...(opts.extraModels ?? []).map((m) => ({ ...m, contextWindow: 131072, maxTokens: 8192 })),
    ],
    tokensPerSecond: 1_000_000,
  });
  const agentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  // registerNativeProvider refreshes availability in the background; wait for it so
  // getAvailable() (used by vision-relay auto-pick) already lists the faux models.
  await modelRuntime.refresh({ allowNetwork: false });

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: opts.extensions,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  } as ConstructorParameters<typeof DefaultResourceLoader>[0]);
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel("small"),
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
  });
  await session.bindExtensions(opts.ui ? { uiContext: fakeUi(opts.ui) } : {});

  return {
    cwd,
    home,
    session,
    faux,
    calls: () => faux.state.callCount,
    async settle() {
      let quiet = 0;
      for (let i = 0; i < 2000 && quiet < 5; i++) {
        await new Promise((r) => setTimeout(r, 5));
        if (session.isIdle) quiet += 1;
        else {
          quiet = 0;
          await session.waitForIdle();
        }
      }
    },
    userMessages: () =>
      session.messages
        .filter((m) => m.role === "user")
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : m.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
        ),
    dispose() {
      session.dispose();
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevUserProfile;
      // Best effort: on Windows a directory cannot be removed while a child process
      // (e.g. a toolchain probe started at session_start) still runs inside it.
      // Temp-dir cleanup must never fail a test.
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        /* left for the OS temp cleaner */
      }
    },
  };
}

/** Text of a scripted assistant reply that just ends the turn. */
export function reply(text: string) {
  return fauxAssistantMessage(text);
}

/** A scripted assistant message that calls one tool. */
export function call(name: string, args: JsonObject) {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

/** Write `.pi/<name>` config JSON into the harness project. */
export function writeProjectConfig(cwd: string, name: string, value: unknown): void {
  const file = path.join(cwd, ".pi", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * Verify config with one custom language ("app", files *.app) whose test passes
 * when a.app contains "fixed". Built-in languages are off so no real toolchain runs.
 */
export const APP_VERIFY_CONFIG = {
  verifyOnEdit: false,
  languages: {
    python: { enabled: false },
    node: { enabled: false },
    csharp: { enabled: false },
    app: {
      enabled: true,
      extensions: [".app"],
      test: `node -e "process.exit(require('fs').readFileSync('a.app','utf8').includes('fixed')?0:1)"`,
    },
  },
};

/** Scenarios config whose "script" runner is node (no Python/Playwright needed). */
export const NODE_SCENARIOS_CONFIG = {
  script: { command: "node {files}", probe: "node --version" },
  housekeeping: { auditOnAgentEnd: false },
};

/** A scenario script that passes when a.app contains "fixed". */
export const APP_SCENARIO_SCRIPT = `process.exit(require("fs").readFileSync("a.app", "utf8").includes("fixed") ? 0 : 1);\n`;

/**
 * A UI context whose every method is a no-op unless overridden. A plain object, not a
 * Proxy: pi copies the context's own properties, which a Proxy does not have.
 */
function fakeUi(overrides: Record<string, (...args: never[]) => unknown>) {
  const noop = () => undefined;
  const ui: Record<string, unknown> = { theme: {} };
  for (const name of [
    "addAutocompleteProvider", "custom", "editor", "getAllThemes", "getEditorComponent", "getEditorText",
    "getTheme", "getToolsExpanded", "notify", "pasteToEditor", "setEditorComponent", "setEditorText",
    "setFooter", "setHeader", "setHiddenThinkingLabel", "setStatus", "setTheme", "setTitle",
    "setToolsExpanded", "setWidget", "setWorkingIndicator", "setWorkingMessage", "setWorkingVisible",
  ]) {
    ui[name] = noop;
  }
  ui.select = async () => undefined;
  ui.confirm = async () => false;
  ui.input = async () => undefined;
  ui.onTerminalInput = () => () => {};
  return Object.assign(ui, overrides) as never;
}
