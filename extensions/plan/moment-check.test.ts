import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "./config.ts";
import { markAsked, pendingMoments, readChecks, recordCheck, screenQuestions } from "./moment-check.ts";
import { parseExperience } from "./walkthrough.ts";

const BP = `Goal: g
Bar: product

## Walkthrough
### M-03 Chart the next leg
- Situation: the route map; reachable nodes lit
- Decision: which road — easy or hard
- Needs to see: which nodes are reachable; each node's risk; what is selected
- Does: click a reachable node
- Feedback: the node highlights
- Then: Travel moves the train there
- Turns off: room charging

## v1
- [x] **R-11** Select the next leg · serves: S-01 · moment: M-03 · proves: chart.spec.ts
- [x] **R-12** Show each node's risk · serves: S-02 · moment: M-03 · proves: chart.spec.ts
`;

function project(fn: (cwd: string) => void) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-moments-"));
  try {
    fs.mkdirSync(path.join(cwd, ".pi/blueprint"), { recursive: true });
    fs.writeFileSync(path.join(cwd, DEFAULT_CONFIG.blueprintPath), BP);
    fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe("moment checks", () => {
  it("screen questions say what to look for, never the answer", () => {
    const qs = screenQuestions(parseExperience(BP).moments[0]!).join("\n");
    assert.match(qs, /What is the person deciding/);
    assert.match(qs, /Can you see which nodes are reachable\?/);
    assert.match(qs, /Can you see each node's risk\?/);
    assert.match(qs, /Can you see what is selected\?/);
    assert.match(qs, /What do you expect to happen next/);
    assert.doesNotMatch(qs, /easy or hard|Travel moves the train|highlights/, "the planned answers stay out");
  });

  it("a complete moment is pending once; asked or done, it waits until its items change", () => {
    project((cwd) => {
      assert.deepEqual(pendingMoments(cwd, DEFAULT_CONFIG).map((m) => m.id), ["M-03"]);
      markAsked(cwd, DEFAULT_CONFIG, "M-03");
      assert.deepEqual(pendingMoments(cwd, DEFAULT_CONFIG), [], "not asked twice");
      recordCheck(cwd, DEFAULT_CONFIG, "M-03", 1, "answered");
      assert.equal(readChecks(cwd, DEFAULT_CONFIG)["M-03"]?.state, "done");

      // a finding became a new item of the moment: once it is built, the moment is checked again
      fs.appendFileSync(path.join(cwd, DEFAULT_CONFIG.blueprintPath), "- [ ] **R-31** Show what is selected · serves: added · moment: M-03 · proves: chart.spec.ts\n");
      assert.deepEqual(pendingMoments(cwd, DEFAULT_CONFIG), [], "not complete while R-31 is open");
      const text = fs.readFileSync(path.join(cwd, DEFAULT_CONFIG.blueprintPath), "utf8").replace("- [ ] **R-31**", "- [x] **R-31**");
      fs.writeFileSync(path.join(cwd, DEFAULT_CONFIG.blueprintPath), text);
      assert.deepEqual(pendingMoments(cwd, DEFAULT_CONFIG).map((m) => m.id), ["M-03"]);
    });
  });
});
