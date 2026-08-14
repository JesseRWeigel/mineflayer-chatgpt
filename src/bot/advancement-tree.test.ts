// src/bot/advancement-tree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_ADVANCEMENTS,
  TOTAL_ADVANCEMENTS,
  getAdvancement,
  frontierOf,
  descendantCount,
} from "./advancement-tree.js";

// THE BUG THIS FILE EXISTS FOR.
//
// curriculum.ts drove goal-setting from a hand-written 8-rung ladder ending at
// "diamonds". Once a bot passed it, getTechTreeLine returned:
//
//   "TECH TREE: complete through diamonds. You are endgame — focus on your role"
//
// Measured 2026-08-13 from server/ai-world/advancements: the team had 13 of the
// game's 122 advancements (10%), 0 of 24 nether and 0 of 9 end, and Atlas had
// already earned story/mine_diamond. The curriculum was telling the swarm it had
// finished the game at 10% completion. Skill-menu rotation and an honest success
// metric cannot help a team that has been told there is nothing left to want.

test("the tree has every advancement and no recipe unlocks", () => {
  assert.equal(TOTAL_ADVANCEMENTS, 122);
  assert.equal(ALL_ADVANCEMENTS.length, 122);
  assert.ok(!ALL_ADVANCEMENTS.some((a) => a.id.startsWith("recipes/")));
});

test("ids are bare, not namespaced", () => {
  assert.ok(!ALL_ADVANCEMENTS.some((a) => a.id.includes("minecraft:")));
});

test("the five roots have no parent and everything else does", () => {
  const roots = ALL_ADVANCEMENTS.filter((a) => a.parent === null);
  assert.equal(roots.length, 5);
  assert.deepEqual(
    roots.map((r) => r.id).sort(),
    ["adventure/root", "end/root", "husbandry/root", "nether/root", "story/root"],
  );
});

test("every non-root parent resolves to a real node", () => {
  for (const a of ALL_ADVANCEMENTS) {
    if (a.parent === null) continue;
    assert.ok(getAdvancement(a.parent), `${a.id} has dangling parent ${a.parent}`);
  }
});

test("a fresh world's frontier is the three OVERWORLD roots only", () => {
  const f = frontierOf(new Set());
  assert.deepEqual(f.map((a) => a.id).sort(), ["adventure/root", "husbandry/root", "story/root"]);
});

test("the dimension roots are gated behind actually going there", () => {
  // nether/root and end/root declare parent:null like the overworld roots, so a
  // naive frontier hands "go to the Nether" to a team that has never made a
  // bucket. They are unlocked by arriving, not by being reachable.
  assert.ok(!frontierOf(new Set()).some((a) => a.id === "nether/root"));
  assert.ok(!frontierOf(new Set()).some((a) => a.id === "end/root"));
  assert.ok(frontierOf(new Set(["story/enter_the_nether"])).some((a) => a.id === "nether/root"));
});

test("descendantCount measures how much an advancement unlocks", () => {
  // The numbers that make lava_bucket beat enchant_item.
  assert.equal(descendantCount("story/enchant_item"), 0);
  assert.equal(descendantCount("story/lava_bucket"), 5);
  assert.equal(descendantCount("adventure/root"), 43);
});

test("earning a parent unlocks its children", () => {
  const f = frontierOf(new Set(["story/root"]));
  assert.ok(f.some((a) => a.id === "story/mine_stone"), "mine_stone should unlock after story/root");
  assert.ok(!f.some((a) => a.id === "story/root"), "an earned advancement is not on the frontier");
});

test("the nether is gated behind form_obsidian, not directly available", () => {
  const earned = new Set(["story/root", "story/mine_stone", "story/smelt_iron"]);
  assert.ok(!frontierOf(earned).some((a) => a.id === "story/enter_the_nether"));
  earned.add("story/lava_bucket");
  earned.add("story/form_obsidian");
  assert.ok(frontierOf(earned).some((a) => a.id === "story/enter_the_nether"));
});

test("the real team state produces a non-empty frontier", () => {
  // The 13 advancements the swarm actually held on 2026-08-13.
  const earned = new Set([
    "story/root", "story/mine_stone", "story/upgrade_tools", "story/smelt_iron",
    "story/iron_tools", "story/obtain_armor", "story/mine_diamond", "story/deflect_arrow",
    "adventure/root", "adventure/kill_a_mob", "adventure/sleep_in_bed",
    "husbandry/root", "husbandry/plant_seed",
  ]);
  const f = frontierOf(earned);
  assert.ok(f.length > 0);
  assert.ok(f.some((a) => a.id === "story/lava_bucket"), "lava_bucket is the real next step on the spine");
});
