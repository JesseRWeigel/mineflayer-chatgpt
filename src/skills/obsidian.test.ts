// src/skills/obsidian.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { chooseStrategy } from "./obsidian.js";

// WHAT THIS FILE PINS DOWN.
//
// Obsidian needs a diamond pickaxe to MINE, but not to MAKE: water poured on a
// lava source turns it to obsidian where it stands. The swarm is at iron tier
// with one diamond, so a plan that required a diamond pickaxe would have
// blocked the whole nether push behind a diamond hunt of unknown length.
//
// Both routes exist and the bot picks. The distinction is not cosmetic:
//
//   cast -> reaches the Nether, unlocks its 24 advancements, but never puts
//           obsidian in the inventory, so story/form_obsidian stays unearned
//           (its trigger is inventory_changed on minecraft:obsidian).
//   mine -> also earns story/form_obsidian.
//
// Getting the tier test wrong in the optimistic direction is expensive: a bot
// that believes an iron pickaxe can mine obsidian digs for 250 seconds and
// drops nothing.

test("a diamond pickaxe means mine", () => {
  assert.equal(chooseStrategy(["diamond_pickaxe", "bucket"]), "mine");
});

test("netherite also mines", () => {
  assert.equal(chooseStrategy(["netherite_pickaxe"]), "mine");
});

test("iron is not good enough and must cast instead", () => {
  // The expensive mistake: iron digs obsidian for 250s and drops nothing.
  assert.equal(chooseStrategy(["iron_pickaxe", "bucket"]), "cast");
});

test("stone, wood and gold all cast", () => {
  assert.equal(chooseStrategy(["stone_pickaxe"]), "cast");
  assert.equal(chooseStrategy(["wooden_pickaxe"]), "cast");
  assert.equal(chooseStrategy(["golden_pickaxe"]), "cast");
});

test("no pickaxe at all still casts rather than refusing", () => {
  assert.equal(chooseStrategy([]), "cast");
});

test("the best pickaxe decides, not the first one found", () => {
  assert.equal(chooseStrategy(["wooden_pickaxe", "diamond_pickaxe"]), "mine");
  assert.equal(chooseStrategy(["diamond_pickaxe", "wooden_pickaxe"]), "mine");
});
