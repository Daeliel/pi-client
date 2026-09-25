import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

/** Package root (pi-client), resolved from this module's location. */
export function piClientPackageRoot(): string {
  return path.join(fileURLToPath(new URL(".", import.meta.url)), "../..");
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

function loadScaffoldTemplate(): string {
  const templatePath = path.join(piClientPackageRoot(), "templates", "AGENTS.md.example");
  if (!fs.existsSync(templatePath)) {
    throw new Error(`AGENTS.md template missing: ${templatePath}`);
  }
  return fs.readFileSync(templatePath, "utf8");
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

  fs.writeFileSync(target, loadScaffoldTemplate(), "utf8");
  return { created: true, path: target };
}
