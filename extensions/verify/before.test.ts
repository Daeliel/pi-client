import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BeforeStore } from "./before";
import { describeFailure, parseFailures } from "./failures";

const sigs = (out: string) => [...(parseFailures(out) ?? [])].map(describeFailure);

describe("failure signatures", () => {
  it("read each tool's output, without line numbers", () => {
    assert.deepEqual(sigs("FAILED tests/test_a.py::test_x - AssertionError: 1 != 2\nERROR tests/test_b.py - ImportError\n2 failed"), [
      "tests/test_a.py::test_x",
      "tests/test_b.py",
    ]);
    assert.deepEqual(sigs("src\\a.py:12:5: F401 [*] `os` imported but unused"), ["src/a.py F401 `os` imported but unused"]);
    assert.deepEqual(sigs("F401 [*] `os` imported but unused\n --> src/a.py:12:5\n  |"), ["src/a.py F401 `os` imported but unused"]);
    assert.deepEqual(sigs("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."), [
      "src/a.ts TS2322 Type 'string' is not assignable to type 'number'.",
    ]);
    assert.deepEqual(sigs("src/a.ts:3:7 - error TS2304: Cannot find name 'x'."), ["src/a.ts TS2304 Cannot find name 'x'."]);
    assert.deepEqual(sigs("C:\\p\\src\\a.js\n  4:1  error  'x' is not defined  no-undef\n  9:3  warning  unused  no-unused-vars"), [
      "C:/p/src/a.js no-undef 'x' is not defined",
    ]);
    assert.deepEqual(sigs("  1) [chromium] › tests/menu.spec.ts:12:5 › opens the menu ─────"), ["tests/menu.spec.ts opens the menu"]);
    assert.deepEqual(sigs("✖ adds numbers (1.2ms)\n✔ subtracts"), ["adds numbers"]);
    assert.deepEqual(sigs("  Failed App.Tests.Adds [12 ms]"), ["App.Tests.Adds"]);
    assert.equal(parseFailures("Segmentation fault"), null, "unknown output: no comparison");
  });

  it("a moved line is the same failure", () => {
    assert.deepEqual(parseFailures("a.py:3:1: E501 Line too long (120 > 88)"), parseFailures("a.py:40:1: E501 Line too long (120 > 88)"));
  });
});

describe("the project before the change", () => {
  function project(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-before-"));
    fs.writeFileSync(path.join(dir, "a.py"), "old\n");
    return dir;
  }
  const isCode = (abs: string) => abs.endsWith(".py");

  it("a check runs on the originals, and the model's files come back — also after a crash mid-swap", async () => {
    const dir = project();
    try {
      const store = new BeforeStore(dir);
      store.start();
      store.capture("a.py");
      store.capture("new.py");
      fs.writeFileSync(path.join(dir, "a.py"), "model\n");
      fs.writeFileSync(path.join(dir, "new.py"), "model\n");
      const world = store.world(isCode)!;
      assert.equal(world.trusted, true);
      assert.equal(world.existedBefore(path.join(dir, "new.py")), false);

      let seen: [string, boolean] = ["", true];
      await world.run(async () => {
        seen = [fs.readFileSync(path.join(dir, "a.py"), "utf8"), fs.existsSync(path.join(dir, "new.py"))];
      });
      assert.deepEqual(seen, ["old\n", false], "inside: the project as it was");
      assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "model\n");
      assert.equal(fs.readFileSync(path.join(dir, "new.py"), "utf8"), "model\n");

      // Pi killed during the check: the files are the originals and the note is on disk.
      const keep = path.join(dir, "keep");
      await world.run(async () => {
        fs.cpSync(path.join(dir, ".pi/verify"), keep, { recursive: true });
      });
      fs.cpSync(keep, path.join(dir, ".pi/verify"), { recursive: true });
      fs.writeFileSync(path.join(dir, "a.py"), "old\n");
      fs.rmSync(path.join(dir, "new.py"));
      assert.equal(new BeforeStore(dir).recover(), true, "the next start finds the note");
      assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "model\n");
      assert.equal(fs.readFileSync(path.join(dir, "new.py"), "utf8"), "model\n");
      assert.equal(new BeforeStore(dir).recover(), false, "once");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a file changed outside the edit tools: known from git when it was clean, otherwise no comparison", () => {
    const dir = project();
    try {
      fs.writeFileSync(path.join(dir, "b.py"), "b\n");
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, stdio: "ignore" });
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "start");
      fs.writeFileSync(path.join(dir, "b.py"), "user's own unsaved work\n"); // changed before the task began

      const store = new BeforeStore(dir);
      store.start();
      const later = Date.now() + 2000;
      fs.writeFileSync(path.join(dir, "a.py"), "bash\n");
      fs.utimesSync(path.join(dir, "a.py"), later / 1000, later / 1000);
      let world = store.world(isCode)!;
      assert.deepEqual(world.foundChanged.map((f) => path.basename(f)), ["a.py"]);
      assert.equal(world.trusted, true, "a.py was clean: its original is HEAD's");

      fs.writeFileSync(path.join(dir, "b.py"), "bash again\n");
      fs.utimesSync(path.join(dir, "b.py"), later / 1000, later / 1000);
      world = store.world(isCode)!;
      assert.equal(world.trusted, false, "b.py was already changed: its original is unknown");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
