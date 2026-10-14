import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJsonConfig, takeUnreportedConfigErrors } from "./json-config";

function tempFile(content: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "json-config-")), "x.config.json");
  fs.writeFileSync(file, content);
  return file;
}

describe("readJsonConfig", () => {
  it("reads files saved with a UTF-8 byte-order mark", () => {
    const file = tempFile('﻿{ "blocking": false }');
    assert.deepEqual(readJsonConfig<{ blocking: boolean }>(file), { blocking: false });
  });

  it("returns null for a missing file without reporting anything", () => {
    takeUnreportedConfigErrors();
    assert.equal(readJsonConfig(path.join(os.tmpdir(), "does-not-exist.config.json")), null);
    assert.deepEqual(takeUnreportedConfigErrors(), []);
  });

  it("reports a broken file once", () => {
    takeUnreportedConfigErrors();
    const file = tempFile('{ "blocking": false, }');
    assert.equal(readJsonConfig(file), null);
    assert.equal(readJsonConfig(file), null);
    const errors = takeUnreportedConfigErrors();
    assert.equal(errors.length, 1);
    assert.ok(errors[0]!.startsWith(file));
    assert.deepEqual(takeUnreportedConfigErrors(), [], "not repeated");
  });

  it("rejects JSON that is not an object", () => {
    assert.equal(readJsonConfig(tempFile("[1, 2]")), null);
    assert.match(takeUnreportedConfigErrors().join(), /expected a JSON object/);
  });
});
