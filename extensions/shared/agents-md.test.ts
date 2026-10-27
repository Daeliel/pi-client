import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureAgentsMd, isTopLevelFolder, renderAgentsMd } from "./agents-md";

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-md-"));
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
  return dir;
}

describe("AGENTS.md scaffold", () => {
  it("states detected facts and no example placeholders", () => {
    const dir = project({ "package.json": JSON.stringify({ scripts: { dev: "vite", test: "vitest run" } }), "index.html": "" });
    try {
      const text = renderAgentsMd(dir, "linux");
      assert.match(text, /Stack: node/);
      assert.match(text, /`npm run dev` → `vite`/);
      assert.match(text, /npm run dev.*localhost:5173/);
      assert.doesNotMatch(text, /e\.g\./, "no example text that a model could mistake for facts");
      assert.doesNotMatch(text, /Flutter|PowerShell/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mentions the PowerShell quirk only on Windows", () => {
    const dir = project({ "pyproject.toml": "" });
    try {
      assert.match(renderAgentsMd(dir, "win32"), /PowerShell/);
      assert.doesNotMatch(renderAgentsMd(dir, "linux"), /PowerShell/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overwrites an existing context file", () => {
    const dir = project({ "pyproject.toml": "", "AGENTS.md": "mine" });
    try {
      const result = ensureAgentsMd(dir);
      assert.equal(result.created, false);
      assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "mine");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("never writes into a drive root or the home folder: pi was started outside a project", () => {
    const root = path.parse(process.cwd()).root;
    assert.ok(isTopLevelFolder(root));
    assert.ok(isTopLevelFolder(os.homedir()));
    assert.ok(!isTopLevelFolder(process.cwd()));
    const r = ensureAgentsMd(root);
    assert.equal(r.created, false);
    assert.equal(r.topLevel, true);
  });
});
