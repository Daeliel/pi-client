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
  type FauxResponseStep,
} from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";

export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall };
export type { FauxResponseStep };

export interface HarnessOptions {
  extensions: ExtensionFactory[];
  /** Files to create in the temp project (relative path → content). */
  files?: Record<string, string>;
  /** Session model input modalities. */
  input?: ("text" | "image")[];
  /** Extra models on the same faux provider (share its response queue), e.g. a vision relay. */
  extraModels?: { id: string; input: ("text" | "image")[] }[];
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
  dispose(): void;
}

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-client-it-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
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
  await session.bindExtensions({});

  return {
    cwd,
    home,
    session,
    faux,
    calls: () => faux.state.callCount,
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
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Text of a scripted assistant reply that just ends the turn. */
export function reply(text: string) {
  return fauxAssistantMessage(text);
}

/** A scripted assistant message that calls one tool. */
export function call(name: string, args: Record<string, unknown>) {
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
