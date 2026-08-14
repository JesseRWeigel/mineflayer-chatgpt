import { test } from "node:test";
import assert from "node:assert/strict";

import { miningReachLine, bestPickaxeName } from "./mining-reach.js";

// THE BUG THIS FILE EXISTS FOR.
//
// Five independently-trained models (gpt-oss:20b, qwen3.6:35b-a3b, ornith:35b,
// Agents-A1, nemotron-3.5-lightning) were each given this state:
//
//   Inventory: wooden_pickaxe x1, oak_planks x12, stick x8, cobblestone x11
//   Nearby notable blocks: iron_ore, stone, coal_ore, oak_log
//
// and every one of them chose mine_block {"blockType":"iron_ore"} on essentially
// every sample. Iron needs a stone pickaxe to drop anything; a wooden pickaxe
// digs for 15s and yields nothing, and digSafe gives up at 12s.
//
// This is not a model-quality problem. tool-tier.ts has known the rule since it
// was written, but only checks it at the ACTION layer -- after the brain has
// already spent a decision cycle. harvestAdvice() then teaches the lesson as a
// failure message, which expires with the 120s failure block and has to be
// re-learned. The context never says what the bot can actually mine right now.
//
// Same shape as curriculum.ts's getTechTreeLine: compute it deterministically
// and put it in front of the decision instead of behind it.

test("a block the held pickaxe cannot harvest is never presented as available", () => {
  const line = miningReachLine(["iron_ore", "stone", "coal_ore"], "wooden_pickaxe");
  const available = line.split(/NEEDS|BLOCKED|REQUIRES/i)[0];
  assert.ok(!available.includes("iron_ore"), `iron_ore must not read as mineable: ${line}`);
});

test("the line names the pickaxe that would unlock the blocked block", () => {
  const line = miningReachLine(["iron_ore"], "wooden_pickaxe");
  assert.match(line, /stone_pickaxe/);
});

test("blocks the held pickaxe CAN harvest are surfaced", () => {
  const line = miningReachLine(["iron_ore", "coal_ore"], "stone_pickaxe");
  assert.ok(line.includes("coal_ore"), `coal_ore is harvestable with stone tier: ${line}`);
});

test("a better pickaxe unblocks what a worse one could not", () => {
  const wooden = miningReachLine(["iron_ore"], "wooden_pickaxe");
  const stone = miningReachLine(["iron_ore"], "stone_pickaxe");
  assert.notEqual(wooden, stone, "tier must change the advice");
});

test("holding no pickaxe at all still produces usable advice", () => {
  const line = miningReachLine(["stone", "iron_ore"], null);
  assert.match(line, /wooden_pickaxe/, `with no pickaxe the only first step is wood: ${line}`);
});

test("logs and dirt need no tool, so they are always reachable", () => {
  const line = miningReachLine(["oak_log", "dirt"], null);
  assert.ok(line.includes("oak_log"), `oak_log drops bare-handed: ${line}`);
});

test("deepslate ores inherit the base ore's requirement", () => {
  const line = miningReachLine(["deepslate_diamond_ore"], "stone_pickaxe");
  assert.match(line, /iron_pickaxe/, `deepslate diamond still needs iron tier: ${line}`);
});

test("nothing notable nearby yields an empty line, not a stray header", () => {
  assert.equal(miningReachLine([], "stone_pickaxe"), "");
});

test("the best pickaxe wins regardless of inventory order", () => {
  assert.equal(bestPickaxeName(["wooden_pickaxe", "iron_pickaxe", "stone_pickaxe"]), "iron_pickaxe");
  assert.equal(bestPickaxeName(["iron_pickaxe", "wooden_pickaxe"]), "iron_pickaxe");
});

test("gold is tier 0 and must not outrank stone despite its speed", () => {
  assert.equal(bestPickaxeName(["golden_pickaxe", "stone_pickaxe"]), "stone_pickaxe");
});

test("an inventory with no pickaxe yields null, not a stray item", () => {
  assert.equal(bestPickaxeName(["oak_log", "cobblestone", "iron_sword"]), null);
});

test("the line stays short enough to not crowd the context", () => {
  const everything = [
    "iron_ore", "copper_ore", "lapis_ore", "gold_ore", "redstone_ore",
    "diamond_ore", "emerald_ore", "obsidian", "stone", "coal_ore", "oak_log",
  ];
  assert.ok(
    miningReachLine(everything, "wooden_pickaxe").length < 400,
    "context budget: this renders on every strategic decision",
  );
});

// ── REGRESSION: furniture is not a mining target ──
//
// perception.ts passes all of NOTABLE_BLOCKS, which mixes ore with landmarks.
// A bot holding no pickaxe was told `NEEDS wooden_pickaxe: crafting_table` --
// the table it needs to craft the pickaxe, reported as locked behind it.

test("a pickaxe-less bot is never told the crafting table needs a pickaxe", () => {
  const line = miningReachLine(["crafting_table", "furnace", "chest", "stone"], null);
  assert.ok(!line.includes("crafting_table"), `crafting_table must not appear: ${line}`);
  assert.ok(!line.includes("furnace"), `furnace must not appear: ${line}`);
});

test("furniture is not offered as mineable either", () => {
  const line = miningReachLine(["crafting_table", "chest", "iron_ore"], "stone_pickaxe");
  assert.ok(!line.includes("chest"), `chest must not read as ore: ${line}`);
  assert.ok(line.includes("iron_ore"), `real ore should still show: ${line}`);
});

test("water and lava are landmarks, not blocks to mine", () => {
  assert.equal(miningReachLine(["water", "lava"], "stone_pickaxe"), "");
});
