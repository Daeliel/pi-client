import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDuplicateGroups, groupKeyForId } from "./housekeeping.ts";
import type { ScenarioDefinition } from "./types.ts";

function spec(id: string, title = `Discovered: ${id}`): ScenarioDefinition {
  return { id, title, steps: "s", testFile: `.pi/scenarios/${id}.spec.ts`, kind: "web" };
}

function groupIds(specs: ScenarioDefinition[]): string[][] {
  return buildDuplicateGroups(specs, {}).groups.map((g) => g.members.map((m) => m.id));
}

describe("duplicate groups", () => {
  it("strips copy-style suffixes but keeps numbers", () => {
    assert.equal(groupKeyForId("login-v2"), "login");
    assert.equal(groupKeyForId("login-fixed-new"), "login");
    assert.equal(groupKeyForId("level-2"), "level-2");
    assert.equal(groupKeyForId("new"), "new");
  });

  it("does not group specs that only share a first word", () => {
    assert.deepEqual(groupIds([spec("room-type-cycling"), spec("room-layout"), spec("room-delete")]), []);
    assert.deepEqual(groupIds([spec("level-1"), spec("level-2")]), []);
  });

  it("groups rewritten copies and specs with the same test title", () => {
    const groups = groupIds([
      spec("login"),
      spec("login-v2"),
      spec("room-type-cycling", "Q and E cycle the current room"),
      spec("type-cycle", "Q and E cycle the current room"),
      spec("save-load"),
    ]);
    assert.deepEqual(groups, [["login", "login-v2"], ["room-type-cycling", "type-cycle"]]);
  });

  it("names a group by its alphabetically first key", () => {
    const { groups } = buildDuplicateGroups([spec("type-cycle", "Cycle"), spec("room-type-cycling", "Cycle")], {});
    assert.equal(groups[0]?.key, "room-type-cycling");
  });
});
