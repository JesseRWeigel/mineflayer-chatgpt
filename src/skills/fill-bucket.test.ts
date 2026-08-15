import { test } from "node:test";
import assert from "node:assert/strict";

import { bucketPlan } from "./fill-bucket.js";

// THE BUG THIS FILE EXISTS FOR.
//
// Third instance of the same pattern in three days.
//
// story/lava_bucket triggers on holding minecraft:lava_bucket. After the HOW
// hint shipped, Forge invoked craft_bucket 28 times and succeeded -- "Crafted a
// bucket." The chain then stopped dead, because fillBucket() existed only as a
// helper inside fluid.ts, reachable through obsidian.ts -> castInPlace ->
// build_nether_portal, which refuses to start without flint_and_steel.
//
// So the swarm could make a bucket and had no way to fill one. The capability
// was in the codebase and had no registered entry point.
//
// The earlier two: tool-tier knew wooden pickaxes cannot mine iron and only
// checked after the swing; craft_bucket sat in Forge's menu unused because
// nothing named it as the route to the goal.

test("no bucket at all means craft one first", () => {
  const p = bucketPlan(["iron_ingot", "stone_pickaxe"], "lava");
  assert.equal(p.ready, false);
  assert.match(p.message, /craft_bucket/);
});

test("an empty bucket is ready to fill", () => {
  assert.equal(bucketPlan(["bucket", "stone_pickaxe"], "lava").ready, true);
});

test("already holding the filled bucket is done, not repeated", () => {
  const p = bucketPlan(["lava_bucket"], "lava");
  assert.equal(p.ready, false);
  assert.equal(p.done, true);
  assert.match(p.message, /already/i);
});

test("a water bucket does not satisfy a lava request", () => {
  const p = bucketPlan(["water_bucket"], "lava");
  assert.equal(p.done, false);
  // A full bucket of the wrong fluid still needs emptying or another bucket.
  assert.equal(p.ready, false);
});

test("a spare empty bucket lets a full one coexist", () => {
  assert.equal(bucketPlan(["water_bucket", "bucket"], "lava").ready, true);
});

test("water is a legitimate target too", () => {
  assert.equal(bucketPlan(["bucket"], "water").ready, true);
  assert.equal(bucketPlan(["water_bucket"], "water").done, true);
});

test("the not-ready message never begins with a crash prefix", () => {
  // "<name> failed:" marks a thrown skill and always counts against it. A
  // precondition must not look like a crash, or the skill retires wrongly.
  for (const inv of [[], ["iron_ingot"], ["water_bucket"]]) {
    assert.doesNotMatch(bucketPlan(inv, "lava").message, /^\s*\S+ failed:/);
  }
});
