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

  it("keeps canvas rules away from ordinary DOM specs", () => {
    const w = scanSpecFileContent(
      "todo.spec.ts",
      `test("delete item from list", async ({ page }) => {
        await page.getByRole("button", { name: "Delete" }).first().click();
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await expect(page.getByText("No items")).toBeVisible();
      });`,
    );
    assert.equal(hasBlockingSpecWarnings(w), false, JSON.stringify(w));
  });

  it("applies canvas rules to canvas specs and canvas projects", () => {
    const body = `test("history list", async ({ page }) => { await page.mouse.click(10, 10); });`;
    assert.ok(hasBlockingSpecWarnings(scanSpecFileContent("h.spec.ts", body, { canvasProject: true })));
    const scrolling = `test("scroll to history", async ({ page }) => { await page.mouse.click(10, 10); });`;
    assert.ok(hasBlockingSpecWarnings(scanSpecFileContent("h.spec.ts", scrolling)));
    const dom = `test("history list", async ({ page }) => { await page.getByText("x").click(); });`;
    assert.ok(!hasBlockingSpecWarnings(scanSpecFileContent("h.spec.ts", dom)));
    assert.ok(hasBlockingSpecWarnings(scanSpecFileContent("h.spec.ts", dom, { canvasProject: true })));
  });

  it("only hints at scrolling for list/bottom words in a fixed-size canvas game", () => {
    const game = `import { clickCanvas } from "./helpers/canvas-interaction";
      test("Q and E cycle the room type list", async ({ page }) => {
        await page.mouse.click(480, 320);
        await page.keyboard.press("E");
        // the type label sits at the bottom of the canvas
        await expect(page.locator("canvas")).toBeVisible();
      });`;
    const w = scanSpecFileContent("type-cycle.spec.ts", game);
    assert.equal(hasBlockingSpecWarnings(w), false, JSON.stringify(w));
    assert.ok(w.some((x) => /does not scroll/.test(x.message)));
  });

  it("allows read-only page.evaluate but blocks state changes", () => {
    const read = `const w = await page.evaluate(() => getComputedStyle(document.querySelector(".card")!).width);`;
    assert.ok(!hasBlockingSpecWarnings(scanSpecFileContent("r.spec.ts", read)));
    for (const write of [
      `await page.evaluate(() => { window.gameState.level = 5; });`,
      `await page.evaluate(() => document.querySelector("button")!.click());`,
      `await page.evaluate(() => window.dispatchEvent(new Event("resize")));`,
    ]) {
      assert.ok(hasBlockingSpecWarnings(scanSpecFileContent("w.spec.ts", write)), write);
    }
  });
});

