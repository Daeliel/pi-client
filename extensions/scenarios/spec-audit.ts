import * as fs from "node:fs";
import * as path from "node:path";
import type { ScenariosConfig } from "./config";
import { isScratchSpecFile, scenarioFilename } from "./housekeeping";

export interface SpecPatternWarning {
  file: string;
  message: string;
  /** When true, a passing run_scenarios should fail the gate. */
  blocking: boolean;
}

const SCROLL_PROOF =
  /scrollCanvas|scrollAndCapture|mouse\.wheel|PageDown|ArrowDown|scrollCanvasWheel|scrollCanvasDrag|keyboard\.press\s*\(\s*['"]PageDown/i;

const BELOW_FOLD_HINT =
  /\b(below|scroll|list|timeline|stages|footer|bottom|lower|achievement|achievements|history item|delete|off.?screen|progress tab)\b/i;

const LAYOUT_PROOF_HINT =
  /\b(achievement|layout|position|two per row|fit two|overlap|misalign|scroll down|scrolled)\b/i;

const STORAGE_CHEAT = /localStorage\.(get|set)Item|sessionStorage\.(get|set)Item/;

const EVAL_INJECT = /page\.evaluate\s*\(/;

const DOM_SCROLL_CHEAT = /window\.scroll|document\.scroll|scrollBy\s*\(|scrollTo\s*\(/;

const CANVAS_ONLY_ASSERT =
  /expect\s*\(\s*(?:page\.locator\s*\(\s*['"]canvas|canvas)\s*\)\.toBeVisible\s*\(\s*\)/;

function walkSpecs(dir: string, visit: (abs: string, relFromDir: string) => void): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "helpers" || entry.name === "output") continue;
      walkSpecs(abs, visit);
      continue;
    }
    if (!/\.spec\.ts$/i.test(entry.name)) continue;
    visit(abs, entry.name);
  }
}

/** Scan one spec file's source for weak/forbidden canvas proof patterns. */
export function scanSpecFileContent(rel: string, text: string): SpecPatternWarning[] {
  const warnings: SpecPatternWarning[] = [];
  const mentionsBelow = BELOW_FOLD_HINT.test(text);
  const layoutSpec = LAYOUT_PROOF_HINT.test(text);
  const hasScroll = SCROLL_PROOF.test(text);
  const screenshotCount = (text.match(/screenshotStep|page\.screenshot/g) ?? []).length;
  const usesCanvasHelper = /canvas-interaction/.test(text);

  if (mentionsBelow && !hasScroll) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "Mentions below-fold content but no scroll — import scrollAndCapture or scrollCanvasWheel/scrollCanvasDrag from ./helpers/canvas-interaction (in THIS project, not pi-client templates).",
    });
  }

  if (DOM_SCROLL_CHEAT.test(text)) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "Uses DOM window/document scroll — does not work on Flutter canvas. Use ./helpers/canvas-interaction instead.",
    });
  }

  if (STORAGE_CHEAT.test(text)) {
    warnings.push({
      file: rel,
      blocking: true,
      message: "Uses localStorage/sessionStorage — not valid UI proof; screenshot on the named screen.",
    });
  }

  if (EVAL_INJECT.test(text)) {
    warnings.push({
      file: rel,
      blocking: true,
      message: "Uses page.evaluate — forbidden for UI flows; use clicks/scroll helpers in the spec.",
    });
  }

  if (layoutSpec && CANVAS_ONLY_ASSERT.test(text) && screenshotCount < 2) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "Layout/achievement spec only asserts canvas visible — need before+after screenshots (scrollAndCapture) and vision review; canvas.toBeVisible() is not proof.",
    });
  }

  if (layoutSpec && hasScroll && screenshotCount < 2 && !/scrollAndCapture/.test(text)) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "Layout spec scrolls once with one screenshot — use scrollAndCapture(beforePath, afterPath) with wheel + drag fallback; compare JPGs.",
    });
  }

  if (layoutSpec && !usesCanvasHelper && hasScroll && /mouse\.wheel/.test(text)) {
    warnings.push({
      file: rel,
      blocking: false,
      message: "Prefer ./helpers/canvas-interaction over raw page.mouse.wheel for Flutter canvas scroll.",
    });
  }

  return warnings;
}

export function scanSpecPatterns(cwd: string, config: ScenariosConfig): SpecPatternWarning[] {
  const scenariosRoot = path.join(cwd, config.scenariosDir);
  const warnings: SpecPatternWarning[] = [];

  walkSpecs(scenariosRoot, (abs, name) => {
    if (isScratchSpecFile(name)) return;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      return;
    }
    const rel = path.relative(cwd, abs).replace(/\\/g, "/");
    warnings.push(...scanSpecFileContent(rel, text));
  });

  return warnings;
}

export function formatSpecPatternWarnings(warnings: SpecPatternWarning[]): string[] {
  if (warnings.length === 0) return [];
  const lines = ["WEAK SPEC PATTERNS (fix before trusting pass):"];
  for (const w of warnings) {
    const tag = w.blocking ? "BLOCKING" : "hint";
    lines.push(`  - [${tag}] ${w.file}`);
    lines.push(`    ${w.message}`);
  }
  lines.push("  → Helpers: .pi/scenarios/helpers/canvas-interaction.ts in THIS repo");
  lines.push("  → scrollAndCapture(page, { beforePath, afterPath, wheelDy, dragDy })");
  return lines;
}

export function hasBlockingSpecWarnings(warnings: SpecPatternWarning[]): boolean {
  return warnings.some((w) => w.blocking);
}
