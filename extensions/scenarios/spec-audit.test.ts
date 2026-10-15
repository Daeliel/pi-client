import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyAppCall, scanSpecFileContent, hasBlockingSpecWarnings } from "./spec-audit.ts";

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

  it("says nothing about scrolling for list/bottom words in a fixed-size canvas game", () => {
    const game = `import { clickCanvas } from "./helpers/canvas-interaction";
      test("Q and E cycle the room type list", async ({ page }) => {
        await page.mouse.click(480, 320);
        await page.keyboard.press("E");
        // the type label sits at the bottom of the canvas
        await expect(page.locator("canvas")).toBeVisible();
      });`;
    assert.deepEqual(scanSpecFileContent("type-cycle.spec.ts", game), [], "no warning, not even a hint");
  });

  it("page.evaluate: reads with locals pass, writes to page/app state are caught (aliases too)", () => {
    const evalSpec = (body: string) => `test("t", async ({ page }) => { await page.evaluate(${body}); });`;
    for (const read of [
      `() => window.__game.state()`,
      `() => { const s = window.__game.state(); return s.stage; }`,
      `() => { const out = []; for (const e of document.querySelectorAll('li')) out.push(e.textContent); return out; }`,
      `() => { let n = 0; for (let i = 0; i < 5; i++) n += i; return n; }`,
      `() => { const { stage, hp } = window.__game.state(); return stage === "travel" && hp >= 3; }`,
      `(sel) => document.querySelector(sel)?.textContent === "x = 1"`,
    ]) {
      assert.ok(!hasBlockingSpecWarnings(scanSpecFileContent("r.spec.ts", evalSpec(read))), read);
    }
    for (const write of [
      `() => { score = 10; }`,
      `() => window.__game.enemies.push({})`,
      `() => window.__game.lives++`,
      `() => { document.body.innerHTML = "" }`,
      `() => { const g = window.__game; g.stage = "travel"; }`,
    ]) {
      assert.ok(hasBlockingSpecWarnings(scanSpecFileContent("w.spec.ts", evalSpec(write))), write);
    }
  });

  it("back doors: the user's actions through app functions are caught, setup and reads are not", () => {
    // route-map.spec.ts as it was: reach the chart and pick a node by calling the game.
    const backdoor = `test("chart a course", async ({ page }) => {
      await page.evaluate(() => window.__game.setFeature("runMap", true));
      await page.evaluate(() => window.__game.goToStage("chart"));
      const r = await page.evaluate(() => window.__game.route());
      await page.evaluate((id) => window.__game.chartTo(id), r.choices[0].id);
      expect((await page.evaluate(() => window.__game.route())).at).toBe(r.choices[0].id);
    });`;
    const w = scanSpecFileContent("route-map.spec.ts", backdoor);
    assert.ok(hasBlockingSpecWarnings(w));
    assert.match(w.map((x) => x.message).join(), /only through its own functions \(goToStage\(\), chartTo\(\)\)/);

    // Same flow, setup by hook, the action by clicking: fine.
    const real = `test("chart a course", async ({ page }) => {
      await page.evaluate(() => window.__game.setFeature("runMap", true));
      await page.keyboard.press("Enter");
      await page.mouse.click(420, 180);
      expect((await page.evaluate(() => window.__game.route())).at).toBe("n-1-0");
    });`;
    assert.ok(!hasBlockingSpecWarnings(scanSpecFileContent("route-map.spec.ts", real)));
  });

  it("a @journey may set conditions through hooks but not perform the user's actions", () => {
    const journey = (calls: string) => `test("chart, build, travel @journey", async ({ page }) => {
      ${calls}
      await page.mouse.click(420, 180);
      await page.keyboard.press("Space");
    });`;
    const conditions = `await page.evaluate(() => { window.__game.setSeed(7); window.__game.setTimeScale(0.2); window.__game.setGodMode(true); window.__game.spawnThreat("robber"); });`;
    assert.ok(!hasBlockingSpecWarnings(scanSpecFileContent("j.spec.ts", journey(conditions))), "seed, time, invincibility, spawn are conditions");
    const w = scanSpecFileContent("j.spec.ts", journey(`await page.evaluate(() => window.__game.commitBlueprint());`));
    assert.match(w.map((x) => x.message).join(), /@journey spec performs user actions .*commitBlueprint\(\)/);
  });

  it("names: verbs are actions, nouns and lookups are reads", () => {
    for (const a of ["chartTo", "goToStage", "commitBlueprint", "prepPlaceRoom", "prepLink", "repelRobber", "spendResources", "endTravel"]) {
      assert.equal(classifyAppCall(a), "action", a);
    }
    for (const r of ["state", "route", "linkBonusFor", "levelOf", "overdriveState", "hudSnapshot", "getScore", "isOpen"]) {
      assert.equal(classifyAppCall(r), "read", r);
    }
    for (const c of ["setFeature", "setSeed", "setTimeScale", "spawnThreat", "reset", "setGodMode"]) {
      assert.equal(classifyAppCall(c), "condition", c);
    }
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

