import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSkipLanes, registerSkipHandler, requestSkip, skipAwareSignal, skipMark, skippedSince, skipNote } from "./gate-skip.ts";

describe("gate skip", () => {
  it("parses lanes: none = all, aliases, unknown words reported", () => {
    assert.deepEqual(parseSkipLanes("").lanes, ["verify", "browser", "qa", "scenarios"]);
    assert.deepEqual(parseSkipLanes("tests console").lanes, ["verify", "browser"]);
    assert.deepEqual(parseSkipLanes("scenarios bogus").unknown, ["bogus"]);
  });

  it("drops only lanes with something pending, in lane order, and marks them skipped", () => {
    const calls: string[] = [];
    registerSkipHandler("scenarios", () => (calls.push("scenarios"), "2 changed file(s)"));
    registerSkipHandler("qa", () => (calls.push("qa"), null));
    const mark = skipMark();
    const signal = skipAwareSignal("scenarios");
    const dropped = requestSkip(["scenarios", "qa"]);
    assert.deepEqual(calls, ["qa", "scenarios"], "qa is asked before scenarios clears the files");
    assert.deepEqual(dropped, [{ lane: "scenarios", what: "2 changed file(s)" }]);
    assert.ok(signal.aborted, "a running scenarios check is stopped");
    assert.ok(skippedSince(mark, "scenarios"));
    assert.ok(!skippedSince(mark, "verify"), "other lanes untouched");
    assert.ok(!skipAwareSignal("scenarios").aborted, "the next run gets a fresh signal");
    assert.match(skipNote(dropped), /acceptance scenarios \(2 changed file\(s\)\).*UNVERIFIED/);
  });
});
