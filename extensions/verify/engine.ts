import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import type { VerifyConfig, LanguageConfig } from "./config";

const pexec = promisify(exec);

export type CheckKind = "lint" | "build" | "test";

export interface CheckResult {
  language: string;
  kind: CheckKind;
  label: string;
  status: "pass" | "fail" | "skip";
  output: string;
  reason?: string;
}

export interface VerifyResult {
  ran: boolean;
  failed: boolean;
  checks: CheckResult[];
}

interface RunOutput {
  code: number;
  out: string;
  timedOut: boolean;
  aborted: boolean;
}

async function run(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunOutput> {
  if (signal?.aborted) return { code: 0, out: "", timedOut: false, aborted: true };
  try {
    const { stdout, stderr } = await pexec(command, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    });
    return { code: 0, out: `${stdout}${stderr}`.trim(), timedOut: false, aborted: false };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string; name?: string; message?: string };
    // User pressed Esc / the turn was cancelled — not a real failure.
    if (err.name === "AbortError" || signal?.aborted) {
      return { code: 0, out: "", timedOut: false, aborted: true };
    }
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "unknown error";
    const timedOut = Boolean(err.killed) || err.signal === "SIGTERM";
    const code = typeof err.code === "number" ? err.code : 1;
    return { code: timedOut ? 124 : code, out, timedOut, aborted: false };
  }
}

/** True if a probe command (e.g. "ruff --version") exits 0. Results are cached per probe. */
const toolCache = new Map<string, boolean>();
export async function hasTool(probe: string, cwd: string): Promise<boolean> {
  const cached = toolCache.get(probe);
  if (cached !== undefined) return cached;
  const r = await run(probe, cwd, 15000);
  const ok = r.code === 0;
  toolCache.set(probe, ok);
  return ok;
}

/** Detect the Python interpreter once (fixes the python/py PATH fragility). */
let cachedPython: string | null | undefined;
export async function pythonCmd(cwd: string): Promise<string | null> {
  if (cachedPython !== undefined) return cachedPython;
  for (const candidate of ["python", "python3", "py"]) {
    if (await hasTool(`${candidate} --version`, cwd)) {
      cachedPython = candidate;
      return candidate;
    }
  }
  cachedPython = null;
  return null;
}

function fileExists(cwd: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(cwd, rel));
  } catch {
    return false;
  }
}

/** Top-level subfolders under cwd that look like real projects (not loose files). */
function isMultiProjectWorkspace(cwd: string): boolean {
  try {
    let markers = 0;
    for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = path.join(cwd, entry.name);
      if (
        fileExists(child, "package.json") ||
        fileExists(child, "pyproject.toml") ||
        fileExists(child, "pytest.ini") ||
        fileExists(child, "go.mod") ||
        fileExists(child, "Cargo.toml")
      ) {
        markers += 1;
      }
    }
    return markers >= 2;
  } catch {
    return false;
  }
}

interface WorkScope {
  cwd: string;
  relFiles: string[];
  /** Short label for reports, e.g. "my-app/" */
  label: string;
}

/**
 * Split changed files into per-subproject scopes so pytest/eslint do not sweep
 * unrelated folders when pi runs from a workspace root (e.g. Various Projects).
 */
export function partitionScopes(piCwd: string, files: string[], isolate: boolean): WorkScope[] {
  const root = path.resolve(piCwd);
  const toRel = (abs: string) => path.relative(root, abs).split(path.sep).join("/");

  if (!isolate || files.length === 0) {
    const relFiles = files.map((f) => (path.isAbsolute(f) ? toRel(path.resolve(f)) : f.replace(/\\/g, "/")));
    return [{ cwd: root, relFiles, label: "" }];
  }

  const buckets = new Map<string, string[]>();

  for (const raw of files) {
    const abs = path.resolve(root, raw);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || rel === "") {
      const key = root;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(rel || path.basename(abs));
      continue;
    }
    const parts = rel.split(path.sep);
    const scopeDir = parts.length > 1 ? path.join(root, parts[0]) : root;
    const scopeRel = parts.length > 1 ? parts.slice(1).join(path.sep) : rel;
    if (!buckets.has(scopeDir)) buckets.set(scopeDir, []);
    buckets.get(scopeDir)!.push(scopeRel.split(path.sep).join("/"));
  }

  return Array.from(buckets.entries()).map(([scopeCwd, relFiles]) => {
    const relLabel = path.relative(root, scopeCwd);
    return {
      cwd: scopeCwd,
      relFiles,
      label: relLabel ? `${relLabel.split(path.sep).join("/")}/` : "",
    };
  });
}

function packageHasTestScript(cwd: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    return Boolean(pkg?.scripts?.test);
  } catch {
    return false;
  }
}

const BASE_EXT_TO_LANG: Record<string, string> = {
  ".py": "python",
  ".js": "node",
  ".jsx": "node",
  ".ts": "node",
  ".tsx": "node",
  ".mjs": "node",
  ".cjs": "node",
};

/** Build the extension→language map, layering any user-declared extensions on top. */
function extMapFor(config: VerifyConfig): Record<string, string> {
  const map: Record<string, string> = { ...BASE_EXT_TO_LANG };
  for (const [lang, cfg] of Object.entries(config.languages)) {
    for (const ext of cfg.extensions ?? []) {
      const norm = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
      map[norm] = lang;
    }
  }
  return map;
}

/** Which languages are implicated by the set of changed files. */
export function languagesForFiles(
  files: string[],
  extMap: Record<string, string> = BASE_EXT_TO_LANG,
): Set<string> {
  const langs = new Set<string>();
  for (const f of files) {
    const lang = extMap[path.extname(f).toLowerCase()];
    if (lang) langs.add(lang);
  }
  return langs;
}

function filesForLang(files: string[], lang: string, extMap: Record<string, string>): string[] {
  return files.filter((f) => extMap[path.extname(f).toLowerCase()] === lang);
}

/** Render a file list for the {files} placeholder; falls back to "." (whole project). */
function filesArg(files: string[]): string {
  return files.length ? files.map((f) => `"${f}"`).join(" ") : ".";
}

interface PreparedCommand {
  command: string;
  /** Probe to confirm the toolchain exists; if it fails we skip (not fail). */
  probe?: string;
  /** Extra gate: only run if this returns true. */
  applicable?: () => boolean;
}

function rawCommand(cfg: LanguageConfig, kind: CheckKind): string | undefined {
  return kind === "lint" ? cfg.lint : kind === "build" ? cfg.build : cfg.test;
}

async function prepare(
  language: string,
  kind: CheckKind,
  cfg: LanguageConfig,
  cwd: string,
  files: string[],
): Promise<PreparedCommand | null> {
  const raw = rawCommand(cfg, kind);
  if (!raw) return null;

  const withFiles = (command: string) => command.replace(/\{files\}/g, filesArg(files));

  if (language === "python") {
    const py = await pythonCmd(cwd);
    if (!py) return { command: raw, probe: "python --version" }; // will skip via probe
    let command = withFiles(raw.replace(/\{py\}/g, py));
    if (kind === "test" && command.includes("pytest")) {
      const pyFiles = files.filter((f) => f.toLowerCase().endsWith(".py"));
      const hasPyProject =
        fileExists(cwd, "pytest.ini") ||
        fileExists(cwd, "pyproject.toml") ||
        fileExists(cwd, "conftest.py");
      if (pyFiles.length === 0 && !hasPyProject) {
        return {
          command,
          applicable: () => false,
        };
      }
      // Scope pytest to this work folder, not parent workspace discovery.
      if (!command.match(/pytest\b[\s\S]*\s+\S/)) {
        command = `${py} -m pytest -q .`;
      }
    }
    const probe = command.includes(`${py} -m ruff`)
      ? `${py} -m ruff --version`
      : command.startsWith("ruff")
        ? "ruff --version"
        : `${py} --version`;
    return { command, probe };
  }

  if (language === "node") {
    const probe = cfg[`${kind}Probe`] as string | undefined;
    const applicable =
      kind === "test"
        ? () => packageHasTestScript(cwd)
        : kind === "build"
          ? () => fileExists(cwd, "tsconfig.json")
          : () => fileExists(cwd, "package.json");
    return { command: withFiles(raw), probe, applicable };
  }

  // Generic / user-defined language from config.
  return { command: withFiles(raw), probe: cfg[`${kind}Probe`] as string | undefined };
}

async function runCheck(
  language: string,
  kind: CheckKind,
  cfg: LanguageConfig,
  cwd: string,
  timeoutMs: number,
  files: string[],
  signal?: AbortSignal,
): Promise<CheckResult | null> {
  const prepared = await prepare(language, kind, cfg, cwd, files);
  if (!prepared) return null;

  const label = `${language} ${kind}`;

  if (prepared.applicable && !prepared.applicable()) {
    return { language, kind, label, status: "skip", output: "", reason: "not applicable to this project" };
  }

  if (prepared.probe && !(await hasTool(prepared.probe, cwd))) {
    return {
      language,
      kind,
      label,
      status: "skip",
      output: "",
      reason: `toolchain missing (probe failed: \`${prepared.probe}\`) — run /doctor`,
    };
  }

  const r = await run(prepared.command, cwd, timeoutMs, signal);
  if (r.aborted) return null; // cancelled — omit rather than report a fake result
  if (r.timedOut) {
    return {
      language,
      kind,
      label,
      status: "fail",
      output: `Command timed out after ${timeoutMs}ms: \`${prepared.command}\`\n${r.out}`,
    };
  }
  // pytest exits 5 when it collected zero tests. "No tests" is not a failure —
  // treat it as a skip so the gate doesn't fire on a project that simply has
  // none yet.
  if (kind === "test" && prepared.command.includes("pytest") && r.code === 5) {
    return { language, kind, label, status: "skip", output: "", reason: "no tests collected" };
  }
  return {
    language,
    kind,
    label,
    status: r.code === 0 ? "pass" : "fail",
    output: r.out,
  };
}

/**
 * Verify the project. `changedFiles` narrows which languages to check; pass an
 * empty array to check every enabled language (used by the explicit /verify).
 */
export async function verify(
  cwd: string,
  changedFiles: string[],
  config: VerifyConfig,
  only: CheckKind[] = ["lint", "build", "test"],
  signal?: AbortSignal,
): Promise<VerifyResult> {
  if (changedFiles.length === 0 && config.isolateSubprojects && isMultiProjectWorkspace(cwd)) {
    return {
      ran: false,
      failed: false,
      checks: [
        {
          language: "workspace",
          kind: "test",
          label: "workspace scope",
          status: "skip",
          output: "",
          reason:
            "pi cwd is a multi-project folder — use verify with changed files only, or run pi inside one project subfolder",
        },
      ],
    };
  }

  const scopes = partitionScopes(cwd, changedFiles, config.isolateSubprojects);
  const enabled = Object.entries(config.languages).filter(([, c]) => c.enabled !== false);
  const extMap = extMapFor(config);

  const checks: CheckResult[] = [];

  for (const scope of scopes) {
    const scopeFiles = scope.relFiles;
    let targetLangs: string[];
    if (scopeFiles.length === 0) {
      targetLangs = enabled.map(([id]) => id);
    } else {
      const implicated = languagesForFiles(scopeFiles, extMap);
      targetLangs = enabled.map(([id]) => id).filter((id) => implicated.has(id));
    }

    for (const lang of targetLangs) {
      const cfg = config.languages[lang];
      const langFiles = scopeFiles.length ? filesForLang(scopeFiles, lang, extMap) : [];
      for (const kind of only) {
        const result = await runCheck(lang, kind, cfg, scope.cwd, config.timeoutMs, langFiles, signal);
        if (!result) continue;
        if (scope.label) {
          result.label = `${scope.label} ${result.label}`;
        }
        checks.push(result);
      }
    }
  }

  const ran = checks.some((c) => c.status !== "skip");
  const failed = checks.some((c) => c.status === "fail");
  return { ran, failed, checks };
}

export interface ToolStatus {
  name: string;
  ok: boolean;
  hint: string;
}

/**
 * Check that the toolchain needed by the *enabled* languages is present.
 * Used by /doctor and the session_start warning so a missing tool is never a
 * silent skip.
 */
export async function toolchainStatus(cwd: string, config: VerifyConfig): Promise<ToolStatus[]> {
  const out: ToolStatus[] = [];
  const enabled = Object.entries(config.languages).filter(([, c]) => c.enabled !== false);

  for (const [lang, cfg] of enabled) {
    if (lang === "python") {
      const py = await pythonCmd(cwd);
      out.push({ name: "python", ok: py !== null, hint: "Install Python 3 and put it on PATH" });
      if (!py) continue;
      out.push({
        name: "ruff",
        ok: (await hasTool(`${py} -m ruff --version`, cwd)) || (await hasTool("ruff --version", cwd)),
        hint: `${py} -m pip install ruff`,
      });
      out.push({
        name: "pytest",
        ok: await hasTool(`${py} -m pytest --version`, cwd),
        hint: `${py} -m pip install pytest`,
      });
      continue;
    }

    if (lang === "node") {
      out.push({ name: "node", ok: await hasTool("node --version", cwd), hint: "Install Node.js" });
      out.push({ name: "npm", ok: await hasTool("npm --version", cwd), hint: "Install Node.js (includes npm)" });
      // Only flag the typechecker when the project actually uses TypeScript.
      if (fileExists(cwd, "tsconfig.json")) {
        out.push({
          name: "tsc",
          ok: await hasTool("npx --no-install tsc --version", cwd),
          hint: "npm install -D typescript",
        });
      }
      continue;
    }

    // Generic languages: check whatever probes they declared.
    for (const kind of ["lint", "test"] as const) {
      const probe = cfg[`${kind}Probe`] as string | undefined;
      if (probe) {
        out.push({ name: `${lang} ${kind}`, ok: await hasTool(probe, cwd), hint: `ensure \`${probe}\` works` });
      }
    }
  }
  return out;
}

/** Render check results into a compact, model-readable report. */
export function formatReport(result: VerifyResult): string {
  if (result.checks.length === 0) return "No applicable checks for the changed files.";
  const lines: string[] = [];
  const skipCount = result.checks.filter((c) => c.status === "skip").length;
  if (skipCount === result.checks.length) {
    lines.push("WARNING: All checks were SKIPPED — this is NOT a pass. Install missing tools (/doctor) and run verify again.");
    lines.push("");
  }
  for (const c of result.checks) {
    const icon = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "SKIP";
    const suffix = c.reason ? ` (${c.reason})` : "";
    lines.push(`[${icon}] ${c.label}${suffix}`);
    if (c.status === "fail" && c.output) {
      const trimmed = c.output.length > 4000 ? `${c.output.slice(0, 4000)}\n…(truncated)` : c.output;
      lines.push(trimmed);
    }
  }
  return lines.join("\n");
}
