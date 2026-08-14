// src/bot/advancement-routing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { assignFor } from "./advancement-routing.js";
import type { AdvancementNode } from "./advancement-tree.js";

// THE BUG THIS FILE EXISTS FOR (pre-emptively).
//
// The swarm is five specialists: Explorer/Miner, Farmer/Crafter, Miner/Smelter,
// Builder, Combat/Guard. The advancement tree is 44 adventure + 29 husbandry +
// 24 nether + 16 story + 9 end, and it does not care about job titles. Handing
// the same frontier to all five bots would have Flora the farmer chasing
// nether/obtain_blaze_rod while 29 husbandry advancements sat untouched.
//
// Routing keeps the specialists (which is what makes the stream watchable) and
// parallelises the tree across five agents instead of serialising it.

const node = (id: string): AdvancementNode => ({
  id,
  parent: null,
  title: id,
  description: "",
  category: id.split("/")[0],
});

test("the farmer gets husbandry work", () => {
  const f = [node("husbandry/breed_an_animal"), node("nether/obtain_blaze_rod")];
  assert.equal(assignFor("Farmer / Crafter", f)?.id, "husbandry/breed_an_animal");
});

test("the smelter gets the story spine and the nether", () => {
  const f = [node("husbandry/breed_an_animal"), node("story/lava_bucket")];
  assert.equal(assignFor("Miner / Smelter", f)?.id, "story/lava_bucket");
});

test("the guard gets combat adventure work", () => {
  const f = [node("adventure/kill_all_mobs"), node("husbandry/plant_seed")];
  assert.equal(assignFor("Combat / Guard", f)?.id, "adventure/kill_all_mobs");
});

test("a role falls back to any advancement rather than idling", () => {
  const f = [node("husbandry/breed_an_animal")];
  assert.ok(assignFor("Combat / Guard", f), "a guard with only farm work should still get a goal");
});

test("an empty frontier yields null, not a crash", () => {
  assert.equal(assignFor("Builder", []), null);
});

test("every role in the roster resolves to something on a mixed frontier", () => {
  const f = [
    node("story/lava_bucket"), node("husbandry/breed_an_animal"),
    node("adventure/kill_all_mobs"), node("nether/root"), node("adventure/adventuring_time"),
  ];
  for (const role of ["Explorer / Miner", "Farmer / Crafter", "Miner / Smelter", "Builder", "Combat / Guard"]) {
    assert.ok(assignFor(role, f), `${role} got no assignment`);
  }
});

test("the gateway beats the dead end even when the dead end sorts first", () => {
  // enchant_item unlocks 0 further advancements; lava_bucket unlocks 5 and is
  // the only route to the nether. Sorted by id, the dead end wins -- which is
  // exactly the bug this ordering exists to prevent.
  const f = [node("story/enchant_item"), node("story/lava_bucket")];
  assert.equal(assignFor("Miner / Smelter", f)?.id, "story/lava_bucket");
});

test("a parent outranks its own child so the chain is walked in order", () => {
  const f = [node("story/form_obsidian"), node("story/lava_bucket")];
  assert.equal(assignFor("Miner / Smelter", f)?.id, "story/lava_bucket");
});
