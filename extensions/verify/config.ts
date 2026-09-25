import * as path from "node:path";
import { foundationConfigPaths } from "../shared/config-paths";
import { readJsonConfig } from "../shared/json-config";

export interface LanguageConfig {
  enabled?: boolean;
  lint?: string;
  /** Compile / typecheck step (e.g. `tsc --noEmit`). Runs between lint and test. */
  build?: string;
  test?: string;
  /** Optional probe commands to confirm a generic/node toolchain exists. */
  lintProbe?: string;
  buildProbe?: string;
  testProbe?: string;
  /**
   * File extensions that map to this language (e.g. [".go"]). Used to decide
   * which checks a change implicates and to fill the {files} placeholder.
   * Python/JS/TS are built in; add this for other languages.
   */
  extensions?: string[];
  [key: string]: unknown;
}

export interface VerifyConfig {
  /** When true, failing verification re-triggers a fix turn (hard gate). */
  blocking: boolean;
  /** Safety cap so a model that cannot fix the code never pins the GPU forever. */
  maxFixAttempts: number;
  /** Per-command timeout in milliseconds. */
  timeoutMs: number;
  /** Auto-verify after the model edits/writes a file. */
  verifyOnEdit: boolean;
  /**
   * Scope checks to the top-level subfolder(s) containing changed files when pi
   * runs from a workspace root (e.g. Various Projects), not the whole tree.
   */
  isolateSubprojects: boolean;
  languages: Record<string, LanguageConfig>;
}

export const DEFAULT_CONFIG: VerifyConfig = {
  blocking: true,
  maxFixAttempts: 5,
  timeoutMs: 120000,
  verifyOnEdit: true,
  isolateSubprojects: true,
  languages: {
    python: {
      enabled: true,
      // E/F = pyflakes/pycodestyle, B = flake8-bugbear (catches mutable default
      // args, etc.). Run via `{py} -m ruff` so it works even when ruff's script
      // dir is not on PATH. {files} scopes lint to the changed files (whole
      // project when none). Tests deliberately run the WHOLE suite so cross-file
      // regressions are caught. Override in verify.config.json for project rules.
      lint: "{py} -m ruff check --select=E,F,B {files}",
      test: "{py} -m pytest -q",
    },
    node: {
      enabled: true,
      lint: "npx --no-install eslint {files}",
      lintProbe: "npx --no-install eslint --version",
      // Typecheck the whole project (tsc needs project context; only runs when a
      // tsconfig.json is present). This is the key guardrail for typed languages.
      build: "npx --no-install tsc --noEmit",
      buildProbe: "npx --no-install tsc --version",
      test: "npm test --silent",
      testProbe: "npm --version",
    },
    csharp: {
      enabled: true,
      extensions: [".cs"],
      build: "dotnet build --nologo -v q",
      buildProbe: "dotnet --version",
      test: "dotnet test --nologo -v q",
      testProbe: "dotnet --version",
    },
  },
};

function deepMergeLanguages(
  base: Record<string, LanguageConfig>,
  override: Record<string, LanguageConfig> | undefined,
): Record<string, LanguageConfig> {
  if (!override) return base;
  const out: Record<string, LanguageConfig> = { ...base };
  for (const [lang, cfg] of Object.entries(override)) {
    out[lang] = { ...(base[lang] ?? {}), ...cfg };
  }
  return out;
}

function readJson(file: string): Partial<VerifyConfig> | null {
  return readJsonConfig<VerifyConfig>(file);
}

/**
 * Resolve config by layering: built-in defaults < user < project CONFIG_DIR_NAME < legacy project root.
 */
export function loadConfig(cwd: string): VerifyConfig {
  const layers = foundationConfigPaths(cwd, "verify.config.json");

  let cfg: VerifyConfig = { ...DEFAULT_CONFIG, languages: { ...DEFAULT_CONFIG.languages } };
  for (const file of layers) {
    const override = readJson(file);
    if (!override) continue;
    cfg = {
      ...cfg,
      ...override,
      languages: deepMergeLanguages(cfg.languages, override.languages),
    };
  }
  return cfg;
}
