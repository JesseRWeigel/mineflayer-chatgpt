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

// THE CIRCULAR ADVICE BUG.
//
// The first version assumed the bot already held a pickaxe and only needed an
// upgrade, so every message routed through cobblestone. A bot holding nothing
// was told, verbatim:
//
//   "Can't harvest stone with nothing — it needs a wooden_pickaxe.
//    Mine stone for cobblestone and craft a wooden_pickaxe first..."
//
// Mine stone, in order to be able to mine stone. 126 of 176 refusals in one
// 56-minute session went to bots holding no pickaxe at all, every one of them
// carrying an instruction that could not be followed.
//
// Failing fast only helps if the way out is real. Wrong advice delivered
// instantly is worse than the 12s timeout it replaced, because the bot now
// burns a decision on it every cycle instead of every twelve seconds.
test("a bot with no pickaxe is sent to wood, never to stone", () => {
  for (const target of ["stone", "coal_ore", "iron_ore", "copper_ore"]) {
    const advice = harvestAdvice(target, null);
    assert.match(advice, /wood/i, `${target}: must point at wood, the only thing it can gather`);
    assert.match(advice, /wooden_pickaxe/, `${target}: the first tool is always wooden`);
    assert.doesNotMatch(
      advice,
      /Mine stone|mine stone/,
      `${target}: cannot tell a pickaxe-less bot to mine stone`,
    );
  }
});

// A wooden pickaxe is 3 planks + 2 sticks. It has never been craftable from
// cobblestone, so routing tier-0 advice through stone was wrong twice over.
//
// Assert on the message with every "<material>_pickaxe" removed. Without that,
// /wood/i matches "wooden_pickaxe" and /iron/i matches "iron_pickaxe", so these
// assertions pass against the broken message that always said cobblestone.
const materialsIn = (advice: string) => advice.replace(/[a-z]+_pickaxe/g, "");
test("each tier names the material it is actually crafted from", () => {
  assert.match(materialsIn(harvestAdvice("stone", null)), /plank|wood/i);
  assert.match(materialsIn(harvestAdvice("iron_ore", "wooden_pickaxe")), /cobblestone/);
  assert.match(materialsIn(harvestAdvice("diamond_ore", "stone_pickaxe")), /iron ingot/i);
  assert.match(materialsIn(harvestAdvice("obsidian", "iron_pickaxe")), /diamond/i);
});

test("advice still names the block that failed and the tool that would work", () => {
  const advice = harvestAdvice("copper_ore", null);
  assert.match(advice, /copper_ore/, "must name what it failed on");
  assert.match(advice, /stone_pickaxe/, "must still name the tool the target needs");
});
