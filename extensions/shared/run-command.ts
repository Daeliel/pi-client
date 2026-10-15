import { execFile, spawn, type ChildProcess } from "node:child_process";

export interface RunOutput {
  code: number;
  out: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface RunOptions {
  cwd: string;
  /** 0 = no timeout. */
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Output kept (the end wins: failures are reported last). */
  maxOutputBytes?: number;
}

/**
 * Kill a shell command and everything it started. Killing only the shell (what
 * exec's timeout/signal do) leaves `node`, `playwright`, `pytest` … running on Windows,
 * holding files and CPU long after the user pressed Esc or /skip.
 */
export function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL"); // the process group (spawned detached)
  } catch {
    child.kill("SIGKILL");
  }
}

/** Run a shell command; abort and timeout stop the whole process tree. */
export function runCommand(command: string, opts: RunOptions): Promise<RunOutput> {
  if (opts.signal?.aborted) return Promise.resolve({ code: 0, out: "", timedOut: false, aborted: true });
  const max = opts.maxOutputBytes ?? 16 * 1024 * 1024;
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let aborted = false;
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const collect = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > max) out = out.slice(out.length - max);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = opts.timeoutMs > 0 ? setTimeout(() => ((timedOut = true), killTree(child)), opts.timeoutMs) : undefined;
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, error?: Error) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const text = out.trim();
      if (aborted) resolve({ code: 0, out: "", timedOut: false, aborted: true });
      else if (timedOut) resolve({ code: 124, out: text || "timed out", timedOut: true, aborted: false });
      else if (error) resolve({ code: 1, out: text || error.message, timedOut: false, aborted: false });
      else resolve({ code: code ?? 1, out: text, timedOut: false, aborted: false });
    };
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
  });
}
