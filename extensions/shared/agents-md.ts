import * as fs from "node:fs";
import * as path from "node:path";
import { detectStacks } from "./stack-detect";

const CONTEXT_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

const PROJECT_MARKERS = [
  "package.json",
  "pubspec.yaml",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  path.join(".pi", "scenarios"),
];

export interface EnsureAgentsMdResult {
  created: boolean;
  path: string | null;
  skippedReason?: string;
}

function findGitRoot(start: string): string | null {
  let dir = path.resolve(start);
  const root = path.parse(dir).root;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function hasProjectMarkers(dir: string): boolean {
  return PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)));
}

function findExistingContextFile(start: string, stopAt: string): string | null {
  let dir = path.resolve(start);
  const root = path.parse(dir).root;
  while (true) {
    for (const name of CONTEXT_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (dir === stopAt || dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveProjectRoot(cwd: string): string | null {
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) return gitRoot;
  if (hasProjectMarkers(cwd)) return path.resolve(cwd);
  return null;
}

function isPiClientFoundation(projectRoot: string): boolean {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
    return pkg.name === "pi-client";
  } catch {
    return false;
  }
}

function packageScripts(projectRoot: string): Record<string, string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * AGENTS.md content built from what can be detected — never example text.
 *
 * The old scaffold copied a template full of "(e.g. Flutter web, React + Vite)"
 * placeholders. AGENTS.md is read on every turn, and small models took those
 * examples as facts about the project. Sections the user still has to fill in are
 * HTML comments; lines outside comments are true for this project.
 */
export function renderAgentsMd(projectRoot: string, platform: NodeJS.Platform = process.platform): string {
  const detection = detectStacks(projectRoot);
  const scripts = packageScripts(projectRoot);
  const scriptLines = Object.entries(scripts)
    .filter(([name]) => ["dev", "start", "build", "test", "lint", "typecheck", "preview"].includes(name))
    .map(([name, cmd]) => `- \`npm run ${name}\` → \`${cmd}\``);

  const lines = [
    "# Project notes for Pi",
    "",
    "<!-- Created by pi-client from what it could detect. Read on every turn: keep it short and true. -->",
    "",
    "## Stack",
    "",
    `- ${detection.summary}`,
  ];
  if (scriptLines.length > 0) lines.push("", "## Commands", "", ...scriptLines);
  if (detection.playwright) {
    lines.push(
      "",
      "## Dev server",
      "",
      `- Acceptance tests start the app with \`${detection.playwright.command}\` at ${detection.playwright.url} (see .pi/playwright.config.ts — keep it matching how this app really starts).`,
    );
  }
  if (platform === "win32") {
    lines.push("", "## Shell", "", "- Windows: when a command runs in Windows PowerShell 5, chain commands with `;` — `&&` fails there.");
  }
  lines.push(
    "",
    "## Rules",
    "",
    "<!-- Add what the agent cannot infer: folder layout, files not to touch, naming patterns, known quirks. -->",
    "",
  );
  return lines.join("\n");
}

/**
 * Create AGENTS.md at the project root when missing (never overwrites).
 * Skips pi-client foundation repo and dirs that already have context files upstream.
 */
export function ensureAgentsMd(cwd: string): EnsureAgentsMdResult {
  const projectRoot = resolveProjectRoot(cwd);
  if (!projectRoot) {
    return { created: false, path: null, skippedReason: "not a recognized project directory" };
  }

  if (isPiClientFoundation(projectRoot)) {
    return { created: false, path: null, skippedReason: "pi-client foundation repo" };
  }

  const existing = findExistingContextFile(cwd, projectRoot);
  if (existing) {
    return { created: false, path: existing, skippedReason: "context file already present" };
  }

  const target = path.join(projectRoot, "AGENTS.md");
  if (fs.existsSync(target)) {
    return { created: false, path: target, skippedReason: "AGENTS.md already exists" };
  }

  fs.writeFileSync(target, renderAgentsMd(projectRoot), "utf8");
  return { created: true, path: target };
}
