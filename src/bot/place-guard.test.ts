import { test } from "node:test";
import assert from "node:assert/strict";

import { isFurniture, tooHighForFurniture, furnitureRefusal, FURNITURE_MAX_ABOVE_BASE } from "./place-guard.js";

// THE FIRST MECHANISTIC DATA IN THE FALL INVESTIGATION.
//
// After three rounds of fixing the fall instrument, two records finally named
// what the bot was standing on when it left the ground:
//
//   Mason fell 43.0 blocks from y=116
//   [stood ... at=278,123,-324 in=air on=chest          1154ms before leaving]
//   Mason fell 30.0 blocks from y=119
//   [stood ... at=281,119,-323 in=air on=crafting_table  199ms before leaving]
//
// Chests and crafting tables at y=119 and y=123 — about 50 blocks above the
// base at y=70. The same session placed 10 chests and 6 crafting tables and
// logged 36 ascents to y=121-126. The bots build furniture at altitude and
// then stand on it.
//
// This also explains a failure I had been treating as unrelated: deposits bounce
// with chest_unreachable, and a chest at y=123 is unreachable by construction.
// Storage 50 blocks above the stash is not storage.
test("furniture is refused far above the base", () => {
  const baseY = 70;
  assert.equal(tooHighForFurniture("chest", 123, baseY), true);
  assert.equal(tooHighForFurniture("crafting_table", 119, baseY), true);
  assert.equal(tooHighForFurniture("furnace", 116, baseY), true);
});

test("furniture at and around base height is fine", () => {
  const baseY = 70;
  assert.equal(tooHighForFurniture("chest", 70, baseY), false);
  assert.equal(tooHighForFurniture("chest", 70 + FURNITURE_MAX_ABOVE_BASE, baseY), false);
  assert.equal(tooHighForFurniture("chest", 71 + FURNITURE_MAX_ABOVE_BASE, baseY), true);
});

// Bots mine to y=-3 and legitimately want a furnace down there to smelt on the
// spot. The hazard is a PERCH above the base, not depth, so depth is allowed.
test("furniture deep underground is allowed", () => {
  assert.equal(tooHighForFurniture("furnace", -3, 70), false);
  assert.equal(tooHighForFurniture("chest", 6, 70), false);
});

// Building blocks are how a bot bridges and towers. Restricting those would
// break navigation; the hazard is standing on a half-height container.
test("ordinary building blocks are never refused", () => {
  for (const b of ["cobblestone", "oak_planks", "dirt", "andesite", "diorite", "granite", "stone"]) {
    assert.equal(isFurniture(b), false, `${b} must stay placeable`);
    assert.equal(tooHighForFurniture(b, 123, 70), false, `${b} must stay placeable at altitude`);
  }
});

test("every workstation and container counts as furniture", () => {
  for (const b of ["chest", "crafting_table", "furnace", "barrel", "blast_furnace", "smoker", "anvil"]) {
    assert.equal(isFurniture(b), true, `${b} should be furniture`);
  }
});

// With no known base there is nothing to measure against, and refusing on a
// guess would block legitimate placement.
test("no base height means no refusal", () => {
  assert.equal(tooHighForFurniture("chest", 123, undefined), false);
});

// The refusal has to say where to put it instead, or the brain will simply
// retry in the same spot. Four separate bugs today were a correct refusal
// paired with advice that could not be followed.
test("refusal says what to do instead", () => {
  const message = furnitureRefusal("chest", 123, 70);
  assert.match(message, /chest/, "names the block");
  assert.match(message, /base|stash|ground/i, "points somewhere reachable");
  assert.match(message, /53|above/i, "says how far off it is");
});
