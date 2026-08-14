import { test } from "node:test";
import assert from "node:assert/strict";

import { teamTier, requiredTier, withinReach, TIER_ORDER } from "./advancement-gating.js";

// THE BUG THIS FILE EXISTS FOR.
//
// assignFor ranks the frontier purely by how many advancements each one
// unlocks. On the swarm's real state that put
//
//   adventure/minecraft_trials_edition (6 descendants)
//
// above story/lava_bucket (5), so Atlas and Blade were both sent to walk into a
// Trial Chamber -- an ominous-trial spawner dungeon -- while holding iron tools,
// no shield, and 13 of 122 advancements. Descendant count measures VALUE. It
// says nothing about whether the team can survive collecting it.
//
// The tier gate is deliberately coarse. A full difficulty model for 122
// advancements would be guesswork; a short list of the ones that demonstrably
// kill an under-geared bot is not.

test("a team with nothing is at the lowest tier", () => {
  assert.equal(teamTier(new Set()), "none");
});

test("iron tools and armour put the team at iron", () => {
  assert.equal(teamTier(new Set(["story/iron_tools", "story/obtain_armor"])), "iron");
});

test("diamond gear is recognised as its own tier", () => {
  const earned = new Set(["story/iron_tools", "story/obtain_armor", "story/shiny_gear"]);
  assert.equal(teamTier(earned), "diamond");
});

test("mining a diamond is not the same as wearing diamond", () => {
  // story/mine_diamond means one diamond was picked up. Atlas has it. That is
  // not armour, and it must not unlock the dangerous list.
  assert.equal(teamTier(new Set(["story/iron_tools", "story/mine_diamond"])), "iron");
});

test("the trial chamber demands more than the swarm currently has", () => {
  assert.equal(requiredTier("adventure/minecraft_trials_edition"), "diamond");
});

test("ordinary advancements require nothing in particular", () => {
  assert.equal(requiredTier("story/lava_bucket"), "none");
  assert.equal(requiredTier("husbandry/breed_an_animal"), "none");
});

test("an iron-tier team cannot reach a diamond-tier advancement", () => {
  const earned = new Set(["story/iron_tools", "story/obtain_armor"]);
  assert.equal(withinReach("adventure/minecraft_trials_edition", earned), false);
  assert.equal(withinReach("story/lava_bucket", earned), true);
});

test("a diamond-tier team can reach everything the gate covers", () => {
  const earned = new Set(["story/iron_tools", "story/obtain_armor", "story/shiny_gear"]);
  assert.equal(withinReach("adventure/minecraft_trials_edition", earned), true);
});

test("the tier order is strictly increasing so comparisons are safe", () => {
  assert.deepEqual(TIER_ORDER, ["none", "iron", "diamond"]);
});

test("the gate never blocks the story spine, which is how the team escapes its tier", () => {
  // A gate that blocked the route to better gear would deadlock the swarm at
  // whatever tier it happened to be on.
  const earned = new Set<string>();
  for (const id of [
    "story/lava_bucket",
    "story/form_obsidian",
    "story/enter_the_nether",
    "story/smelt_iron",
    "story/iron_tools",
    "story/shiny_gear",
    "story/mine_diamond",
  ]) {
    assert.equal(withinReach(id, earned), true, `${id} must never be gated`);
  }
});
