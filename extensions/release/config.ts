import * as fs from "node:fs";
import { foundationConfigPaths } from "../shared/config-paths";

export interface ReleaseTargetConfig {
  /** Shell command (may start with `flutter` — resolved at run time). */
  command: string;
  /** Relative path under project cwd to confirm after a successful build. */
  artifactPath: string;
  /** Short label for reports (defaults to target key). */
  label?: string;
}

export interface ReleaseSigningConfig {
  /** Local keystore path (often under .pi/signing/ — gitignored). */
  keystorePath?: string;
  /** android/key.properties or similar — never commit secrets. */
  propertiesFile?: string;
}

export interface ReleaseConfig {
  /** Master switch — when false, tools and commands stay idle. */
  enabled: boolean;
  /** Future: block agent_end until release_build succeeds when user asked for APK. */
  blocking: boolean;
  /** Per-build timeout in milliseconds (Gradle first run can be slow). */
  timeoutMs: number;
  /**
   * Optional full path to flutter/flutter.bat when not on PATH
   * (e.g. C:\\flutter\\bin\\flutter.bat).
   * FLUTTER_ROOT env is also checked.
   */
  flutterCommand?: string;
  targets: Record<string, ReleaseTargetConfig>;
  signing?: ReleaseSigningConfig;
}

export const DEFAULT_TARGETS: Record<string, ReleaseTargetConfig> = {
  apk: {
    command: "flutter build apk --release",
    artifactPath: "build/app/outputs/flutter-apk/app-release.apk",
    label: "Release APK",
  },
  appbundle: {
    command: "flutter build appbundle --release",
    artifactPath: "build/app/outputs/bundle/release/app-release.aab",
    label: "Play Store AAB",
  },
};

export const DEFAULT_CONFIG: ReleaseConfig = {
  enabled: true,
  blocking: false,
  timeoutMs: 900000,
  targets: { ...DEFAULT_TARGETS },
};

function readJson(file: string): Partial<ReleaseConfig> | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function mergeTargets(
  base: Record<string, ReleaseTargetConfig>,
  override: Record<string, ReleaseTargetConfig> | undefined,
): Record<string, ReleaseTargetConfig> {
  if (!override) return base;
  const out = { ...base };
  for (const [key, cfg] of Object.entries(override)) {
    out[key] = { ...(base[key] ?? {}), ...cfg };
  }
  return out;
}

/** Layer defaults < user ~/.pi < project .pi < legacy project root. */
export function loadConfig(cwd: string): ReleaseConfig {
  const layers = foundationConfigPaths(cwd, "release.config.json");
  let cfg: ReleaseConfig = {
    ...DEFAULT_CONFIG,
    targets: { ...DEFAULT_TARGETS },
  };
  for (const file of layers) {
    const override = readJson(file);
    if (!override) continue;
    cfg = {
      ...cfg,
      ...override,
      targets: mergeTargets(cfg.targets, override.targets),
      signing: override.signing ? { ...cfg.signing, ...override.signing } : cfg.signing,
    };
  }
  return cfg;
}
