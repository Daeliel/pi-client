import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { checkEyes, isBlind } from "./eyes";
import { buildScenariosProcedure } from "../scenarios/procedure";
import { buildBrowserProcedure } from "../browser-console/procedure";
import { scanSpecFileContent } from "../scenarios/spec-audit";

type In = ("text" | "image")[];
function ctx(session: { id: string; image: boolean }, vision: { id: string; baseUrl: string }[]) {
  const available = vision.map((v) => ({ provider: "lan", id: v.id, baseUrl: v.baseUrl, input: ["text", "image"] as In }));
  return {
    cwd: os.tmpdir(),
    model: { provider: "lab", id: session.id, input: (session.image ? ["text", "image"] : ["text"]) as In },
    modelRegistry: {
      getAvailable: () => available,
      find: (provider: string, id: string) => available.find((m) => m.provider === provider && m.id === id) ?? null,
      hasConfiguredAuth: () => true,
    },
  } as never;
}

describe("eyes", () => {
  it("a model that sees images is not blind", () => {
    assert.equal(isBlind(ctx({ id: "vl", image: true }, [])), false);
  });

  it("a text-only model with no vision model set up is blind at once, without asking any server", () => {
    assert.equal(isBlind(ctx({ id: "1bit", image: false }, [])), true);
  });

  it("a text-only model whose only vision model is down is blind once checked", async () => {
    const c = ctx({ id: "1bit-down", image: false }, [{ id: "eyes", baseUrl: "http://127.0.0.1:9/v1" }]);
    const verdict = await checkEyes(c);
    assert.equal(verdict.blind, true);
    assert.match(verdict.reason, /not reachable/);
    assert.equal(isBlind(c), true);
  });

  it("a text-only model with a vision model that answers is not blind", async () => {
    const c = ctx({ id: "1bit-relay", image: false }, [{ id: "eyes", baseUrl: "http://localhost:0" }]);
    assert.equal((await checkEyes(c)).blind, false);
  });
});

describe("blind prompts never ask for screenshots", () => {
  const asks = /screenshot(?!s? (?:are|is|do) not|s? proves? nothing|s? do not count)/i;

  it("the scenarios procedure asks for readable proof instead", () => {
    const seeing = buildScenariosProcedure({ includeWeb: true, includeFlutter: true });
    const blind = buildScenariosProcedure({ includeWeb: true, includeFlutter: true, blind: true });
    assert.match(seeing, /Save a screenshot/);
    assert.doesNotMatch(blind, /Save a screenshot|look at each screenshot|before\/after screenshots|browser_screenshot/);
    assert.match(blind, /boundingBox\(\)/);
    assert.match(blind, /You cannot see images/);
  });

  it("the browser lane drops browser_screenshot", () => {
    assert.match(buildBrowserProcedure(true), /browser_screenshot/);
    assert.doesNotMatch(buildBrowserProcedure(true, true), /browser_screenshot/);
  });

  it("a layout spec is not told to add screenshots; measured proof passes", () => {
    const canvasOnly = `// layout overlap test
test("layout", async ({ page }) => { await page.goto("/"); const canvas = page.locator("canvas"); await expect(canvas).toBeVisible(); });`;
    const seeing = scanSpecFileContent("a.spec.ts", canvasOnly, {});
    const blind = scanSpecFileContent("a.spec.ts", canvasOnly, { blind: true });
    assert.match(seeing.map((w) => w.message).join(" "), /screenshots/, "seeing models are asked for screenshots");
    assert.ok(blind.some((w) => w.blocking), "still blocked when blind");
    for (const w of blind) assert.doesNotMatch(w.message, asks, w.message);
    const measured = canvasOnly.replace("toBeVisible(); });", "toBeVisible(); const b = await canvas.boundingBox(); expect(b!.width).toBeGreaterThan(0); });");
    assert.deepEqual(scanSpecFileContent("a.spec.ts", measured, { blind: true }).filter((w) => w.blocking), []);
  });
});
