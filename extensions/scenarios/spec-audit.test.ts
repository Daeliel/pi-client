import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanSpecFileContent, hasBlockingSpecWarnings } from "./spec-audit.ts";

describe("spec-audit", () => {
  it("blocks localStorage cheats", () => {
    const w = scanSpecFileContent(
      "x.spec.ts",
      `test("t", async ({ page }) => { await page.evaluate(() => localStorage.setItem("a", "1")); });`,
    );
    assert.ok(hasBlockingSpecWarnings(w));
    assert.ok(w.some((x) => /localStorage|page\.evaluate/i.test(x.message)));
  });

  it("blocks below-fold without scroll", () => {
    const w = scanSpecFileContent(
      "hist.spec.ts",
      `// scroll history list below fold\ntest("t", async ({ page }) => { await expect(page.locator("canvas")).toBeVisible(); });`,
    );
    assert.ok(w.some((x) => x.blocking && /scroll/i.test(x.message)));
  });
});
