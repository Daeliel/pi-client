import * as fs from "node:fs";
import * as path from "node:path";
import type { ScenariosConfig } from "./config";
import { isScratchSpecFile } from "./housekeeping";
import { detectStacks } from "../shared/stack-detect";

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

/** Spec drives a canvas (Flutter web, games): DOM locators cannot see inside it. */
const CANVAS_SPEC = /canvas|canvas-interaction|mouse\.(?:click|wheel|move|down)/i;

/** Things inside page.evaluate that change the page instead of reading it. */
const EVAL_WRITE =
  /(?:^|[^=!<>])=(?![=>])|\+\+|--|\.click\s*\(|dispatchEvent|setItem|removeItem|\.push\s*\(|\.splice\s*\(|innerHTML|textContent\s*=|\.value\s*=|\.focus\s*\(|submit\s*\(/;

/** Bodies of every page.evaluate(...) call (paren-matched, strings ignored). */
export function evaluateBodies(text: string): string[] {
  const bodies: string[] = [];
  const re = /page\.evaluate\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    let quote: string | null = null;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i]!;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    bodies.push(text.slice(m.index + m[0].length, i - 1));
  }
  return bodies;
}

export interface SpecScanOptions {
  /** Project renders its UI into a canvas (e.g. Flutter web): apply canvas rules to every spec. */
  canvasProject?: boolean;
}

/**
 * Scan one spec file's source for weak/forbidden proof patterns.
 *
 * Canvas rules (scroll helpers, "canvas visible is not proof") only apply to canvas
 * specs or canvas projects — on a normal DOM page, words like "list" or "delete"
 * and window.scrollTo are fine, and demanding canvas helpers there sends a small
 * model down the wrong path.
 */
export function scanSpecFileContent(rel: string, text: string, options: SpecScanOptions = {}): SpecPatternWarning[] {
  const warnings: SpecPatternWarning[] = [];
  const canvas = Boolean(options.canvasProject) || CANVAS_SPEC.test(text);
  const mentionsBelow = BELOW_FOLD_HINT.test(text);
  const layoutSpec = LAYOUT_PROOF_HINT.test(text);
  const hasScroll = SCROLL_PROOF.test(text);
  const screenshotCount = (text.match(/screenshotStep|page\.screenshot/g) ?? []).length;
  const usesCanvasHelper = /canvas-interaction/.test(text);

  if (STORAGE_CHEAT.test(text)) {
    warnings.push({
      file: rel,
      blocking: true,
      message: "Uses localStorage/sessionStorage — not valid UI proof; drive the UI and assert on the named screen.",
    });
  }

  const evalBodies = evaluateBodies(text);
  if (evalBodies.some((b) => EVAL_WRITE.test(b))) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "page.evaluate changes the page (assigns, clicks, dispatches or stores) — that skips the user flow. " +
        "Use real clicks/typing instead. Reading values with page.evaluate is fine.",
    });
  }

  if (!canvas) return warnings;

  if (mentionsBelow && !hasScroll) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "Canvas spec mentions below-fold content but never scrolls — import scrollAndCapture or scrollCanvasWheel/scrollCanvasDrag from ./helpers/canvas-interaction (in THIS project, not pi-client templates).",
    });
  }

  if (DOM_SCROLL_CHEAT.test(text)) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "Uses DOM window/document scroll — does not scroll a canvas. Use ./helpers/canvas-interaction instead.",
    });
  }

  if (layoutSpec && CANVAS_ONLY_ASSERT.test(text) && screenshotCount < 2) {
    warnings.push({
      file: rel,
      blocking: true,
      message:
        "Layout spec only asserts canvas visible — need before+after screenshots (scrollAndCapture) and vision review; canvas.toBeVisible() is not proof.",
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
  const canvasProject = detectStacks(cwd).stacks.includes("flutter");

  walkSpecs(scenariosRoot, (abs, name) => {
    if (isScratchSpecFile(name)) return;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      return;
    }
    const rel = path.relative(cwd, abs).replace(/\\/g, "/");
    warnings.push(...scanSpecFileContent(rel, text, { canvasProject }));
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
