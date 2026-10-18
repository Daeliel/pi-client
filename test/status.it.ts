import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import statusExt from "../extensions/status/index";
import planExt from "../extensions/plan/index";
import { call, createHarness, reply, seenBy } from "./harness";

function widgetLog(log: Array<string | undefined>) {
  return { setWidget: ((key: string, lines: string[] | undefined) => void (key === "pi-client-status" && log.push(lines?.[0]))) as never };
}

describe("status line", () => {
  it("step from the model, phase from what it does, ~percent its estimate; gone when done", async () => {
    const log: Array<string | undefined> = [];
    const h = await createHarness({ extensions: [statusExt], ui: widgetLog(log) });
    try {
      let system = "";
      h.faux.setResponses([
        (context) => {
          system = seenBy(context).systemPrompt;
          return call("status", { step: "Implementing colour change", percent: 50 });
        },
        call("write", { path: "a.css", content: "a{}" }),
        call("write", { path: "b.css", content: "b{}" }),
        reply("done"),
      ]);
      await h.session.prompt("make it blue");
      await h.settle();
      assert.match(system, /## Status line/);
      assert.ok(log.includes("thinking"));
      assert.ok(log.includes("Implementing colour change · thinking · ~50%"));
      assert.ok(log.includes("Implementing colour change · editing (2 files) · ~50%"), log.join(" | "));
      assert.equal(log.at(-1), undefined, "cleared once everything settled");
    } finally {
      h.dispose();
    }
  });

  it("a model that never calls status is reminded in a tool result, then the line has step and percent", async () => {
    const log: Array<string | undefined> = [];
    const h = await createHarness({ extensions: [statusExt], ui: widgetLog(log) });
    try {
      const results: string[] = [];
      const lastResult = (context: Parameters<typeof seenBy>[0]) => {
        const last = (context as { messages: Array<{ role: string; content: unknown }> }).messages.at(-1);
        results.push(JSON.stringify(last?.content));
      };
      h.faux.setResponses([
        call("write", { path: "a.css", content: "a{}" }),
        (context) => {
          lastResult(context);
          return call("write", { path: "b.css", content: "b{}" });
        },
        (context) => {
          lastResult(context);
          return call("status", { step: "Recolouring buttons", percent: 60 });
        },
        reply("done"),
      ]);
      await h.session.prompt("make it blue");
      await h.settle();
      assert.doesNotMatch(results[0]!, /\[status line\]/, "not after the first call");
      assert.match(results[1]!, /\[status line\][^"]*Call status with your current step/);
      assert.ok(log.includes("Recolouring buttons · editing (2 files) · ~60%"), log.join(" | "));
    } finally {
      h.dispose();
    }
  });

  it("a model that ignores the reminder gets it twice, then no more", async () => {
    const h = await createHarness({ extensions: [statusExt], files: { "a.txt": "a" }, ui: widgetLog([]) });
    try {
      // 25 tool calls, never a status update: reminders at call 2 and call 12, then they stop.
      h.faux.setResponses([...Array.from({ length: 25 }, (_, i) => call("write", { path: `f${i}.txt`, content: "x" })), reply("done")]);
      await h.session.prompt("build lots");
      const nudges = h.session.messages.filter((m) => m.role === "toolResult" && JSON.stringify(m.content).includes("[status line]"));
      assert.equal(nudges.length, 2);
    } finally {
      h.dispose();
    }
  });

  it("with a plan item being built, the percentage is the plan's (no ~)", async () => {
    const log: Array<string | undefined> = [];
    const h = await createHarness({ extensions: [statusExt, planExt], ui: widgetLog(log) });
    try {
      fs.mkdirSync(path.join(h.cwd, ".pi/blueprint"), { recursive: true });
      fs.writeFileSync(
        path.join(h.cwd, ".pi/blueprint/BLUEPRINT.md"),
        "# Blueprint: app\n\nGoal: x\n\n## v1\n- [x] **R-01** one · proves: verify\n- [ ] **R-02** two · proves: verify\n- [ ] **R-03** three · proves: verify\n- [ ] **R-04** four · proves: verify\n",
      );
      h.faux.setResponses([
        call("plan_item", { id: "R-02" }),
        call("status", { step: "Building R-02", percent: 90 }),
        reply("done"),
      ]);
      await h.session.prompt("build R-02");
      assert.ok(log.includes("Building R-02 · reading the plan · 25%"), log.join(" | "));
    } finally {
      h.dispose();
    }
  });

  it("/status off hides the line and the tool, and is remembered", async () => {
    const log: Array<string | undefined> = [];
    const h = await createHarness({ extensions: [statusExt], ui: widgetLog(log) });
    try {
      await h.session.prompt("/status off");
      let tools: string[] = [];
      h.faux.setResponses([
        (context) => {
          tools = seenBy(context).tools;
          return reply("hi");
        },
      ]);
      await h.session.prompt("hello");
      assert.ok(!tools.includes("status"));
      assert.ok(log.every((l) => l === undefined));
      const saved = JSON.parse(fs.readFileSync(path.join(h.home, ".pi/status.config.json"), "utf8"));
      assert.equal(saved.enabled, false);
    } finally {
      h.dispose();
    }
  });
});
