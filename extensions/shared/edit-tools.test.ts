import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { extractEditPath, normalizeToolPath } from "./edit-tools.ts";

describe("edit paths", () => {
  it("a Git-Bash path on Windows means the drive: /c/Users/x is C:\\Users\\x", { skip: !fs.existsSync("C:\\") }, () => {
    assert.equal(normalizeToolPath("/c/Users/x.py", "win32"), "C:\\Users\\x.py");
    assert.equal(normalizeToolPath("/c", "win32"), "C:\\");
    assert.equal(extractEditPath({ path: "/c/.pi/a.py" }), process.platform === "win32" ? "C:\\.pi\\a.py" : "/c/.pi/a.py");
  });

  it("everything else is left alone", () => {
    assert.equal(normalizeToolPath("/tmp/x.py", "win32"), "/tmp/x.py", "not a drive letter");
    assert.equal(normalizeToolPath("/c/x.py", "linux"), "/c/x.py", "only on Windows");
    assert.equal(normalizeToolPath("src/a.ts", "win32"), "src/a.ts");
    assert.equal(normalizeToolPath("D:\\a.ts", "win32"), "D:\\a.ts");
  });
});
