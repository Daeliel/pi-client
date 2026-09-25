import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { ScenariosConfig } from "./config";
import { resolvePlaywrightCli } from "./playwright-cli";

const pexec = promisify(exec);

export type VisionImageContent = { type: "image"; mimeType: string; data: string };

export const QA_CAPTURE_SPEC = ".pi/scenarios/__qa-capture.spec.ts";

export const VISUAL_CHECKLIST = `Review the screenshot(s) for:
- **Blank/white image** — NOT valid proof (Flutter/canvas not rendered, or stale build). Rebuild if needed, wait for canvas, or use browser_screenshot on live Chrome.
- overlapping elements hiding buttons or text
- clipped or truncated content
- misalignment, wrong spacing, broken layout
- modals or panels covering main UI
If you see issues, fix CSS/layout/DOM and rerun checks.
If visuals match the design intent, call confirm_visual_qa({ approved: true }).`;

/** Bump when capture spec behavior changes — triggers rewrite of project __qa-capture.spec.ts */
export const QA_CAPTURE_SPEC_VERSION = "pi-client-qa-capture-v2";

const QA_CAPTURE_SPEC_TEMPLATE = `import { test } from "@playwright/test";

// ${QA_CAPTURE_SPEC_VERSION} — auto-managed by pi-client; do not remove the version line.
test("__qa_capture @qa", async ({ page }) => {
  const urlPath = process.env.PI_QA_PATH ?? "/";
  const out = process.env.PI_QA_OUTPUT ?? "../qa-shot.jpg";
  await page.goto(urlPath, { waitUntil: "domcontentloaded" });

  // Flutter / canvas web apps: screenshot immediately is blank — wait like acceptance specs.
  const canvas = page.locator("canvas").first();
  const hasCanvas = await canvas
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (hasCanvas) {
    await page.waitForTimeout(1500);
  } else {
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(800);
  }

  await page.screenshot({
    path: out,
    type: "jpeg",
    quality: 80,
    fullPage: false,
  });
});
`;

function walkFiles(dir: string, visit: (file: string) => void): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, visit);
    else visit(full);
  }
}

export function testResultsDir(cwd: string, config: ScenariosConfig): string {
  // outputDir in .pi/playwright.config.ts is relative to that config file (./test-results → .pi/test-results).
  const configDir = path.dirname(path.join(cwd, config.playwrightConfig));
  return path.join(configDir, "test-results");
}

/** Wipe Playwright artifact dir before a run (avoids disk bloat). */
export function pruneTestResults(cwd: string, config: ScenariosConfig): void {
  const dir = testResultsDir(cwd, config);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Newest failure screenshots under test-results (png/jpeg). */
export function findFailureScreenshots(cwd: string, config: ScenariosConfig, sinceMs?: number): string[] {
  const dir = testResultsDir(cwd, config);
  const hits: { path: string; mtime: number }[] = [];
  walkFiles(dir, (file) => {
    if (!/\.(png|jpe?g)$/i.test(file)) return;
    const stat = fs.statSync(file);
    if (sinceMs !== undefined && stat.mtimeMs < sinceMs) return;
    hits.push({ path: file, mtime: stat.mtimeMs });
  });
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits.map((h) => h.path);
}

/** Screenshots specs write under .pi/scenarios/output/ during a run. */
export function findScenarioOutputScreenshots(
  cwd: string,
  config: ScenariosConfig,
  sinceMs?: number,
): string[] {
  const dir = path.join(cwd, config.scenariosDir, "output");
  const hits: { path: string; mtime: number }[] = [];
  walkFiles(dir, (file) => {
    if (!/\.(png|jpe?g)$/i.test(file)) return;
    const stat = fs.statSync(file);
    if (sinceMs !== undefined && stat.mtimeMs < sinceMs) return;
    hits.push({ path: file, mtime: stat.mtimeMs });
  });
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits.map((h) => h.path);
}

async function fileToImageContent(filePath: string, config: ScenariosConfig): Promise<VisionImageContent | null> {
  try {
    const buf = fs.readFileSync(filePath);
    const mime = /\.png$/i.test(filePath) ? "image/png" : "image/jpeg";
    let data = buf.toString("base64");
    let mimeType = mime;

    const resized = await resizeImage(buf, mime, {
      maxWidth: config.maxImageWidth,
      maxHeight: config.maxImageWidth,
      maxBytes: config.maxImageBytes,
      jpegQuality: config.jpegQuality,
    });
    if (resized) {
      data = resized.data;
      mimeType = resized.mimeType;
    }

    return { type: "image", mimeType, data };
  } catch {
    return null;
  }
}

export async function loadVisionImages(
  filePaths: string[],
  config: ScenariosConfig,
): Promise<{ images: VisionImageContent[]; paths: string[] }> {
  const capped = filePaths.slice(0, config.maxScreenshotsPerRun);
  const images: VisionImageContent[] = [];
  const paths: string[] = [];
  for (const p of capped) {
    const img = await fileToImageContent(p, config);
    if (!img) continue;
    images.push(img);
    paths.push(p);
  }
  return { images, paths };
}

export function buildVisionMessage(intro: string, attachedPaths: string[]): string {
  const lines = [intro];
  if (attachedPaths.length > 0) {
    lines.push("", "Screenshots attached:", ...attachedPaths.map((p) => `  - ${p}`));
  }
  lines.push("", VISUAL_CHECKLIST);
  return lines.join("\n");
}

export function buildVisionContent(intro: string, images: VisionImageContent[], attachedPaths: string[]) {
  const text = buildVisionMessage(intro, attachedPaths);
  return [{ type: "text" as const, text }, ...images];
}

function ensureQaCaptureSpec(cwd: string): void {
  const specPath = path.join(cwd, QA_CAPTURE_SPEC);
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  if (fs.existsSync(specPath)) {
    const existing = fs.readFileSync(specPath, "utf8");
    if (existing.includes(QA_CAPTURE_SPEC_VERSION)) return;
  }
  fs.writeFileSync(specPath, QA_CAPTURE_SPEC_TEMPLATE, "utf8");
}

/** Heuristic: flat/empty JPEG (Flutter canvas not painted yet). */
export function isLikelyBlankCapture(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return true;
  const buf = fs.readFileSync(filePath);
  if (buf.length < 1500) return true;
  const sample: number[] = [];
  for (let i = 0; i < Math.min(buf.length, 40_000); i += 400) {
    sample.push(buf[i]!);
  }
  if (sample.length < 8) return false;
  const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
  const variance = sample.reduce((a, b) => a + (b - mean) ** 2, 0) / sample.length;
  return variance < 8;
}

export interface CaptureResult {
  ok: boolean;
  outputPath: string;
  error?: string;
}

async function runPlaywrightCapture(
  cwd: string,
  config: ScenariosConfig,
  specRel: string,
  outputRel: string,
  urlPath: string,
  grep: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  const outputAbs = path.join(cwd, outputRel);
  fs.mkdirSync(path.dirname(outputAbs), { recursive: true });

  const pw = await resolvePlaywrightCli(cwd);
  const cmd = `${pw} test "${specRel}" --config "${config.playwrightConfig}" --grep "${grep}"`;
  const env = {
    ...process.env,
    PI_QA_PATH: urlPath,
    PI_QA_OUTPUT: outputAbs,
  };

  if (signal?.aborted) {
    return { ok: false, outputPath: outputRel, error: "aborted" };
  }

  try {
    await pexec(cmd, {
      cwd,
      env,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "capture failed";
    return { ok: false, outputPath: outputRel, error: out };
  }

  if (!fs.existsSync(outputAbs)) {
    return { ok: false, outputPath: outputRel, error: "screenshot file was not created" };
  }

  if (isLikelyBlankCapture(outputAbs)) {
    return {
      ok: false,
      outputPath: outputRel,
      error:
        "screenshot looks blank (Flutter/canvas may not have rendered). " +
        "Rebuild web assets if Dart changed, ensure server is up, retry capture, or use browser_screenshot on live Chrome.",
    };
  }

  return { ok: true, outputPath: outputRel };
}

/** QA viewport shot via Playwright (uses webServer from playwright.config). */
export async function captureQaShot(
  cwd: string,
  config: ScenariosConfig,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  ensureQaCaptureSpec(cwd);
  return runPlaywrightCapture(
    cwd,
    config,
    QA_CAPTURE_SPEC,
    config.qaShot.outputPath,
    config.qaShot.urlPath,
    "@qa",
    config.timeoutMs,
    signal,
  );
}

/** On-demand page capture (same mechanism, custom output path). */
export async function capturePageScreenshot(
  cwd: string,
  config: ScenariosConfig,
  urlPath: string,
  outputRel: string,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  ensureQaCaptureSpec(cwd);
  return runPlaywrightCapture(
    cwd,
    config,
    QA_CAPTURE_SPEC,
    outputRel,
    urlPath,
    "@qa",
    config.timeoutMs,
    signal,
  );
}
