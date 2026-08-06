import { test } from "node:test";
import assert from "node:assert/strict";

import { affordableArmourPiece, ARMOUR_COST } from "./craft-gear.js";

// craft_gear attempted only the chestplate, which costs 8 ingots. The swarm
// mines about 4 iron an hour and bots were dying 13 times an hour, dropping
// everything. Measured in one session: 15 of 21 deaths with NO armour, 14 of
// them to zombies, and "No iron_ingot in the stash" 56 times.
test("a bot with 4 ingots gets boots instead of nothing", () => {
  // The old behaviour attempted an 8-ingot chestplate and this bot wore nothing.
  assert.equal(affordableArmourPiece(4), "iron_boots");
});

test("still prefers the chestplate once it is actually affordable", () => {
  assert.equal(affordableArmourPiece(8), "iron_chestplate");
  assert.equal(affordableArmourPiece(24), "iron_chestplate");
});

test("picks the most protective piece that fits the iron on hand", () => {
  assert.equal(affordableArmourPiece(7), "iron_leggings", "5 points beats helmet's 2");
  assert.equal(affordableArmourPiece(5), "iron_boots", "helmet and boots both give 2, boots cost less");
  assert.equal(affordableArmourPiece(6), "iron_boots");
});

test("never re-crafts a piece the bot already has", () => {
  // Order is chestplate, leggings, boots, helmet. Boots come before the helmet
  // because both give 2 points and boots cost 4 ingots against the helmet's 5.
  assert.equal(affordableArmourPiece(24, ["iron_chestplate"]), "iron_leggings");
  assert.equal(affordableArmourPiece(24, ["iron_chestplate", "iron_leggings"]), "iron_boots");
  assert.equal(affordableArmourPiece(24, ["iron_chestplate", "iron_leggings", "iron_boots"]), "iron_helmet");
});

test("a full set asks for nothing more", () => {
  const full = Object.keys(ARMOUR_COST);
  assert.equal(affordableArmourPiece(64, full), null);
});

test("too little iron returns null so the bot spends it on tools", () => {
  // Below the cheapest piece, waiting is strictly worse than making a pickaxe.
  assert.equal(affordableArmourPiece(3), null);
  assert.equal(affordableArmourPiece(0), null);
});
