import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import expandExt from "../extensions/expand/index";
import onceExt from "../extensions/once/index";
import polishExt from "../extensions/polish/index";
import { call, createHarness, reply, writeProjectConfig } from "./harness";

function writeLedger(cwd: string) {
  const now = Date.now();
  const ledger = {
    version: 1,
    map: null,
    pillars: [],
    ideas: [
      {
        n: 1,
        title: "Ranged weapons",
        axis: "more",
        buildsOn: ["weapons pool"],
        gap: "12 weapons, 0 ranged",
        size: "S",
        fit: "high",
        fitNote: "adds tactical choice",
        playerFacing: "shop tab",
        status: "proposed",
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  const file = path.join(cwd, ".pi/expand/ledger.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ledger));
}

const ideaStatus = (cwd: string) =>
  JSON.parse(fs.readFileSync(path.join(cwd, ".pi/expand/ledger.json"), "utf8")).ideas[0].status as string;

describe("expand build → fit check", () => {
  it("builds the picked idea, runs one fit check, then marks it done", async () => {
    const h = await createHarness({ extensions: [expandExt] });
    try {
      writeLedger(h.cwd);
      const tools: string[][] = [];
      const track = (step: ReturnType<typeof call>) => (context: { tools?: { name: string }[] }) => {
        tools.push((context.tools ?? []).map((t) => t.name));
        return step;
      };
      h.faux.setResponses([
        track(call("write", { path: "weapons.js", content: "export const bow = {};" })),
        track(reply("built the bow")),
        track(call("expand_fit", { idea: 1, findings: ["reachable — not in the shop — add it to the shop list"] })),
        track(call("write", { path: "shop.js", content: "import { bow } from './weapons.js';" })),
        track(reply("fixed")),
        reply("unused"),
      ]);
      await h.session.prompt("/expand build 1");
      await h.settle();
      const users = h.userMessages();
      assert.equal(users.filter((m) => m.startsWith("Fit check 1/1")).length, 1, users.map((u) => u.slice(0, 40)).join(" | "));
      assert.equal(ideaStatus(h.cwd), "done");
      assert.ok(tools.every((t) => t.includes("expand_fit")), "expand tools active during the build task");
      assert.equal(h.faux.getPendingResponseCount(), 1);

      // A plain prompt afterwards ends the expand task: its tools go away.
      let after: string[] = [];
      h.faux.setResponses([(context) => ((after = (context.tools ?? []).map((t) => t.name)), reply("hi"))]);
      await h.session.prompt("what time is it");
      assert.ok(!after.includes("expand_fit"));
    } finally {
      h.dispose();
    }
  });
});

describe("/once", () => {
  it("applies a polish level to one prompt only", async () => {
    const h = await createHarness({
      extensions: [polishExt, onceExt],
      files: { "package.json": JSON.stringify({ scripts: { dev: "vite" } }), "index.html": "" },
    });
    try {
      writeProjectConfig(h.cwd, "polish.config.json", { level: "off", announceAuto: false });
      const systems: string[] = [];
      const grab = (step: ReturnType<typeof reply>) => (context: { systemPrompt?: string }) => {
        systems.push(context.systemPrompt ?? "");
        return step;
      };
      h.faux.setResponses([grab(reply("ok")), grab(reply("ok"))]);
      await h.session.prompt("/once showcase build a menu");
      await h.settle();
      await h.session.prompt("build a menu");
      assert.match(systems[0]!, /## Polish \(level: showcase\)/);
      assert.doesNotMatch(systems[1]!, /## Polish/, "next prompt is back to the configured level");
    } finally {
      h.dispose();
    }
  });
});
