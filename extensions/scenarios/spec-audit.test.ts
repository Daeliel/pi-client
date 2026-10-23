import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyAppCall, evaluateBodies, evaluateWrites, scanSpecFileContent, hasBlockingSpecWarnings } from "./spec-audit.ts";

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
    assert.match(w.map((x) => x.message).join(), /@journey spec does what the user does through the app's own functions \(commitBlueprint\(\)\)/);

    // Setters are setup only when declared, with why; the report lists them.
    const setShield = `await page.evaluate(() => { const g = (window as any).__game; g.hooks.setShield(3); });`;
    const undeclared = scanSpecFileContent("j.spec.ts", journey(setShield));
    assert.ok(hasBlockingSpecWarnings(undeclared), "an alias does not hide the call");
    assert.match(undeclared.map((x) => x.message).join(), /does not declare \(setShield\(\)\)[\s\S]*\/\/ @hooks: setShield — /);
    const declared = scanSpecFileContent("j.spec.ts", `// @hooks: setShield — start the run at 3 shield
${journey(setShield)}`);
    assert.ok(!hasBlockingSpecWarnings(declared));
    assert.match(declared.find((x) => x.note)!.message, /not played\): setShield — start the run at 3 shield/);
    // A step the user takes stays blocked even when declared.
    const start = `// @hooks: start — skip the title
${journey("await page.evaluate(() => window.__game.start());")}`;
    assert.match(scanSpecFileContent("j.spec.ts", start).map((x) => x.message).join(), /does what the user does .*start\(\)/);
  });

  it("outside a journey, setting a state to screenshot it is fine; taking the user's steps with no UI is not", () => {
    const hud = `test("hud", async ({ page }) => { await page.evaluate(() => window.__game.setShield(3)); await page.screenshot({ path: "a.png" }); });`;
    assert.ok(!hasBlockingSpecWarnings(scanSpecFileContent("hud.spec.ts", hud)));
    const steps = `test("x", async ({ page }) => { await page.evaluate(() => window.__game.startRun()); });`;
    assert.ok(hasBlockingSpecWarnings(scanSpecFileContent("x.spec.ts", steps)));
  });

  it("long waits get a hint to use a time hook; a time hook is a condition, fine in a journey", () => {
    const slow = `test("the fight ends", async ({ page }) => {
      await page.keyboard.press("Space");
      await page.waitForTimeout(5000);
      await expect.poll(async () => (await page.evaluate(() => window.__game.state())).phase, { timeout: 12_000 }).toBe("gameover");
    });`;
    const w = scanSpecFileContent("fight.spec.ts", slow);
    assert.ok(!hasBlockingSpecWarnings(w), "a hint, never blocking");
    assert.match(w.map((x) => x.message).join(), /sleeps 5s, waits up to 12s .*setTimeScale/);
    const quick = `test("the fight ends @journey", async ({ page }) => {
      await page.evaluate(() => window.__game.setTimeScale(8));
      await page.keyboard.press("Space");
      await page.evaluate(() => window.__game.step(3));
      await page.waitForTimeout(300);
    });`;
    assert.deepEqual(scanSpecFileContent("fight.spec.ts", quick).filter((x) => !x.note), [], "short waits, time hooks as conditions");
    assert.match(scanSpecFileContent("s.spec.ts", `test.describe.configure({ timeout: 90_000 });`).map((x) => x.message).join(), /allows 90s per test/);
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
  it("comments and TypeScript annotations are not code: an apostrophe in a comment does not swallow the evaluate", () => {
    const spec = [
      "test('aim', async ({ page }) => {",
      "  const r = await page.evaluate(() => {",
      "    const aims: number[] = (window as any).__G__.hooks.wagonAim();",
      "    // The wagon's own heading (from its neighbour",
      "    let d = Math.abs(aims[0]);",
      "    while (d > Math.PI) d = Math.abs(d - Math.PI * 2);",
      "    return d;",
      "  });",
      "  await page.mouse.click(10, 10);",
      "});",
    ].join("\n");
    const bodies = evaluateBodies(spec);
    assert.equal(bodies.length, 1);
    assert.ok(!bodies[0]!.includes("mouse.click"), "the body ends where the evaluate ends");
    assert.equal(evaluateWrites(bodies[0]!), false);
    assert.ok(!hasBlockingSpecWarnings(scanSpecFileContent("aim.spec.ts", spec)));
    // ...and a real write after such a comment is still caught
    assert.equal(evaluateWrites("() => { // don't skip\n (window as any).__G__.stage = 3; }"), true);
  });

  it("time hooks with a unit are conditions; skip/advance alone stay actions", () => {
    for (const n of ["stepSeconds", "tickFrames", "advanceBy", "advanceFrames", "skipTime", "fastForwardMs", "step"]) {
      assert.equal(classifyAppCall(n), "condition", n);
    }
    for (const n of ["skip", "skipTutorial", "advanceLevel", "start"]) assert.equal(classifyAppCall(n), "action", n);
  });
});

