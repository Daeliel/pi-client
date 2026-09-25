// Example web acceptance scenario — copy to .pi/scenarios/ and adapt.
//
// Playwright is installed once on the client PC (install-on-client.bat).
// Per app: edit .pi/playwright.config.ts (dev server command, port, baseURL).
//
// helpers/console-capture.ts is auto-scaffolded on first web scenario.

import { test, expect } from "@playwright/test";
import { attachConsoleCapture } from "./helpers/console-capture";

test("start button begins countdown", async ({ page }, testInfo) => {
  const consoleCapture = attachConsoleCapture(page);

  await page.goto("/");
  if (testInfo.retry === 0) {
    await testInfo.attach("before-start", {
      body: await page.screenshot({ type: "jpeg", quality: 80 }),
      contentType: "image/jpeg",
    });
  }
  await page.getByRole("button", { name: /start/i }).click();
  await expect(page.getByTestId("countdown-display")).not.toHaveText("0:00");

  consoleCapture.assertClean();
});
