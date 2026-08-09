import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyWithdraw, nothingToSmeltMessage } from "./smelt-advice.js";

// THE BUG THIS FILE EXISTS FOR.
//
// smelt_ores returns one unconditional sentence when it has no ore in hand:
// "Nothing to smelt! Mine some ore first". Its own instrumentation says that is
// often false. Over one 1h50m session:
//
//   [Smelt] Atlas withdraw raw_iron threw: Navigation timed out — goal may be unreachable
//   [Smelt] Forge withdraw raw_iron threw: Navigation timed out — goal may be unreachable
//   [Smelt] Atlas withdraw iron_ore threw: Path was stopped before it could be completed!
//   [Smelt] Atlas withdraw raw_iron: Withdrew 4x raw_iron from stash
//
// The ore existed. The walk to the stash failed. Telling the bot to mine more
// sends it to produce ore it will bank into the same unreachable stash, which
// is why 0 smelts happened while ore was being mined, no ingots were made, no
// armour was crafted, and Forge died 6 times in an hour wearing only boots.
//
// Fourth instance today of one shape: the failure is detected correctly and the
// advice beside it cannot be followed.
test("an unreachable stash is not reported as missing ore", () => {
  const message = nothingToSmeltMessage(["unreachable", "empty"]);
  assert.doesNotMatch(message, /mine some ore first/i, "must not send it to mine more");
  assert.match(message, /reach|unreachable|path|blocked/i, "must name the real obstruction");
});

test("a genuinely empty stash still says to go mining", () => {
  const message = nothingToSmeltMessage(["empty", "empty"]);
  assert.match(message, /mine/i);
  assert.doesNotMatch(message, /unreachable/i);
});

// One reachable "empty" does not prove the stash is reachable for the ore that
// mattered — but one unreachable proves the walk is failing. Unreachable wins.
test("any unreachable dominates a mix", () => {
  assert.match(nothingToSmeltMessage(["empty", "empty", "unreachable"]), /reach|path|blocked/i);
});

test("no withdrawals attempted falls back to the mining advice", () => {
  assert.match(nothingToSmeltMessage([]), /mine/i);
});

test("classifies the stash's own wording", () => {
  assert.equal(classifyWithdraw("No raw_iron in the stash. Gather it yourself instead.", false), "empty");
  assert.equal(classifyWithdraw("Withdrew 4x raw_iron from stash (wanted 16).", false), "withdrew");
});

// These arrive as thrown errors from safeGoto, not as return values, which is
// why the old code never saw them: withdrawStash RETURNS its messages and
// THROWS its navigation failures, and only the returned half was ever read.
test("classifies navigation failures, which arrive as throws", () => {
  for (const err of [
    "Navigation timed out — goal may be unreachable.",
    "Path was stopped before it could be completed! Thus, the desired goal was not reached.",
    "No path to the goal!",
    "Stuck — not making progress toward goal.",
  ]) {
    assert.equal(classifyWithdraw(err, true), "unreachable", `should be unreachable: ${err.slice(0, 30)}`);
  }
});

test("an unrecognised throw is still not treated as an empty stash", () => {
  assert.equal(classifyWithdraw("something else went wrong", true), "unreachable");
});
