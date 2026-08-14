import { test } from "node:test";
import assert from "node:assert/strict";

import { advancementLine } from "./advancement-line.js";
import { ALL_ADVANCEMENTS } from "./advancement-tree.js";

// THE BUG THIS FILE EXISTS FOR.
//
// getTechTreeLine's terminal branch returned "TECH TREE: complete through
// diamonds. You are endgame — focus on your role and the mission." Atlas earned
// story/mine_diamond, so that string was the swarm's stated purpose while it
// held 13 of 122 advancements and had never entered the nether.

const TEAM_2026_08_13 = new Set([
  "story/root", "story/mine_stone", "story/upgrade_tools", "story/smelt_iron",
  "story/iron_tools", "story/obtain_armor", "story/mine_diamond", "story/deflect_arrow",
  "adventure/root", "adventure/kill_a_mob", "adventure/sleep_in_bed",
  "husbandry/root", "husbandry/plant_seed",
]);

test("the line names a concrete next advancement", () => {
  const line = advancementLine("Miner / Smelter", TEAM_2026_08_13);
  assert.match(line, /Hot Stuff|lava_bucket/i, `expected the lava bucket step: ${line}`);
});

test("the line carries the description so the model knows what to DO", () => {
  const line = advancementLine("Miner / Smelter", TEAM_2026_08_13);
  assert.match(line, /Fill a Bucket with lava/i);
});

test("the line reports honest progress out of 122", () => {
  assert.match(advancementLine("Builder", TEAM_2026_08_13), /13\/122/);
});

test("no bot is ever told it is finished while advancements remain", () => {
  for (const role of ["Explorer / Miner", "Farmer / Crafter", "Miner / Smelter", "Builder", "Combat / Guard"]) {
    const line = advancementLine(role, TEAM_2026_08_13);
    assert.ok(line.length > 0, `${role} got an empty line`);
    assert.doesNotMatch(line, /endgame/i, `${role} was told it is endgame at 13/122`);
  }
});

test("a completed game yields an empty line rather than a fake goal", () => {
  const all = new Set(ALL_ADVANCEMENTS.map((a) => a.id));
  assert.equal(advancementLine("Builder", all), "");
});

test("the line stays short enough for a per-decision context", () => {
  assert.ok(advancementLine("Farmer / Crafter", TEAM_2026_08_13).length < 300);
});
