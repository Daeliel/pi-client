// Generic pattern — copy to .pi/scenarios/ and adapt.
// Use ONE Playwright session: screenshot before action, after action, then assert.
// For canvas/Flutter: replace getByRole with page.mouse.click(x, y) from a working spec.

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { attachConsoleCapture } from "./helpers/console-capture";

const OUT_DIR = path.join(".pi/scenarios/output");

test("visual: element size stable across state change", async ({ page }) => {
  const consoleCapture = attachConsoleCapture(page);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // --- Idle / before ---
  await page.screenshot({ path: path.join(OUT_DIR, "before.jpeg"), type: "jpeg", quality: 85 });

  // Optional: record baseline size when a DOM target exists
  const target = page.locator("[data-testid='main-widget']").first();
  const beforeBox = (await target.count()) > 0 ? await target.boundingBox() : null;

  // --- User action (adapt: role, test id, or mouse.click for canvas) ---
  await page.getByRole("button", { name: /start/i }).click();
  await page.waitForTimeout(500);

  // --- After ---
  await page.screenshot({ path: path.join(OUT_DIR, "after.jpeg"), type: "jpeg", quality: 85 });

  const afterBox = (await target.count()) > 0 ? await target.boundingBox() : null;

  if (beforeBox && afterBox) {
    expect(afterBox.width).toBeCloseTo(beforeBox.width, 0);
    expect(afterBox.height).toBeCloseTo(beforeBox.height, 0);
  }

  consoleCapture.assertClean();
});
