import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

/**
 * Per-item checkpoints: the run works on its own autopilot/<slug> branch and commits
 * after every item, so an unattended run can be undone item by item. Never pushes,
 * never rewrites anything outside the run branch.
 */

const pexec = promisify(execFile);

export interface GitResult {
  ok: boolean;
  out: string;
}

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await pexec("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "git failed" };
  }
}

export async function gitAvailable(cwd: string): Promise<boolean> {
  return (await git(cwd, ["--version"])).ok;
}

export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.out === "true";
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).out;
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).out;
}

/** Number of changed/untracked paths in the working tree. */
export async function dirtyCount(cwd: string): Promise<number> {
  const r = await git(cwd, ["status", "--porcelain"]);
  return r.ok && r.out ? r.out.split(/\r?\n/).length : 0;
}

/** Branch-safe name from the goal: whole words, at most ~40 characters. */
export function slugify(text: string): string {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let slug = "";
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > 40) break;
    slug = next;
  }
  return slug || words[0]?.slice(0, 40) || "run";
}

async function hasCommits(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
}

async function commitAll(cwd: string, message: string): Promise<GitResult> {
  const add = await git(cwd, ["add", "-A"]);
  if (!add.ok) return add;
  const commit = await git(cwd, ["commit", "--allow-empty", "--no-verify", "-m", message]);
  if (!commit.ok) return commit;
  return { ok: true, out: await headSha(cwd) };
}

export interface RunBranch {
  branch: string;
  /** Branch the user was on (restored by nothing — reported so they can switch back). */
  from: string;
  /** Commit the run started from (after the starting-point commit, if any). */
  baseSha: string;
}

/** Create autopilot/<slug> from HEAD and switch to it; commit uncommitted work first. */
export async function startRunBranch(cwd: string, slug: string): Promise<{ ok: true; run: RunBranch } | { ok: false; error: string }> {
  if (!(await hasCommits(cwd))) {
    const first = await commitAll(cwd, "autopilot: starting point");
    if (!first.ok) return { ok: false, error: first.out };
  }
  const from = await currentBranch(cwd);
  let branch = `autopilot/${slug}`;
  for (let n = 2; (await git(cwd, ["rev-parse", "--verify", "--quiet", branch])).ok; n++) branch = `autopilot/${slug}-${n}`;
  const sw = await git(cwd, ["switch", "-c", branch]);
  if (!sw.ok) return { ok: false, error: sw.out };
  if ((await dirtyCount(cwd)) > 0) {
    const c = await commitAll(cwd, "autopilot: starting point");
    if (!c.ok) return { ok: false, error: c.out };
  }
  return { ok: true, run: { branch, from, baseSha: await headSha(cwd) } };
}

/** Commit everything as one item's checkpoint; returns the commit sha. */
export async function commitCheckpoint(cwd: string, message: string): Promise<GitResult> {
  return commitAll(cwd, message);
}

const DEFAULT_GITIGNORE = ["node_modules/", "dist/", "build/", ".venv/", "__pycache__/", "*.log", ".pi/test-results/", ""].join("\n");

/** git init + default .gitignore (only if none) + initial commit. */
export async function initRepo(cwd: string): Promise<GitResult> {
  const init = await git(cwd, ["init"]);
  if (!init.ok) return init;
  const ignore = path.join(cwd, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, DEFAULT_GITIGNORE, "utf8");
  return commitAll(cwd, "initial commit (before autopilot)");
}

/** Reset the run branch to the commit before `sha` (that item and everything after is undone). */
export async function rollbackBefore(cwd: string, runBranch: string, sha: string): Promise<GitResult> {
  const branch = await currentBranch(cwd);
  if (branch !== runBranch) return { ok: false, out: `not on the run branch (${runBranch}); on ${branch}` };
  return git(cwd, ["reset", "--hard", `${sha}^`]);
}
