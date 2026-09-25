/** Structured check from release_doctor / flutter doctor parsing. */
export interface DoctorCheck {
  id: string;
  name: string;
  ok: boolean;
  warn: boolean;
  detail: string;
  hint?: string;
}

export interface DoctorResult {
  /** True when Android release builds can proceed. */
  ready: boolean;
  checks: DoctorCheck[];
  rawOutput: string;
}

/** Match flutter doctor status lines — tolerant of UTF-8 checkmarks and Windows encoding glitches. */
function lineStatus(line: string): "pass" | "fail" | "warn" | null {
  const m = line.match(/^\[([^\]]+)\]/);
  if (!m) return null;
  const marker = m[1]!.trim();
  if (marker === "X" || marker === "✗") return "fail";
  if (marker === "!") return "warn";
  // √, mojibake variants, or any non-X/non-! bracket content from flutter doctor pass lines
  if (marker === "√" || marker.includes("√") || marker.length <= 3) return "pass";
  return "warn";
}

/** Parse `flutter doctor -v` (stable-channel output). Encoding-safe on Windows consoles. */
export function parseFlutterDoctorOutput(output: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const lines = output.split(/\r?\n/);

  // --- Flutter SDK ---
  const flutterHeader = lines.find((l) => /Flutter \(Channel/i.test(l) || /^\[.+\]\s*Flutter/i.test(l));
  const hasVersion = /Flutter version \d/.test(output);
  const notOnPath = /not on your path/i.test(output);
  const flutterFail = /\[X\]\s*Flutter/i.test(output) || /Unable to find flutter/i.test(output);

  if (flutterHeader || hasVersion) {
    const st = flutterHeader ? lineStatus(flutterHeader) : hasVersion ? "pass" : "fail";
    checks.push({
      id: "flutter_sdk",
      name: "Flutter SDK",
      ok: hasVersion && !flutterFail && st !== "fail",
      warn: notOnPath || st === "warn",
      detail: flutterHeader?.replace(/^\[[^\]]+\]\s*/, "") ?? (hasVersion ? "Flutter SDK detected" : "Flutter SDK unknown"),
      hint: notOnPath ? "Add FLUTTER_ROOT/bin to PATH or set release.config.json flutterCommand" : undefined,
    });
  }

  // --- Android toolchain (pattern-based — do not rely on √ character) ---
  const sdkMatch = output.match(/Android SDK at (.+)/);
  const licensesOk = /All Android licenses accepted/i.test(output);
  const licensesUnknown = /license status unknown/i.test(output);
  const cmdlineMissing = /cmdline-tools component is missing/i.test(output);
  const sdkMissing = /Unable to locate Android SDK/i.test(output);
  const androidFailLine = lines.some((l) => /Android toolchain/i.test(l) && lineStatus(l) === "fail");

  if (sdkMissing || sdkMatch || /Android toolchain/i.test(output)) {
    let hint: string | undefined;
    if (sdkMissing || !sdkMatch) {
      hint =
        "Launch Android Studio → SDK Manager → install Android SDK (Standard). Then: flutter config --android-sdk %LOCALAPPDATA%\\Android\\Sdk";
    } else if (cmdlineMissing) {
      hint = "Android Studio → SDK Manager → SDK Tools → Android SDK Command-line Tools (latest)";
    } else if (licensesUnknown || !licensesOk) {
      hint = "Run: flutter doctor --android-licenses (accept all prompts)";
    } else if (androidFailLine) {
      hint = "Fix Android toolchain issues reported by flutter doctor -v";
    }

    let detail = "Android toolchain";
    if (sdkMatch) detail = `Android SDK at ${sdkMatch[1]!.trim()}`;
    if (licensesOk) detail += "; licenses accepted";

    const ok = Boolean(sdkMatch) && licensesOk && !cmdlineMissing && !sdkMissing && !androidFailLine;

    checks.push({
      id: "android_toolchain",
      name: "Android toolchain",
      ok,
      warn: licensesUnknown || cmdlineMissing || androidFailLine,
      detail,
      hint,
    });
  }

  return checks;
}

/**
 * Android release builds need exactly two things from flutter doctor: the SDK and the
 * Android toolchain. Both must be found AND pass. Unrelated doctor sections (Chrome,
 * Visual Studio, Xcode) and the doctor's exit code do not matter, and an output
 * where neither check can be found is "unknown", never "ready".
 */
export function androidReleaseReady(parsed: DoctorCheck[]): boolean {
  const sdk = parsed.find((c) => c.id === "flutter_sdk");
  const android = parsed.find((c) => c.id === "android_toolchain");
  return Boolean(sdk?.ok && android?.ok);
}

export function formatDoctorReport(result: DoctorResult, projectHints: DoctorCheck[] = []): string {
  const lines: string[] = [];
  lines.push(result.ready ? "RELEASE DOCTOR: ready to build" : "RELEASE DOCTOR: not ready — fix blockers first");
  lines.push("");

  const all = [...projectHints, ...result.checks];
  for (const c of all) {
    const icon = c.ok ? "OK" : c.warn ? "WARN" : "FAIL";
    lines.push(`[${icon}] ${c.name}: ${c.detail}`);
    if (c.hint && !c.ok) lines.push(`       → ${c.hint}`);
  }

  if (!result.ready) {
    lines.push("");
    lines.push("Do not run release_build or Gradle edits until blockers are fixed.");
    lines.push("Human setup (Android Studio, SDK, licenses) is required — Pi cannot install the SDK.");
  }

  return lines.join("\n");
}
