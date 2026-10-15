import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSpecFromRecording, validateActions, type PlayAction } from "./play.ts";

describe("play mode", () => {
  it("validates actions with a reason the model can act on", () => {
    assert.equal(validateActions([{ do: "click", x: 10, y: 20 }, { do: "press", key: "ArrowLeft" }, { do: "hold", key: "Space", ms: 400 }]), null);
    assert.equal(validateActions([{ do: "click", text: "Start" }]), null);
    assert.match(validateActions([]) ?? "", /at least one/);
    assert.match(validateActions([{ do: "click" } as PlayAction]) ?? "", /needs x and y, a selector, or text/);
    assert.match(validateActions([{ do: "press", key: "rm -rf /;" }]) ?? "", /key like/);
    assert.match(validateActions([{ do: "wait", ms: 60_000 }]) ?? "", /between 1 and 10000/);
    assert.match(validateActions(Array.from({ length: 13 }, () => ({ do: "wait", ms: 1 }) as PlayAction)) ?? "", /at most 12/);
    assert.match(validateActions([{ do: "dance" } as unknown as PlayAction]) ?? "", /unknown/);
  });

  it("turns the recorded path into a spec that replays it and leaves the assertions to write", () => {
    const spec = buildSpecFromRecording({
      name: "travel-stage",
      title: "reach the travel stage",
      startUrl: "/",
      steps: [
        { actions: [{ do: "click", x: 480, y: 320 }, { do: "press", key: "E" }], settleMs: 300 },
        { actions: [{ do: "drag", x: 1, y: 2, toX: 3, toY: 4 }, { do: "type", text: 'say "hi"' }, { do: "click", text: "Travel", double: true }], settleMs: 500 },
      ],
      hasConsoleHelper: true,
    });
    assert.match(spec, /^\/\/ @covers: TODO/);
    assert.match(spec, /import \{ attachConsoleCapture \} from "\.\/helpers\/console-capture";/);
    assert.match(spec, /test\("reach the travel stage"/);
    assert.match(spec, /\/\/ step 1\n {2}await page\.mouse\.click\(480, 320\);\n {2}await page\.keyboard\.press\("E"\);\n {2}await page\.waitForTimeout\(300\);/);
    assert.match(spec, /await page\.mouse\.down\(\);/);
    assert.match(spec, /await page\.keyboard\.type\("say \\"hi\\"", \{ delay: 20 \}\);/, "text is escaped");
    assert.match(spec, /await page\.getByText\("Travel"\)\.first\(\)\.click\(\{ clickCount: 2 \}\);/);
    assert.match(spec, /page\.screenshot\(\{ path: "\.pi\/scenarios\/output\/travel-stage-end\.png" \}\)/);
    assert.match(spec, /TODO: assert/);
    assert.match(spec, /consoleCapture\.assertClean\(\);/);
  });
});
