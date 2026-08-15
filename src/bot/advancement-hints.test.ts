import { test } from "node:test";
import assert from "node:assert/strict";

import { hintFor } from "./advancement-hints.js";

// THE BUG THIS FILE EXISTS FOR.
//
// Measured live 2026-08-14, 3.5 hours after the nether skills shipped:
// craft_bucket had been invoked ZERO times. Forge had it in its skill menu,
// and its context said
//
//   NEXT FOR YOU: "Hot Stuff" (story/lava_bucket) — Fill a Bucket with lava.
//
// Nothing in that sentence says a bucket must be CRAFTED first, or names the
// skill that does it. Mojang's advancement description is written for a human
// who already knows the game. The model read it as an instruction to go find
// lava and had no route from the goal to the capability.
//
// This is the same shape as the wooden-pickaxe gap: the knowledge existed in
// the codebase and was never surfaced at the moment of the decision. Shipping a
// skill is not the same as making it reachable.

test("the lava bucket goal names the skill that crafts the bucket", () => {
  const h = hintFor("story/lava_bucket");
  assert.match(h, /craft_bucket/);
});

test("the obsidian goal points at the portal skill, not at bare mining", () => {
  assert.match(hintFor("story/form_obsidian"), /build_nether_portal|craft_bucket/);
});

test("entering the nether names the portal skill", () => {
  assert.match(hintFor("story/enter_the_nether"), /build_nether_portal/);
});

test("hints mention invoke_skill so the model knows the action to use", () => {
  // The action name matters: the model has to emit invoke_skill, not a bare verb.
  assert.match(hintFor("story/lava_bucket"), /invoke_skill/);
});

test("an advancement with no hint yields empty rather than noise", () => {
  assert.equal(hintFor("husbandry/breed_an_animal"), "");
  assert.equal(hintFor("adventure/ol_betsy"), "");
});

test("an unknown id is safe", () => {
  assert.equal(hintFor("not/a/real/advancement"), "");
});

test("hints stay short enough to sit in a per-decision context", () => {
  for (const id of ["story/lava_bucket", "story/form_obsidian", "story/enter_the_nether"]) {
    assert.ok(hintFor(id).length < 160, `${id} hint is too long: ${hintFor(id).length}`);
  }
});
