import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The project as it was before the model's change: each file it touched, kept before the
 * first edit, so a failing check can be run again without the change. A failure that is
 * there either way was there before the model started — the project's, not the model's.
 */

/** Files above this size are not kept; a change to one makes the comparison unavailable. */
const MAX_KEEP_BYTES = 5 * 1024 * 1024;
/** A folder walk (no git) gives up past this many entries: too big to tell what changed. */
const MAX_WALK_ENTRIES = 20000;
const SKIP_DIRS = new Set([".git", ".pi", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".pytest_cache", ".mypy_cache", ".ruff_cache", "python_embeded", "python_embedded", "bin", "obj", "coverage", ".next", "out"]);

type Original = { absent: true } | { kept: string };

interface Manifest {
  /** When tracking began (ms): a file written after it without a kept original changed some other way. */
  t0: number;
  /** abs path → its original, or `{absent}` when the file did not exist. */
  originals: Record<string, Original>;
  /** Files whose original could not be kept (too big, unreadable). */
  unknown: string[];
  /** The repository around the project at t0, and the files that were already changed then. */
  repo: { top: string; dirty: string[] } | null;
}

interface Journal {
  /** abs path → where the model's version waits (`null`: the model's version is no file). */
  held: Record<string, string | null>;
}

export interface BeforeWorld {
  /** False when some change has no known original: no comparison, failures block as before. */
  trusted: boolean;
  /** Changed files found without an edit tool (bash, scripts) — they need checking too. */
  foundChanged: string[];
  existedBefore(abs: string): boolean;
  /** Run `fn` with every changed file as it was; the model's versions come back afterwards. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Failures of a command in the before-state — that state does not change, so one run each. */
  cache: Map<string, Set<string> | null>;
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export class BeforeStore {
  private manifest: Manifest | null = null;
  private readonly keepDir: string;
  private readonly manifestFile: string;
  private readonly journalFile: string;
  private readonly heldDir: string;
  /** Before-state failures per command, valid while the manifest is. */
  private readonly cache = new Map<string, Set<string> | null>();

  constructor(private readonly cwd: string) {
    const dir = path.join(cwd, ".pi", "verify");
    this.keepDir = path.join(dir, "before");
    this.manifestFile = path.join(dir, "before.json");
    this.journalFile = path.join(dir, "swap.json");
    this.heldDir = path.join(dir, "held");
  }

  private load(): Manifest | null {
    if (this.manifest) return this.manifest;
    try {
      this.manifest = JSON.parse(fs.readFileSync(this.manifestFile, "utf8")) as Manifest;
    } catch {
      this.manifest = null;
    }
    return this.manifest;
  }

  private save() {
    if (!this.manifest) return;
    const dir = path.dirname(this.manifestFile);
    fs.mkdirSync(dir, { recursive: true });
    // Working copies, never part of the project: kept out of git status and checkpoint commits.
    const ignore = path.join(dir, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
    fs.writeFileSync(this.manifestFile, JSON.stringify(this.manifest));
  }

  get tracking(): boolean {
    return this.load() !== null;
  }

  /** Begin tracking at the start of a task (no-op while one is tracked). */
  start(): void {
    if (this.load()) return;
    const top = git(this.cwd, ["rev-parse", "--show-toplevel"])?.trim();
    let repo: Manifest["repo"] = null;
    if (top) {
      const status = git(top, ["status", "--porcelain", "-z", "--untracked-files=all"]);
      if (status !== null) {
        const dirty = status
          .split("\0")
          .filter((e) => e.length > 3)
          .map((e) => e.slice(3));
        repo = { top: path.resolve(top), dirty };
      }
    }
    this.manifest = { t0: Date.now(), originals: {}, unknown: [], repo };
    this.cache.clear();
    this.save();
  }

  /** Keep `file` as it is now, before its first edit. */
  capture(file: string): void {
    const m = this.load();
    if (!m) return;
    const abs = path.resolve(this.cwd, file);
    if (m.originals[abs] || m.unknown.includes(abs)) return;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_KEEP_BYTES) {
        m.unknown.push(abs);
      } else {
        fs.mkdirSync(this.keepDir, { recursive: true });
        const kept = path.join(this.keepDir, `${Object.keys(m.originals).length}.orig`);
        fs.copyFileSync(abs, kept);
        m.originals[abs] = { kept };
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") m.originals[abs] = { absent: true };
      else m.unknown.push(abs);
    }
    this.cache.clear(); // not needed for correctness (the before-state is the same), but cheap
    this.save();
  }

  /** Stop tracking: the change is settled (checks passed, gave up, or skipped). */
  clear(): void {
    this.manifest = null;
    this.cache.clear();
    fs.rmSync(this.keepDir, { recursive: true, force: true });
    fs.rmSync(this.manifestFile, { force: true });
  }

  /**
   * Code files changed since tracking began that no edit tool reported. With git, their
   * originals are known when they were clean at the start; otherwise they are unknown.
   */
  private changedElsewhere(m: Manifest, isCode: (abs: string) => boolean): { found: string[]; originals: Map<string, Original | null> } {
    const found: string[] = [];
    const originals = new Map<string, Original | null>();
    const known = (abs: string) => Object.keys(m.originals).some((k) => same(k, abs)) || m.unknown.some((k) => same(k, abs));
    const newer = (abs: string) => {
      try {
        return fs.statSync(abs).mtimeMs > m.t0;
      } catch {
        return false;
      }
    };

    let candidates: string[] | null = null;
    if (m.repo) {
      const out = git(m.repo.top, ["ls-files", "-m", "-o", "--exclude-standard", "-z"]);
      if (out !== null) candidates = out.split("\0").filter(Boolean).map((rel) => path.join(m.repo!.top, rel));
    }
    if (!candidates) candidates = walk(this.cwd);
    if (!candidates) return { found: [], originals: new Map([["*", null]]) }; // too big to tell

    for (const abs of new Set(candidates.map((c) => path.resolve(c)))) {
      if (abs.split(path.sep).includes(".pi") || !isCode(abs) || known(abs) || !newer(abs)) continue;
      found.push(abs);
      let original: Original | null = null;
      if (m.repo && !path.relative(m.repo.top, abs).startsWith("..")) {
        const rel = path.relative(m.repo.top, abs).split(path.sep).join("/");
        if (!m.repo.dirty.includes(rel)) {
          const tracked = git(m.repo.top, ["ls-files", "--error-unmatch", "--", rel]) !== null;
          if (!tracked) original = { absent: true };
          else {
            const r = spawnSync("git", ["show", `HEAD:${rel}`], { cwd: m.repo.top, windowsHide: true, maxBuffer: MAX_KEEP_BYTES });
            if (r.status === 0) {
              fs.mkdirSync(this.keepDir, { recursive: true });
              const kept = path.join(this.keepDir, `git-${found.length}.orig`);
              fs.writeFileSync(kept, r.stdout);
              original = { kept };
            }
          }
        }
      }
      originals.set(abs, original);
    }
    return { found, originals };
  }

  /** The before-state for one verify run; null when nothing is tracked. */
  world(isCode: (abs: string) => boolean): BeforeWorld | null {
    const m = this.load();
    if (!m) return null;
    const elsewhere = this.changedElsewhere(m, isCode);
    const all = new Map<string, Original | null>(Object.entries(m.originals));
    for (const [abs, o] of elsewhere.originals) all.set(abs, o);
    const trusted = m.unknown.length === 0 && [...all.values()].every((o) => o !== null);
    // A file the model changed back to its original needs no swap.
    const swaps = [...all.entries()].filter(([abs, o]) => o !== null && differs(abs, o)) as Array<[string, Original]>;
    return {
      trusted,
      foundChanged: elsewhere.found,
      existedBefore: (abs) => {
        const o = [...all.entries()].find(([k]) => same(k, abs))?.[1];
        return o === undefined ? fs.existsSync(abs) : o !== null && !("absent" in o);
      },
      run: (fn) => this.swapped(swaps, fn),
      cache: this.cache,
    };
  }

  private async swapped<T>(swaps: Array<[string, Original]>, fn: () => Promise<T>): Promise<T> {
    this.recover(); // a swap left over from a crash goes back first
    const journal: Journal = { held: {} };
    fs.mkdirSync(this.heldDir, { recursive: true });
    swaps.forEach(([abs], i) => {
      if (fs.existsSync(abs)) {
        const held = path.join(this.heldDir, `${i}.held`);
        fs.copyFileSync(abs, held);
        journal.held[abs] = held;
      } else {
        journal.held[abs] = null;
      }
    });
    // The note is on disk before any file changes: a crash from here on is recoverable.
    fs.writeFileSync(this.journalFile, JSON.stringify(journal));
    try {
      for (const [abs, o] of swaps) {
        if ("absent" in o) fs.rmSync(abs, { force: true });
        else {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.copyFileSync(o.kept, abs);
        }
      }
      return await fn();
    } finally {
      this.recover();
    }
  }

  /** Put the model's versions back after an interrupted swap. True when there was one. */
  recover(): boolean {
    let journal: Journal;
    try {
      journal = JSON.parse(fs.readFileSync(this.journalFile, "utf8")) as Journal;
    } catch {
      return false;
    }
    for (const [abs, held] of Object.entries(journal.held)) {
      if (held === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(held, abs);
      }
    }
    fs.rmSync(this.journalFile, { force: true });
    fs.rmSync(this.heldDir, { recursive: true, force: true });
    return true;
  }
}

function differs(abs: string, o: Original): boolean {
  try {
    const now = fs.readFileSync(abs);
    return "absent" in o ? true : !now.equals(fs.readFileSync(o.kept));
  } catch {
    return !("absent" in o); // gone now: differs unless it was absent before too
  }
}

/** Every file under `root`, skipping tool and dependency folders; null past the cap. */
function walk(root: string): string[] | null {
  const files: string[] = [];
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > MAX_WALK_ENTRIES) return null;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(path.join(dir, e.name));
      } else if (e.isFile()) files.push(path.join(dir, e.name));
    }
  }
  return files;
}
