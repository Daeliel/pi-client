import * as fs from "node:fs";
import * as path from "node:path";

/** First-class stacks the foundation can detect and hint for. */
export type StackId =
  | "node"
  | "python"
  | "flutter"
  | "dotnet"
  | "static-web"
  | "go"
  | "rust"
  | "unknown";

export interface PlaywrightServeHint {
  /** webServer.command for .pi/playwright.config.ts */
  command: string;
  /** webServer.url / use.baseURL */
  url: string;
  note: string;
}

export interface StackDetection {
  stacks: StackId[];
  primary: StackId;
  /** True when UI proof via Playwright is likely relevant. */
  hasWebUi: boolean;
  /** Suggested Playwright serve settings (null if no web UI detected). */
  playwright: PlaywrightServeHint | null;
  /** One-line summary for doctor / prompts. */
  summary: string;
  signals: string[];
}

function exists(cwd: string, rel: string): boolean {
  return fs.existsSync(path.join(cwd, rel));
}

function readText(cwd: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(cwd, rel), "utf8");
  } catch {
    return null;
  }
}

function hasCsproj(cwd: string): boolean {
  try {
    for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (entry.isFile() && /\.csproj$/i.test(entry.name)) return true;
      if (entry.isFile() && /\.sln$/i.test(entry.name)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function hasHtmlAtRoot(cwd: string): boolean {
  try {
    return fs.readdirSync(cwd).some((n) => /\.html?$/i.test(n));
  } catch {
    return false;
  }
}

function packageHasScript(cwd: string, name: string): boolean {
  const raw = readText(cwd, "package.json");
  if (!raw) return false;
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts?.[name]);
  } catch {
    return false;
  }
}

function isFlutterPubspec(cwd: string): boolean {
  const raw = readText(cwd, "pubspec.yaml");
  if (!raw) return false;
  return /\bflutter\s*:/m.test(raw) || /\bsdk:\s*flutter\b/m.test(raw);
}

/**
 * Detect project stacks from filesystem signals.
 * Unknown stacks stay open — detection only sets hints, never hard-fails.
 */
export function detectStacks(cwd: string): StackDetection {
  const stacks: StackId[] = [];
  const signals: string[] = [];

  if (exists(cwd, "pubspec.yaml") && isFlutterPubspec(cwd)) {
    stacks.push("flutter");
    signals.push("pubspec.yaml (flutter)");
  }

  if (exists(cwd, "package.json")) {
    stacks.push("node");
    signals.push("package.json");
  }

  if (
    exists(cwd, "pyproject.toml") ||
    exists(cwd, "requirements.txt") ||
    exists(cwd, "setup.py") ||
    exists(cwd, "Pipfile")
  ) {
    stacks.push("python");
    signals.push(
      exists(cwd, "pyproject.toml")
        ? "pyproject.toml"
        : exists(cwd, "requirements.txt")
          ? "requirements.txt"
          : "python project file",
    );
  }

  if (hasCsproj(cwd)) {
    stacks.push("dotnet");
    signals.push(".csproj/.sln");
  }

  if (exists(cwd, "go.mod")) {
    stacks.push("go");
    signals.push("go.mod");
  }

  if (exists(cwd, "Cargo.toml")) {
    stacks.push("rust");
    signals.push("Cargo.toml");
  }

  const flutter = stacks.includes("flutter");
  const node = stacks.includes("node");
  const staticWeb =
    !flutter &&
    !node &&
    (hasHtmlAtRoot(cwd) || exists(cwd, "index.html") || exists(cwd, "www") || exists(cwd, "public/index.html"));

  if (staticWeb) {
    stacks.push("static-web");
    signals.push("static html/css");
  }

  if (stacks.length === 0) {
    stacks.push("unknown");
    signals.push("no known manifest");
  }

  const hasWebUi =
    flutter ||
    staticWeb ||
    (node &&
      (packageHasScript(cwd, "dev") ||
        packageHasScript(cwd, "start") ||
        exists(cwd, "vite.config.ts") ||
        exists(cwd, "vite.config.js") ||
        exists(cwd, "index.html")));

  let playwright: PlaywrightServeHint | null = null;
  if (flutter) {
    const hasBuildWeb = exists(cwd, "build/web");
    playwright = hasBuildWeb
      ? {
          command: 'npx --yes serve build/web -l 5173',
          url: "http://localhost:5173",
          note: "Flutter: prefer `flutter build web` then serve build/web (or flutter run -d web-server).",
        }
      : {
          command: "flutter run -d web-server --web-port=5173",
          url: "http://localhost:5173",
          note: "Flutter web: run web-server or build/web + static server. Rebuild after Dart edits.",
        };
  } else if (node && (packageHasScript(cwd, "dev") || exists(cwd, "vite.config.ts") || exists(cwd, "vite.config.js"))) {
    playwright = {
      command: "npm run dev",
      url: "http://localhost:5173",
      note: "Node/Vite-style: npm run dev (edit port if your app differs).",
    };
  } else if (node && packageHasScript(cwd, "start")) {
    playwright = {
      command: "npm start",
      url: "http://localhost:3000",
      note: "Node: npm start — confirm port in AGENTS.md / playwright config.",
    };
  } else if (staticWeb || hasHtmlAtRoot(cwd)) {
    playwright = {
      command: 'npx --yes serve . -l 5173',
      url: "http://localhost:5173",
      note: "Static HTML/CSS: serve the folder (adjust root if needed).",
    };
  } else if (hasWebUi) {
    playwright = {
      command: "npm run dev",
      url: "http://localhost:5173",
      note: "Web UI suspected — set webServer/baseURL for this app.",
    };
  }

  const primary =
    flutter ? "flutter" : node ? "node" : stacks.includes("dotnet") ? "dotnet" : stacks.includes("python") ? "python" : stacks[0]!;

  const summary =
    stacks[0] === "unknown"
      ? "Stack: unknown — use verify/scenarios runners that match the project; /doctor for hints."
      : `Stack: ${stacks.join(", ")}${hasWebUi ? " (web UI)" : ""}.`;

  return { stacks, primary, hasWebUi, playwright, summary, signals };
}

/** True when path looks like a web/UI source file. */
export function isWebPath(filePath: string): boolean {
  const n = filePath.replace(/\\/g, "/").toLowerCase();
  return /\.(html?|css|scss|less|jsx?|tsx?|vue|svelte|dart)$/i.test(n) || n.includes("/web/");
}

/** Whether this turn should inject web/browser lane procedures. */
export function shouldInjectWebProcedure(cwd: string, changedFiles: Iterable<string> = []): boolean {
  const detection = detectStacks(cwd);
  if (detection.hasWebUi) return true;
  for (const f of changedFiles) {
    if (isWebPath(f)) return true;
  }
  return false;
}

export function formatStackDoctorLines(detection: StackDetection): string[] {
  const lines = [
    detection.summary,
    `Signals: ${detection.signals.join(", ") || "(none)"}`,
  ];
  if (detection.playwright) {
    lines.push(`Playwright hint: ${detection.playwright.command} → ${detection.playwright.url}`);
    lines.push(`Note: ${detection.playwright.note}`);
  }
  return lines;
}
