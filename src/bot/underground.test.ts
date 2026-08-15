import { test } from "node:test";
import assert from "node:assert/strict";

import { undergroundNote } from "./underground.js";

// THE BUG THIS FILE EXISTS FOR.
//
// perception.ts told every underground bot:
//
//   ALERT: Bot is UNDERGROUND (Y=..., ceiling N blocks up). Use 'explore' to
//   reach the surface — you need sunlight for trees and wood gathering.
//   Cannot gather_wood underground.
//
// Written for a bot that wanted wood. Delivered to Forge, the Miner/Smelter,
// whose assigned advancement is story/lava_bucket and whose lava sits at y=-52.
//
// Measured 2026-08-15: strip_mine and fill_bucket's own descent were putting
// Forge underground successfully, and it spent every following decision trying
// to leave — "Climb out of this stone cave", "the plan is to climb back up to
// the surface using our ladder", "Time to climb toward the sun". fill_bucket
// was invoked zero times that hour. The context was ordering the miner out of
// the mine.
//
// State the constraint. Do not issue the order.

test("the wood constraint is still stated", () => {
  const n = undergroundNote(40, 3, "Miner / Smelter");
  assert.match(n, /wood/i, "a bot underground genuinely cannot gather wood");
});

test("a miner is not ordered to the surface", () => {
  const n = undergroundNote(40, 3, "Miner / Smelter");
  assert.doesNotMatch(n, /reach the surface|climb (back )?up|go up/i);
});

test("a miner is told this is where its work is", () => {
  const n = undergroundNote(40, 3, "Miner / Smelter");
  assert.match(n, /ore|lava|mine/i);
});

test("depth is reported so the bot can judge distance to lava", () => {
  assert.match(undergroundNote(-30, 4, "Miner / Smelter"), /-30/);
});

test("a wood-dependent role still gets pointed at the surface", () => {
  // Flora needs saplings and light; for her the original advice was right.
  const n = undergroundNote(40, 3, "Farmer / Crafter");
  assert.match(n, /surface/i);
});

test("no role given falls back to the neutral note, not an order", () => {
  assert.doesNotMatch(undergroundNote(40, 3, undefined), /ALERT/);
});

test("the note stays short enough for a per-decision context", () => {
  for (const role of ["Miner / Smelter", "Farmer / Crafter", undefined]) {
    assert.ok(undergroundNote(40, 3, role).length < 220, `note too long for ${role}`);
  }
});
