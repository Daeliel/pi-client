import { describe, it } from "node:test";
import assert from "node:assert/strict";
import browser from "../extensions/browser-console/index";
import expand from "../extensions/expand/index";
import polish from "../extensions/polish/index";
import release from "../extensions/release/index";
import research from "../extensions/research/index";
import scenarios from "../extensions/scenarios/index";
import verify from "../extensions/verify/index";
import { createHarness, reply, writeProjectConfig } from "./harness";

const ALL = [verify, scenarios, browser, research, release, polish, expand];

async function toolsFor(prompt: string, files: Record<string, string>, configs: Record<string, unknown> = {}) {
  const h = await createHarness({ extensions: ALL, files });
  try {
    writeProjectConfig(h.cwd, "browser-console.config.json", { autoConnect: false, autoLaunchBrowser: false });
    for (const [name, value] of Object.entries(configs)) writeProjectConfig(h.cwd, name, value);
    let names: string[] = [];
    let system = "";
    h.faux.setResponses([
      (context) => {
        names = (context.tools ?? []).map((t) => t.name);
        system = context.systemPrompt ?? "";
        return reply("ok");
      },
    ]);
    await h.session.prompt(prompt);
    return { names, system };
  } finally {
    h.dispose();
  }
}

describe("tool activation", () => {
  it("a Python CLI project gets no browser, release, polish, expand or web_search tools", async () => {
    const { names, system } = await toolsFor("fix the crash in the date parser", {
      "pyproject.toml": "[project]\nname='x'\n",
      "cli.py": "print(1)",
    });
    for (const absent of ["browser_errors", "release_build", "polish_report", "expand_map", "web_search", "list_scenarios"]) {
      assert.ok(!names.includes(absent), `${absent} should be inactive: ${names.join(", ")}`);
    }
    for (const present of ["verify", "define_scenarios", "run_scenarios", "fetch_web_page"]) {
      assert.ok(names.includes(present), `${present} should be active`);
    }
    assert.doesNotMatch(system, /web_search/, "no research lane without a key");
  });

  it("a web UI project gets the browser lane and polish for UI work", async () => {
    const { names } = await toolsFor("build a settings page", {
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      "index.html": "<html></html>",
    });
    for (const present of ["browser_errors", "capture_page_screenshot", "polish_report"]) {
      assert.ok(names.includes(present), `${present} should be active: ${names.join(", ")}`);
    }
    assert.ok(!names.includes("browser_connect"), "connection management stays on /browser");
  });

  it("a Flutter Android project gets the release tools", async () => {
    const { names } = await toolsFor("build an apk", {
      "pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
      "android/build.gradle": "",
    });
    assert.ok(names.includes("release_build"), names.join(", "));
  });

  it("web_search is offered once a Brave key is configured", async () => {
    const { names, system } = await toolsFor("how do I use the fetch API", { "a.py": "" }, {
      "research.config.json": { apiKey: "test-key" },
    });
    assert.ok(names.includes("web_search"));
    assert.match(system, /Lane C/);
  });
});
