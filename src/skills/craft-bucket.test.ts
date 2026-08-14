import { test } from "node:test";
import assert from "node:assert/strict";

import { ironNeededFor } from "./craft-bucket.js";

// THE BUG THIS FILE EXISTS FOR.
//
// skills/generated/craftBucket.js opened with
//
//   const mcData = require('mineflayer-collectblock').mcData;
//
// which is not an export of that package, so mcData was undefined and the
// skill threw on its first line. It had never been attempted, and a bucket is
// the first rung of the only route to the Nether's 24 advancements.
//
// It also failed with "Cannot find crafting_table nearby" -- the same shape
// that let craftChest fail 85 times without ever retiring, because the crash
// text matched a precondition keyword.
//
// A bucket is 3 iron ingots. The arithmetic is pinned here so the skill can be
// asked "can I do this yet?" without touching a server.

test("three ingots in hand needs no smelting", () => {
  assert.deepEqual(ironNeededFor({ iron_ingot: 3 }), { smelt: 0, short: 0 });
});

test("raw iron is smelted to make up the difference", () => {
  assert.deepEqual(ironNeededFor({ iron_ingot: 1, raw_iron: 5 }), { smelt: 2, short: 0 });
});

test("not enough of either reports the shortfall rather than smelting blind", () => {
  assert.deepEqual(ironNeededFor({ iron_ingot: 0, raw_iron: 1 }), { smelt: 1, short: 2 });
});

test("an empty inventory is short the whole three", () => {
  assert.deepEqual(ironNeededFor({}), { smelt: 0, short: 3 });
});

test("surplus ingots are never smelted away", () => {
  assert.deepEqual(ironNeededFor({ iron_ingot: 9, raw_iron: 4 }), { smelt: 0, short: 0 });
});
