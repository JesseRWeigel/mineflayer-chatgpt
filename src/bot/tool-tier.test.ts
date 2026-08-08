import { test } from "node:test";
import assert from "node:assert/strict";

import { pickaxeTier, requiredTier, canHarvest, harvestAdvice } from "./tool-tier.js";

// THE BUG THIS FILE EXISTS FOR.
//
// mine_block equipped the best pickaxe the bot owned and dug, without ever
// asking whether that pickaxe could harvest the target. Over one 4h36m session:
//
//   251 mine_block calls targeted iron_ore
//   281 wooden_pickaxe mentions vs 55 stone and 14 iron
//   120 "dig timeout" failures, the single largest cause
//    26 successes against 293 failures -- an 8% success rate
//
// Iron ore needs a stone pickaxe. With a wooden one the block takes hardness x5
// = 15s to break and drops nothing, and digSafe times out at 12s. So every one
// of those attempts was arithmetically incapable of succeeding, and the bot
// repeated it 251 times, blocking ~24 minutes on digs that could not work.
//
// It is self-reinforcing: the way out is a stone pickaxe, which needs
// cobblestone, which needs mining stone -- which a wooden pickaxe CAN do. The
// bots were asking for the one thing they could not have instead of the thing
// that would have unblocked them.
test("a wooden pickaxe cannot harvest iron ore", () => {
  assert.equal(canHarvest("iron_ore", "wooden_pickaxe"), false);
  assert.equal(canHarvest("iron_ore", "stone_pickaxe"), true);
  assert.equal(canHarvest("iron_ore", "iron_pickaxe"), true);
  assert.equal(canHarvest("iron_ore", "diamond_pickaxe"), true);
});

test("stone and coal are reachable with the starter pickaxe", () => {
  // The way out of the deadlock. If these were gated too the bot could never
  // craft its way up a tier.
  for (const b of ["stone", "cobblestone", "coal_ore", "andesite", "diorite", "granite"]) {
    assert.equal(canHarvest(b, "wooden_pickaxe"), true, `${b} must be minable with wood`);
  }
});

test("gold, redstone and diamond need iron", () => {
  for (const b of ["gold_ore", "redstone_ore", "diamond_ore", "emerald_ore"]) {
    assert.equal(canHarvest(b, "stone_pickaxe"), false, `${b} must not be minable with stone`);
    assert.equal(canHarvest(b, "iron_pickaxe"), true, `${b} must be minable with iron`);
  }
});

// Deepslate variants are a different block name for the same ore and the same
// tier. Below y=0 every ore the bots dig is the deepslate form, and treating
// those as unknown would silently disable the check exactly where mining happens.
test("deepslate ores carry their base ore's requirement", () => {
  assert.equal(canHarvest("deepslate_iron_ore", "wooden_pickaxe"), false);
  assert.equal(canHarvest("deepslate_iron_ore", "stone_pickaxe"), true);
  assert.equal(canHarvest("deepslate_gold_ore", "stone_pickaxe"), false);
  assert.equal(canHarvest("deepslate_coal_ore", "wooden_pickaxe"), true);
});

// Gold is a tier-0 harvest level despite being fast. A bot holding one must not
// be told it can mine iron.
test("a golden pickaxe ranks with wood, not with iron", () => {
  assert.equal(pickaxeTier("golden_pickaxe"), pickaxeTier("wooden_pickaxe"));
  assert.equal(canHarvest("iron_ore", "golden_pickaxe"), false);
});

test("obsidian needs diamond", () => {
  assert.equal(canHarvest("obsidian", "iron_pickaxe"), false);
  assert.equal(canHarvest("obsidian", "diamond_pickaxe"), true);
  assert.equal(canHarvest("obsidian", "netherite_pickaxe"), true);
});

test("no pickaxe at all harvests only what needs none", () => {
  assert.equal(canHarvest("iron_ore", null), false);
  assert.equal(canHarvest("stone", null), false, "stone still needs a pickaxe to DROP");
  assert.equal(canHarvest("dirt", null), true);
  assert.equal(canHarvest("oak_log", null), true);
});

// An unknown block must not be blocked. A false negative here stops the bot
// mining something it could have mined, which is worse than the 12s timeout
// this check exists to avoid.
test("unknown blocks are allowed through rather than blocked", () => {
  assert.equal(canHarvest("some_modded_block", "wooden_pickaxe"), true);
  assert.equal(requiredTier("some_modded_block"), 0);
});

test("non-pickaxes have no pickaxe tier", () => {
  assert.equal(pickaxeTier("stone_axe"), null);
  assert.equal(pickaxeTier("iron_shovel"), null);
  assert.equal(pickaxeTier(null), null);
});

// The message is the whole point of failing early: the brain has to learn what
// to do instead, or it will just ask for iron_ore again on the next cycle.
test("advice names the tool needed and the way to get there", () => {
  const advice = harvestAdvice("iron_ore", "wooden_pickaxe");
  assert.match(advice, /stone_pickaxe/, "must name the tool that would work");
  assert.match(advice, /iron_ore/, "must name what it failed on");
  assert.match(advice, /cobblestone|stone/, "must point at the unblocking material");
});
