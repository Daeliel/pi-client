import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import polishExt from "../extensions/polish/index";
import { call, createHarness, reply, writeProjectConfig } from "./harness";

const WEB = { "package.json": JSON.stringify({ scripts: { dev: "vite" } }), "index.html": "<html></html>" };
const passPrompts = (msgs: string[]) => msgs.filter((m) => m.startsWith("Polish pass"));

function inventory(cwd: string) {
  return JSON.parse(fs.readFileSync(path.join(cwd, ".pi/polish/inventory.json"), "utf8")) as {
    surfaces: Array<{ name: string; status: string; passes: number; note?: string }>;
  };
}

describe("polish passes", () => {
  it("showcase runs every pass it promises, then marks the surface polished", async () => {
    const h = await createHarness({ extensions: [polishExt], files: WEB });
    try {
      writeProjectConfig(h.cwd, "polish.config.json", { level: "showcase", announceAuto: false });
      const weakness = [
        "primary button — flat grey — give it the accent colour and a hover lift",
        "heading typography — default serif — switch to a display font at 40px",
        "footer spacing — cramped — use the 24px spacing step",
      ];
      const pass = (n: number) => [
        call("polish_report", { surface: "App", weaknesses: [weakness[n - 1]!] }),
        call("write", { path: "style.css", content: `/* pass ${n} */` }),
        reply(`pass ${n} done`),
      ];
      h.faux.setResponses([
        call("write", { path: "index.html", content: "<button>Go</button>" }),
        reply("built"),
        ...pass(1),
        ...pass(2),
        ...pass(3),
        reply("unused"),
      ]);
      await h.session.prompt("build a landing page");
      assert.equal(passPrompts(h.userMessages()).length, 3);
      assert.equal(h.faux.getPendingResponseCount(), 1);
      const app = inventory(h.cwd).surfaces.find((s) => s.name === "App");
      assert.equal(app?.status, "polished");
    } finally {
      h.dispose();
    }
  });

  it("stops a surface when weaknesses are named but nothing is edited", async () => {
    const h = await createHarness({ extensions: [polishExt], files: WEB });
    try {
      writeProjectConfig(h.cwd, "polish.config.json", { level: "showcase", announceAuto: false });
      h.faux.setResponses([
        call("write", { path: "index.html", content: "<button>Go</button>" }),
        reply("built"),
        call("polish_report", { surface: "App", weaknesses: ["button — flat — give it depth"] }),
        reply("I would fix the button"),
        reply("unused"),
      ]);
      await h.session.prompt("build a landing page");
      assert.equal(passPrompts(h.userMessages()).length, 1, "no second pass after a pass with no edits");
      const app = inventory(h.cwd).surfaces.find((s) => s.name === "App");
      assert.equal(app?.status, "raw");
      assert.match(app?.note ?? "", /no edits/);
    } finally {
      h.dispose();
    }
  });
});
