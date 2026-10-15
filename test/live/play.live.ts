// Live check of play mode against a real browser. Needs Playwright + browsers; not in npm test.
// Run: npx tsx --tsconfig test/tsconfig.json --test test/live/play.live.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import scenariosExt from "../../extensions/scenarios/index";
import { call, createHarness, reply } from "../harness";

const PAGE = `<!doctype html><html><head><title>start</title></head><body style="margin:0">
<canvas id="c" width="800" height="600" style="background:#123"></canvas>
<script>
const c = document.getElementById("c"), g = c.getContext("2d");
c.addEventListener("click", (e) => { g.fillStyle = "red"; g.fillRect(e.offsetX - 20, e.offsetY - 20, 40, 40); document.title = "clicked " + e.offsetX + "," + e.offsetY; });
addEventListener("keydown", (e) => { if (e.key === "e" || e.key === "E") document.title += " +E"; });
</script></body></html>`;

const SERVER = `require("http").createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(require("fs").readFileSync("index.html")); }).listen(4399);`;

const CONFIG = `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./scenarios",
  use: { baseURL: "http://localhost:4399", viewport: { width: 800, height: 600 } },
  webServer: { command: "node server.js", url: "http://localhost:4399", reuseExistingServer: true, cwd: ".." },
});
`;

describe("play (live)", () => {
  it("opens the app, clicks and presses keys with screenshots, saves the path as a spec", async () => {
    const h = await createHarness({
      extensions: [scenariosExt],
      ui: {},
      files: { "index.html": PAGE, "server.js": SERVER, ".pi/playwright.config.ts": CONFIG, "package.json": "{}" },
    });
    try {
      const globalPw = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@playwright");
      fs.mkdirSync(path.join(h.cwd, "node_modules"), { recursive: true });
      fs.symlinkSync(globalPw, path.join(h.cwd, "node_modules", "@playwright"), "junction");
      h.faux.setResponses([
        call("play", { url: "/" }),
        call("play", { actions: [{ do: "click", x: 100, y: 120 }, { do: "press", key: "E" }] }),
        call("play_save_spec", { name: "canvas click", title: "click the canvas and press E" }),
        reply("done"),
        reply("unused"),
      ]);
      await h.session.prompt("try the canvas");
      await h.settle();
      const t = JSON.stringify(h.session.messages);
      console.log(t.match(/Play session open[^"]*/)?.[0]);
      console.log(t.match(/Step 1\/40[^"]*/)?.[0]);
      assert.match(t, /Play session open at \//);
      assert.match(t, /Step 1\/40: done/);
      assert.match(t, /clicked 100,120 \+E/, "title shows the click and the key reached the page");
      assert.match(t, /Page is 800×600; screenshot pixels = page coordinates/);
      assert.doesNotMatch(t, /confirm_visual_qa/, "play screenshots are not QA reviews");
      const spec = fs.readFileSync(path.join(h.cwd, ".pi/scenarios/canvas-click.spec.ts"), "utf8");
      console.log(spec);
      assert.match(spec, /await page\.mouse\.click\(100, 120\);/);
      assert.match(spec, /await page\.keyboard\.press\("E"\);/);
      // The saved spec runs as a normal Playwright test.
      const out = execSync(`npx playwright test .pi/scenarios/canvas-click.spec.ts --config .pi/playwright.config.ts --reporter line`, { cwd: h.cwd, encoding: "utf8" });
      console.log(out.split("\n").slice(-4).join("\n"));
      assert.match(out, /1 passed/);
    } finally {
      h.dispose();
    }
  });
});
