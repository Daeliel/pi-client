// Generic symptom-first repro — copy to .pi/scenarios/ and adapt.
// Rule: follow the user's steps IN ORDER, then assert on the screen/state THEY named.
// Do NOT substitute a counter, log, or check on a different screen as proof.
// Do NOT inject app state (localStorage, page.evaluate) to skip UI — prove the user flow with clicks/navigation.

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { attachConsoleCapture } from "./helpers/console-capture";
import { scrollAndCapture, screenshotStep } from "./helpers/canvas-interaction";

const OUT_DIR = path.join(".pi/scenarios/output");

test("symptom: reported screen shows expected content", async ({ page }) => {
  const consoleCapture = attachConsoleCapture(page);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // --- Step 1: setup state the user had (login, start session, load level, etc.) ---
  // await page.getByRole("button", { name: /start/i }).click();
  // await page.mouse.click(400, 300); // canvas / game: reuse coords from a passing spec

  // --- Step 2: navigate to the screen/tab/level the USER named ---
  // Reuse page.mouse.click(x, y) from a PASSING spec in this project — do not guess coords.
  // await page.getByRole("tab", { name: /history/i }).click();
  // await page.mouse.click(640, 560);
  await screenshotStep(page, path.join(OUT_DIR, "03-history-top.jpeg"));

  // --- Step 2b: scroll when the fix/content is below the fold (lists, timelines, achievements) ---
  // await scrollAndCapture(page, {
  //   beforePath: path.join(OUT_DIR, "04-before-scroll.jpeg"),
  //   afterPath: path.join(OUT_DIR, "05-after-scroll.jpeg"),
  //   wheelDy: 800,
  //   dragDy: 500,
  // });

  await page.waitForTimeout(500);

  // --- Step 3: prove ON THAT SCREEN (screenshot + assert) ---
  await screenshotStep(page, path.join(OUT_DIR, "symptom-screen.jpeg"));

  // DOM app: assert visible content the user expected
  // await expect(page.getByText(/record/i).first()).toBeVisible();

  // Canvas/game: assert via screenshot in output/ + vision review, or app-specific probe if available
  await expect(page.locator("canvas, body")).toBeVisible();

  consoleCapture.assertClean();
});
