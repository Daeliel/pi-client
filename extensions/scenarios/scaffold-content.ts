export type ScaffoldTemplate = "symptom-repro" | "visual-before-after" | "api";

export interface ScaffoldParams {
  template: ScaffoldTemplate;
  id: string;
  title: string;
  steps: string;
  /** Relative path; default derived from id. */
  testFile?: string;
  /** Screen/tab/level the user named (injected as comments). */
  screenName?: string;
}

export function slugId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export function defaultTestFile(template: ScaffoldTemplate, id: string, scenariosDir: string): string {
  const slug = slugId(id) || "scenario";
  if (template === "api") return `${scenariosDir}/${slug}.test.py`;
  return `${scenariosDir}/${slug}.spec.ts`;
}

function fillSymptomRepro(params: ScaffoldParams): string {
  const screen = params.screenName ?? "the screen the user named";
  const stepsComment = params.steps
    .split(/\n/)
    .map((l) => `//   ${l}`)
    .join("\n");
  return `// Scaffolded by scaffold_scenario (symptom-repro) — adapt clicks/asserts; freeform edits are fine.
// Screen under test: ${screen}
// Steps:
${stepsComment}

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { attachConsoleCapture } from "./helpers/console-capture";
import { screenshotStep } from "./helpers/canvas-interaction";

const OUT_DIR = path.join(".pi/scenarios/output");

test(${JSON.stringify(params.title)}, async ({ page }) => {
  const consoleCapture = attachConsoleCapture(page);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // Follow user steps in order — reach "${screen}" then assert there.
  // await page.getByRole("button", { name: /start/i }).click();
  // await page.mouse.click(400, 300); // canvas: reuse coords from a passing spec

  await screenshotStep(page, path.join(OUT_DIR, "symptom-screen.jpeg"));

  // DOM: await expect(page.getByText(/expected/i).first()).toBeVisible();
  // Canvas: review screenshot + assert something that fails on the wrong screen
  await expect(page.locator("canvas, body")).toBeVisible();

  consoleCapture.assertClean();
});
`;
}

function fillVisualBeforeAfter(params: ScaffoldParams): string {
  const screen = params.screenName ?? "target UI";
  return `// Scaffolded by scaffold_scenario (visual-before-after) — adapt for ${screen}.

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { attachConsoleCapture } from "./helpers/console-capture";

const OUT_DIR = path.join(".pi/scenarios/output");

test(${JSON.stringify(params.title)}, async ({ page }) => {
  const consoleCapture = attachConsoleCapture(page);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await page.screenshot({ path: path.join(OUT_DIR, "before.jpeg"), type: "jpeg", quality: 85 });

  // User action that should change layout/size:
  // await page.getByRole("button", { name: /start/i }).click();
  await page.waitForTimeout(500);

  await page.screenshot({ path: path.join(OUT_DIR, "after.jpeg"), type: "jpeg", quality: 85 });

  // Optional DOM size check:
  // const box = await page.locator("[data-testid='main-widget']").boundingBox();
  // expect(box?.width).toBeTruthy();

  consoleCapture.assertClean();
});
`;
}

function fillApi(params: ScaffoldParams): string {
  const stepsComment = params.steps
    .split(/\n/)
    .map((l) => `#   ${l}`)
    .join("\n");
  return `# Scaffolded by scaffold_scenario (api) — adapt URL/asserts.
# ${params.title}
# Steps:
${stepsComment}

import httpx

def test_${slugId(params.id).replace(/-/g, "_") || "api_flow"}():
    # Prove the API behaviour with a real HTTP call (do not mock away the code under test).
    r = httpx.get("http://127.0.0.1:8000/health", timeout=10.0)
    assert r.status_code == 200
`;
}

export function renderScaffoldContent(params: ScaffoldParams): string {
  if (params.template === "api") return fillApi(params);
  if (params.template === "visual-before-after") return fillVisualBeforeAfter(params);
  return fillSymptomRepro(params);
}
