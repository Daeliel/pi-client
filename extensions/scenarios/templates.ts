import type { PlaywrightServeHint } from "../shared/stack-detect";

/** Default when stack detection has no web hint. */
const DEFAULT_SERVE: PlaywrightServeHint = {
  command: "npm run dev",
  url: "http://localhost:5173",
  note: "Edit baseURL and webServer for this app (port, start command).",
};

/** Build stack-aware Playwright config (never overwrite existing project file). */
export function buildPlaywrightConfigTemplate(serve?: PlaywrightServeHint | null): string {
  const s = serve ?? DEFAULT_SERVE;
  const command = s.command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const url = s.url;
  return `import { defineConfig } from "@playwright/test";

/**
 * Per-project Playwright config for Pi acceptance scenarios.
 * ${s.note}
 * Playwright itself is installed once on the client PC (install-on-client.bat).
 */
export default defineConfig({
  testDir: "./scenarios",
  outputDir: "./test-results",
  timeout: 30_000,
  use: {
    baseURL: "${url}",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "${command}",
    url: "${url}",
    reuseExistingServer: !process.env.CI,
  },
});
`;
}

/** Scaffolded into each project when web scenarios are defined (not overwritten if present). */
export const PLAYWRIGHT_CONFIG_TEMPLATE = buildPlaywrightConfigTemplate(DEFAULT_SERVE);

/** Bump when helper behavior changes — triggers rewrite of project helpers/console-capture.ts */
export const CONSOLE_CAPTURE_HELPER_VERSION = "pi-client-console-capture-v1";

/** Copied to .pi/scenarios/helpers/console-capture.ts on first web scenario (version-managed). */
export const CONSOLE_CAPTURE_HELPER_TEMPLATE = `import type { Page } from "@playwright/test";

// ${CONSOLE_CAPTURE_HELPER_VERSION} — auto-managed by pi-client; do not remove the version line.

type ConsoleLevel = "error" | "warning" | "warn" | "info" | "log" | "debug" | "pageerror";

interface ConsoleEntry {
  level: ConsoleLevel;
  message: string;
  repeatCount: number;
}

export interface ConsoleCaptureOptions {
  /** Treat console.warn as failure (default false — errors and pageerror only). */
  includeWarnings?: boolean;
  /** Collapse identical messages (default true — tames render-loop spam). */
  dedupe?: boolean;
  maxReportGroups?: number;
  maxReportChars?: number;
}

export interface ConsoleCapture {
  /** Total failure events (includes collapsed repeats). */
  readonly errorCount: number;
  /** Capped text report for test output / failures. */
  getReport(): string;
  /** Throws if any console errors were captured in this page session. */
  assertClean(): void;
}

function normalizeMessage(message: string): string {
  return message
    .replace(/Instance of 'minified:[^']+'/gi, "Instance of 'minified:*'")
    .replace(/Another exception was thrown:\\s*/gi, "")
    .replace(/\\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function fingerprint(level: ConsoleLevel, message: string): string {
  return \`\${level}|\${normalizeMessage(message)}\`;
}

function isFailure(level: ConsoleLevel, includeWarnings: boolean): boolean {
  if (level === "error" || level === "pageerror") return true;
  if (includeWarnings && (level === "warn" || level === "warning")) return true;
  return false;
}

function formatReport(entries: ConsoleEntry[], maxGroups: number, maxChars: number): string {
  if (entries.length === 0) return "(no console errors)";
  const lines: string[] = [];
  let chars = 0;
  let shownEvents = 0;

  for (let i = 0; i < entries.length && lines.length < maxGroups; i++) {
    const e = entries[i]!;
    const repeat = e.repeatCount > 1 ? \` (×\${e.repeatCount})\` : "";
    const line = \`- [\${e.level}] \${e.message}\${repeat}\`;
    if (chars + line.length > maxChars) {
      lines.push(\`… \${entries.length - i} more unique message(s) omitted\`);
      break;
    }
    lines.push(line);
    chars += line.length;
    shownEvents += e.repeatCount;
  }

  const totalEvents = entries.reduce((sum, e) => sum + e.repeatCount, 0);
  const summary =
    totalEvents > shownEvents
      ? \`\\nSummary: \${totalEvents} console event(s), \${entries.length} unique.\`
      : "";
  return \`\${lines.join("\\n")}\${summary}\`;
}

/** Attach console + pageerror listeners for the rest of this test (same session as clicks/screenshots). */
export function attachConsoleCapture(page: Page, options: ConsoleCaptureOptions = {}): ConsoleCapture {
  const includeWarnings = options.includeWarnings ?? false;
  const dedupe = options.dedupe ?? true;
  const maxReportGroups = options.maxReportGroups ?? 20;
  const maxReportChars = options.maxReportChars ?? 12_000;

  const entries: ConsoleEntry[] = [];
  const indexByFingerprint = new Map<string, number>();

  const push = (level: ConsoleLevel, raw: string) => {
    const message = raw.trim() || "(empty console message)";
    const fp = fingerprint(level, message);
    if (dedupe) {
      const idx = indexByFingerprint.get(fp);
      if (idx !== undefined) {
        entries[idx]!.repeatCount += 1;
        return;
      }
    }
    indexByFingerprint.set(fp, entries.length);
    entries.push({ level, message, repeatCount: 1 });
  };

  page.on("console", (msg) => {
    const type = msg.type();
    const level: ConsoleLevel = type === "warning" ? "warn" : (type as ConsoleLevel);
    push(level, msg.text());
  });

  page.on("pageerror", (err) => {
    push("pageerror", err.message);
  });

  const failures = () => entries.filter((e) => isFailure(e.level, includeWarnings));

  return {
    get errorCount() {
      return failures().reduce((sum, e) => sum + e.repeatCount, 0);
    },
    getReport() {
      return formatReport(failures(), maxReportGroups, maxReportChars);
    },
    assertClean() {
      const fails = failures();
      if (fails.length === 0) return;
      throw new Error(\`Console errors during Playwright scenario:\\n\${formatReport(fails, maxReportGroups, maxReportChars)}\`);
    },
  };
}
`;

/** Bump when helper behavior changes — triggers rewrite of project helpers/canvas-interaction.ts */
export const CANVAS_INTERACTION_HELPER_VERSION = "pi-client-canvas-interaction-v2";

/** Copied to .pi/scenarios/helpers/canvas-interaction.ts on first web scenario (version-managed). */
export const CANVAS_INTERACTION_HELPER_TEMPLATE = `import type { Page } from "@playwright/test";

// ${CANVAS_INTERACTION_HELPER_VERSION} — auto-managed by pi-client; do not remove the version line.

export interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Wait for the Flutter/game canvas and return its viewport box. */
export async function canvasBox(page: Page): Promise<CanvasBox> {
  const canvas = page.locator("canvas").first();
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas bounding box not found");
  return box;
}

/** Mouse wheel scroll over canvas center (works on many web scroll views). */
export async function scrollCanvasWheel(
  page: Page,
  dy: number,
  options: { waitMs?: number } = {},
): Promise<void> {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(options.waitMs ?? 400);
}

/**
 * Drag scroll on canvas (Flutter ListView on web often needs this instead of wheel).
 * dy > 0 scrolls content up (finger drags up — content moves down).
 */
export async function scrollCanvasDrag(
  page: Page,
  dy: number,
  options: { waitMs?: number; startYRatio?: number } = {},
): Promise<void> {
  const box = await canvasBox(page);
  const cx = box.x + box.width / 2;
  const startY = box.y + box.height * (options.startYRatio ?? 0.7);
  const endY = startY - dy;
  await page.mouse.move(cx, startY);
  await page.mouse.down();
  await page.mouse.move(cx, endY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(options.waitMs ?? 400);
}

/** Wheel scroll; use scrollCanvasDrag if content below the fold still missing in screenshots. */
export async function scrollCanvas(page: Page, dy: number): Promise<void> {
  await scrollCanvasWheel(page, dy);
}

/** Named step screenshot for vision review (same Playwright session as clicks/scroll). */
export async function screenshotStep(page: Page, outPath: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: outPath, type: "jpeg", quality: 85 });
}

/**
 * Before/after scroll proof for below-the-fold layout checks.
 * Takes before JPG, wheel scroll, optional drag scroll, after JPG — compare in vision review.
 */
export async function scrollAndCapture(
  page: Page,
  options: {
    beforePath: string;
    afterPath: string;
    wheelDy?: number;
    dragDy?: number;
  },
): Promise<void> {
  await screenshotStep(page, options.beforePath);
  const wheel = options.wheelDy ?? 800;
  await scrollCanvasWheel(page, wheel, { waitMs: 600 });
  if (options.dragDy) {
    await scrollCanvasDrag(page, options.dragDy, { waitMs: 600 });
  }
  await screenshotStep(page, options.afterPath);
}
`;
