import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectStacks, shouldInjectWebProcedure, isWebPath } from "./stack-detect.ts";

function makeTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-stack-"));
}

describe("stack-detect", () => {
  let root: string;

  before(() => {
    root = makeTemp();
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("detects node + vite-style web", () => {
    const dir = path.join(root, "node-app");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "vite.config.ts"), "export default {}", "utf8");
    const d = detectStacks(dir);
    assert.ok(d.stacks.includes("node"));
    assert.equal(d.hasWebUi, true);
    assert.ok(d.playwright?.command.includes("npm run dev"));
  });

  it("detects flutter", () => {
    const dir = path.join(root, "flutter-app");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "pubspec.yaml"),
      "name: demo\nenvironment:\n  sdk: flutter\nflutter:\n  uses-material-design: true\n",
      "utf8",
    );
    const d = detectStacks(dir);
    assert.ok(d.stacks.includes("flutter"));
    assert.equal(d.primary, "flutter");
    assert.equal(d.hasWebUi, true);
    assert.ok(d.playwright?.note.toLowerCase().includes("flutter"));
  });

  it("detects python and csharp", () => {
    const py = path.join(root, "py-app");
    fs.mkdirSync(py);
    fs.writeFileSync(path.join(py, "requirements.txt"), "pytest\n", "utf8");
    assert.ok(detectStacks(py).stacks.includes("python"));

    const cs = path.join(root, "cs-app");
    fs.mkdirSync(cs);
    fs.writeFileSync(path.join(cs, "App.csproj"), "<Project></Project>", "utf8");
    assert.ok(detectStacks(cs).stacks.includes("dotnet"));
  });

  it("detects static html", () => {
    const dir = path.join(root, "static");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "index.html"), "<html></html>", "utf8");
    const d = detectStacks(dir);
    assert.ok(d.stacks.includes("static-web"));
    assert.equal(d.hasWebUi, true);
  });

  it("unknown when empty", () => {
    const dir = path.join(root, "empty");
    fs.mkdirSync(dir);
    const d = detectStacks(dir);
    assert.ok(d.stacks.includes("unknown"));
  });

  it("isWebPath and shouldInjectWebProcedure", () => {
    assert.equal(isWebPath("src/App.tsx"), true);
    assert.equal(isWebPath("lib/main.dart"), true);
    assert.equal(isWebPath("main.py"), false);
    const dir = path.join(root, "empty2");
    fs.mkdirSync(dir);
    assert.equal(shouldInjectWebProcedure(dir, ["src/app.css"]), true);
    assert.equal(shouldInjectWebProcedure(dir, ["main.py"]), false);
  });
});
