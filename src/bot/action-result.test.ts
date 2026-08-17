import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyResult } from "./action-result.js";

// THE BUG THIS FILE EXISTS FOR.
//
// brain.ts classified every action outcome with one bare keyword regex:
//
//   /complet|harvest|built|planted|smelted|crafted|arriv|gather|mined|caught
//    |lit|bridg|chop|killed|ate|explored|placed|fished|sleep|zzz/i
//
// It matched keywords anywhere in the string, with no notion of whether the
// sentence was reporting an achievement or refusing to act. Two failure modes,
// both silent:
//
//   FALSE NEGATIVES. "Deposited 12 items at the stash." contains none of the
//   keywords, so banking loot -- the single most productive thing a bot does --
//   scored as a failure. Same for "Withdrew 5x iron_ingot from stash."
//
//   FALSE POSITIVES. "Can't harvest stone with wooden_pickaxe" matched
//   `harvest`. "Can't sleep, not nighttime yet." matched `sleep`. Refusals
//   scored as wins.
//
// The damage was not cosmetic. isSuccess feeds three consumers:
//   1. recordAction    -> ACTION_SUCCESS_PCT, the health metric
//   2. recordSkillResult -> per-skill scoring
//   3. trackFailure    -> the blacklist that stops a bot repeating a dead action
//
// So the metric read LOW exactly when bots were most productive (lots of
// deposits), and the blacklist never fired on refusals that scored as wins.
// Observed 2026-08-09: Mason repeated place_block 120 times at y=122.

test("banking loot at the stash is a success", () => {
  assert.equal(classifyResult("Deposited 12 items at the stash."), true);
});

test("withdrawing from the stash is a success", () => {
  assert.equal(classifyResult("Withdrew 5x iron_ingot from stash."), true);
});

test("a partial deposit is still a success", () => {
  assert.equal(classifyResult("Deposited 8 items. 4 items couldn't fit (chest full)."), true);
});

test("refusing to harvest is not a success", () => {
  assert.equal(classifyResult("Can't harvest stone with wooden_pickaxe, it needs a stone_pickaxe."), false);
});

test("refusing to sleep is not a success", () => {
  assert.equal(classifyResult("Can't sleep, not nighttime yet."), false);
});

test("an empty inventory deposit is not a success", () => {
  assert.equal(classifyResult("Nothing to deposit, inventory is empty."), false);
});

test("an unreachable stash is not a success", () => {
  assert.equal(classifyResult("Can't reach the stash, 45 blocks away (blocked or underground)."), false);
});

test("a navigation failure is not a success", () => {
  assert.equal(classifyResult("No path to the goal!"), false);
});

test("a thrown craft error is not a success", () => {
  assert.equal(classifyResult("Failed to craft chest: Error: no table"), false);
});

test("genuine achievements still register", () => {
  assert.equal(classifyResult("Mined 14 cobblestone."), true);
  assert.equal(classifyResult("Crafted 4 torches."), true);
  assert.equal(classifyResult("Smelted 8 iron_ingot."), true);
  assert.equal(classifyResult("Arrived at 120, 64, -30."), true);
});

// ── REGRESSION: the anchored version rejected the codebase's own house style ──
//
// Measured 2026-08-14 against 16 real success strings pulled from
// dynamic-loader.ts, actions.ts and the built-in skills: the anchored regex
// rejected 13 of them. Two successful runs of a working skill were enough to
// blacklist it, because brain.ts feeds this into trackFailure.

test("a dynamic skill reporting completion is a success", () => {
  // Every one of the 131 dynamic skills returns exactly this shape.
  assert.equal(classifyResult("collectBamboo completed."), true);
  assert.equal(classifyResult("buildShelter completed."), true);
});

test("built-in skills that put the noun first are successes", () => {
  assert.equal(classifyResult("Gear crafted!"), true);
  assert.equal(classifyResult("Farm planted!"), true);
  assert.equal(classifyResult("HOUSE BUILT!"), true);
  assert.equal(classifyResult("Bridge built!"), true);
  assert.equal(classifyResult("All materials gathered!"), true);
  assert.equal(classifyResult("Strip mine complete!"), true);
  assert.equal(classifyResult("Smelting done!"), true);
  assert.equal(classifyResult("Stash bootstrapped!"), true);
});

test("combat and generation results are successes", () => {
  assert.equal(classifyResult("Defeated zombie using advanced combat!"), true);
  assert.equal(classifyResult("Generated skill 'buildTower'! I can now use it with invoke_skill."), true);
});

test("terminal-verb matching still does not swallow refusals", () => {
  // The whole reason the anchor existed. These must stay false.
  assert.equal(classifyResult("Can't harvest stone with wooden_pickaxe"), false);
  assert.equal(classifyResult("Couldn't get the farm planted because there was no water"), false);
  assert.equal(classifyResult("Failed to craft chest: Error: no table"), false);
  assert.equal(classifyResult("Nothing to deposit, inventory is empty."), false);
  assert.equal(classifyResult("No path to the goal!"), false);
  assert.equal(classifyResult("buildTower failed: TypeError"), false);
  assert.equal(classifyResult("buildTower aborted."), false);
});

test("genuinely novel phrasing still defaults to false", () => {
  assert.equal(classifyResult("The wind whispers through the birches"), false);
});
