import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderScaffoldContent } from "./scaffold-content.ts";

describe("scaffold_scenario", () => {
  it("renders symptom-repro with screen and helpers", () => {
    const web = renderScaffoldContent({
      template: "symptom-repro",
      id: "hist-empty",
      title: "History empty",
      steps: "Open History\nSee items",
      screenName: "History",
    });
    assert.match(web, /History/);
    assert.match(web, /attachConsoleCapture/);
    assert.match(web, /screenshotStep/);
  });

  it("renders visual-before-after", () => {
    const text = renderScaffoldContent({
      template: "visual-before-after",
      id: "size-stable",
      title: "Size stable",
      steps: "Toggle start",
      screenName: "Home",
    });
    assert.match(text, /before\.jpeg/);
    assert.match(text, /after\.jpeg/);
  });

  it("renders api pytest starter", () => {
    const api = renderScaffoldContent({
      template: "api",
      id: "health",
      title: "Health",
      steps: "GET /health",
    });
    assert.match(api, /httpx/);
    assert.match(api, /test_health/);
  });
});
