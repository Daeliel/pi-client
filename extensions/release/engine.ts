import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { hasTool } from "../verify/engine";
import type { ReleaseConfig, ReleaseTargetConfig } from "./config";
import {
  formatDoctorReport,
  parseFlutterDoctorOutput,
  type DoctorCheck,
  type DoctorResult,
} from "./flutter-doctor";

const pexec = promisify(exec);

export interface BuildResult {
  ok: boolean;
  target: string;
  command: string;
  artifactPath: string;
  artifactExists: boolean;
  artifactSizeBytes?: number;
  output: string;
  reason?: string;
}

async function run(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{
  code: number;
  out: string;
  timedOut: boolean;
}> {
  if (signal?.aborted) return { code: 0, out: "", timedOut: false };
  try {
    const { stdout, stderr } = await pexec(command, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      signal,
    });
    return { code: 0, out: `${stdout}${stderr}`.trim(), timedOut: false };
  } catch (e: unknown) {
    const err = e as {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
      signal?: string;
      name?: string;
      message?: string;
    };
    if (err.name === "AbortError" || signal?.aborted) {
      return { code: 0, out: "", timedOut: false };
    }
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "unknown error";
    const timedOut = Boolean(err.killed) || err.signal === "SIGTERM";
    return { code: timedOut ? 124 : typeof err.code === "number" ? err.code : 1, out, timedOut };
  }
}

function fileExists(cwd: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(cwd, rel));
  } catch {
    return false;
  }
}

/** True when cwd looks like a Flutter app with an Android subproject. */
export function isFlutterAndroidProject(cwd: string): boolean {
  return fileExists(cwd, "pubspec.yaml") && fileExists(cwd, "android");
}

function quoteIfNeeded(cmd: string): string {
  if (cmd.includes(" ") && !cmd.startsWith('"')) return `"${cmd}"`;
  return cmd;
}

/** Resolve flutter executable for this client. */
export async function resolveFlutterCommand(cwd: string, config: ReleaseConfig): Promise<string | null> {
  if (config.flutterCommand?.trim()) {
    const c = config.flutterCommand.trim();
    const probe = c.toLowerCase().endsWith(".bat") ? `"${c}" --version` : `${quoteIfNeeded(c)} --version`;
    if (await hasTool(probe, cwd)) return c.toLowerCase().endsWith(".bat") ? `"${c}"` : quoteIfNeeded(c);
  }

  if (await hasTool("flutter --version", cwd)) return "flutter";

  const root = process.env.FLUTTER_ROOT?.trim();
  if (root) {
    const winBat = path.join(root, "bin", "flutter.bat");
    if (fs.existsSync(winBat)) return `"${winBat}"`;
    const unix = path.join(root, "bin", "flutter");
    if (fs.existsSync(unix)) return `"${unix}"`;
  }

  return null;
}

function projectChecks(cwd: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push({
    id: "pubspec",
    name: "Flutter project",
    ok: fileExists(cwd, "pubspec.yaml"),
    warn: false,
    detail: fileExists(cwd, "pubspec.yaml") ? "pubspec.yaml found" : "pubspec.yaml missing",
    hint: "Run release tools from the Flutter app root (where pubspec.yaml lives)",
  });
  checks.push({
    id: "android_dir",
    name: "Android project",
    ok: fileExists(cwd, "android"),
    warn: false,
    detail: fileExists(cwd, "android") ? "android/ directory found" : "android/ directory missing",
    hint: "Run `flutter create .` in the project or add Android platform support",
  });
  return checks;
}

export async function runReleaseDoctor(cwd: string, config: ReleaseConfig): Promise<DoctorResult> {
  const project = projectChecks(cwd);
  const projectOk = project.every((c) => c.ok);

  const flutter = await resolveFlutterCommand(cwd, config);
  if (!flutter) {
    return {
      ready: false,
      checks: [
        ...project,
        {
          id: "flutter_cmd",
          name: "Flutter command",
          ok: false,
          warn: false,
          detail: "flutter not found on PATH",
          hint:
            "Set FLUTTER_ROOT, add flutter/bin to PATH, or set flutterCommand in .pi/release.config.json",
        },
      ],
      rawOutput: "",
    };
  }

  const r = await run(`${flutter} doctor -v`, cwd, 120000);
  const parsed = parseFlutterDoctorOutput(r.out);
  const checks = [...project, ...parsed];
  const ready = projectOk && parsed.every((c) => c.ok) && r.code === 0;

  return { ready, checks, rawOutput: r.out };
}

export function formatDoctorMessage(result: DoctorResult, cwd: string): string {
  const project = result.checks.filter((c) => c.id === "pubspec" || c.id === "android_dir");
  const rest = result.checks.filter((c) => c.id !== "pubspec" && c.id !== "android_dir");
  const body = formatDoctorReport({ ...result, checks: rest }, project);
  if (!isFlutterAndroidProject(cwd)) {
    return `${body}\n\nNote: ${path.basename(cwd)} does not look like a Flutter Android project.`;
  }
  return body;
}

function substituteFlutter(command: string, flutter: string): string {
  if (command.startsWith("flutter ")) return `${flutter} ${command.slice("flutter ".length)}`;
  if (command === "flutter") return flutter;
  return command;
}

export async function runReleaseBuild(
  cwd: string,
  config: ReleaseConfig,
  targetKey: string,
  signal?: AbortSignal,
): Promise<BuildResult> {
  const target = config.targets[targetKey];
  if (!target) {
    return {
      ok: false,
      target: targetKey,
      command: "",
      artifactPath: "",
      artifactExists: false,
      output: "",
      reason: `Unknown target "${targetKey}". Known: ${Object.keys(config.targets).join(", ")}`,
    };
  }

  const doctor = await runReleaseDoctor(cwd, config);
  if (!doctor.ready) {
    return {
      ok: false,
      target: targetKey,
      command: target.command,
      artifactPath: target.artifactPath,
      artifactExists: false,
      output: formatDoctorMessage(doctor, cwd),
      reason: "release_doctor not ready — fix toolchain before building",
    };
  }

  const flutter = await resolveFlutterCommand(cwd, config);
  if (!flutter) {
    return {
      ok: false,
      target: targetKey,
      command: target.command,
      artifactPath: target.artifactPath,
      artifactExists: false,
      output: "",
      reason: "flutter command not found",
    };
  }

  const command = substituteFlutter(target.command, flutter);
  const r = await run(command, cwd, config.timeoutMs, signal);

  const artifactAbs = path.join(cwd, target.artifactPath);
  const artifactExists = fs.existsSync(artifactAbs);
  let artifactSizeBytes: number | undefined;
  if (artifactExists) {
    try {
      artifactSizeBytes = fs.statSync(artifactAbs).size;
    } catch {
      /* ignore */
    }
  }

  const ok = r.code === 0 && artifactExists && !r.timedOut;
  let reason: string | undefined;
  if (r.timedOut) reason = `build timed out after ${config.timeoutMs}ms`;
  else if (r.code !== 0) reason = `build exited ${r.code}`;
  else if (!artifactExists) reason = `build exited 0 but artifact missing: ${target.artifactPath}`;

  return {
    ok,
    target: targetKey,
    command,
    artifactPath: target.artifactPath,
    artifactExists,
    artifactSizeBytes,
    output: r.out,
    reason,
  };
}

export function formatBuildReport(result: BuildResult, targetCfg?: ReleaseTargetConfig): string {
  const label = targetCfg?.label ?? result.target;
  const lines: string[] = [];
  lines.push(result.ok ? `RELEASE BUILD OK: ${label}` : `RELEASE BUILD FAILED: ${label}`);
  lines.push(`Command: ${result.command}`);
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  if (result.artifactExists) {
    const mb = result.artifactSizeBytes != null ? (result.artifactSizeBytes / (1024 * 1024)).toFixed(2) : "?";
    lines.push(`Artifact: ${result.artifactPath} (${mb} MB)`);
  } else {
    lines.push(`Expected artifact: ${result.artifactPath}`);
  }
  if (result.output) {
    lines.push("");
    const trimmed =
      result.output.length > 6000 ? `${result.output.slice(0, 6000)}\n…(truncated)` : result.output;
    lines.push(trimmed);
  }
  return lines.join("\n");
}

export function listTargetKeys(config: ReleaseConfig): string[] {
  return Object.keys(config.targets).sort();
}
