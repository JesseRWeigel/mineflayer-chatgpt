import { test } from "node:test";
import assert from "node:assert/strict";

import { blockMatcher, DEFAULT_MINE_TARGET } from "./actions.js";

// The default was "stone". The critic returns nextParams:{} for most follow-ups,
// so 39 of 116 mine_block calls in one session arrived with no blockType and
// mined stone while the bot's thought said "Time to dig for iron!". The
// strategic path asked for iron_ore 44 times out of 52 explicit requests, and
// exactly one call asked for stone. Meanwhile bots held 0-2 iron against a
// 4-ingot boot and 15 of 21 deaths were unarmoured.
test("an unspecified dig no longer means stone", () => {
  assert.notEqual(DEFAULT_MINE_TARGET, "stone", "this default cost a third of all mining");
  const { match, isOre } = blockMatcher(DEFAULT_MINE_TARGET);
  assert.equal(isOre, true);
  assert.equal(match("iron_ore"), true);
  assert.equal(match("stone"), false, "stone must not satisfy an unspecified dig");
});

test("the default matches every ore the bots care about", () => {
  const { match } = blockMatcher(DEFAULT_MINE_TARGET);
  for (const ore of ["iron_ore", "coal_ore", "diamond_ore", "gold_ore", "copper_ore", "deepslate_iron_ore"]) {
    assert.equal(match(ore), true, `${ore} should satisfy an unspecified dig`);
  }
});

test("an explicit request is still honoured exactly", () => {
  // A bot that wants stone says so, and one did.
  const stone = blockMatcher("stone");
  assert.equal(stone.match("stone"), true);
  assert.equal(stone.isOre, false, "stone must not trigger vein mining");
  assert.equal(stone.match("iron_ore"), false);

  const iron = blockMatcher("iron_ore");
  assert.equal(iron.match("iron_ore"), true);
  assert.equal(iron.match("deepslate_iron_ore"), true, "deepslate form is the same ore");
  assert.equal(iron.match("stone"), false);
});

test("bare metal names still resolve to their ore", () => {
  // The LLM writes "iron" as often as "iron_ore".
  const iron = blockMatcher("iron");
  assert.equal(iron.match("iron_ore"), true);
  assert.equal(iron.isOre, true);
});
