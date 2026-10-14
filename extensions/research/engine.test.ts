import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "./engine";

describe("htmlToText", () => {
  it("keeps the main content and drops navigation", () => {
    const html = `<html><body><nav>Home Docs Blog Pricing</nav>
      <main><h1>useEffect</h1><p>Runs after render.</p><ul><li>deps array</li><li>cleanup</li></ul></main>
      <footer>© 2026 Example</footer></body></html>`;
    const text = htmlToText(html, 1000);
    assert.match(text, /^# useEffect/m);
    assert.match(text, /^- deps array$/m);
    assert.doesNotMatch(text, /Pricing|© 2026/);
  });

  it("decodes entities and respects the limit", () => {
    assert.equal(htmlToText("<p>a &amp; b &lt;c&gt;</p>", 100), "a & b <c>");
    assert.equal(htmlToText(`<p>${"x".repeat(50)}</p>`, 10), `${"x".repeat(10)}…`);
  });
});
