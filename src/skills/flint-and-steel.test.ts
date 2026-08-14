import { test } from "node:test";
import assert from "node:assert/strict";

import { igniterPlan } from "./flint-and-steel.js";

// WHAT THIS FILE PINS DOWN.
//
// A portal frame with nothing to light it is ten wasted round trips to a lava
// pool. Flint and steel is 1 flint + 1 iron ingot, and flint only drops from
// gravel -- at 10%, so the expected cost is about 10 gravel per flint. A bot
// that goes looking for gravel with an exact-count plan gives up too early.
//
// The team already keeps flint_and_steel in the stash keep-list
// (src/skills/stash.ts), so having one is the common case and must short-circuit.

test("already holding one needs nothing", () => {
  assert.deepEqual(igniterPlan({ flint_and_steel: 1 }), { have: true, needGravel: 0, needIron: 0 });
});

test("flint plus iron needs no gravel", () => {
  assert.deepEqual(igniterPlan({ flint: 1, iron_ingot: 1 }), { have: false, needGravel: 0, needIron: 0 });
});

test("no flint budgets ten gravel for a ten percent drop", () => {
  assert.deepEqual(igniterPlan({ iron_ingot: 1 }), { have: false, needGravel: 10, needIron: 0 });
});

test("gravel on hand counts against the budget", () => {
  assert.deepEqual(igniterPlan({ gravel: 4, iron_ingot: 1 }), { have: false, needGravel: 6, needIron: 0 });
});

test("missing iron is reported alongside missing flint", () => {
  assert.deepEqual(igniterPlan({}), { have: false, needGravel: 10, needIron: 1 });
});
