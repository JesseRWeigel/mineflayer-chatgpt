import { test } from "node:test";
import assert from "node:assert/strict";

import { travelBudgetMs, MIN_TRAVEL_MS, MAX_TRAVEL_MS } from "./mine-budget.js";

// mineBlock searches for ore up to 64 blocks away and used safeGoto's 15 second
// default while tunnelling through stone. One 1h48m session: 39 "Navigation
// timed out", 28 "dig timeout", 8 iron mined.
test("a distant vein gets far more than the old 15 second default", () => {
  assert.ok(travelBudgetMs(64) > 15_000, "64 blocks of digging cannot happen in 15s");
  assert.ok(travelBudgetMs(40) > 15_000);
});

test("a nearby block still fails fast", () => {
  // Otherwise one unreachable block underfoot burns a minute of the action budget.
  assert.equal(travelBudgetMs(2), MIN_TRAVEL_MS);
  assert.equal(travelBudgetMs(0), MIN_TRAVEL_MS);
});

test("budget never exceeds the cap", () => {
  // A single mine_block must not be able to eat the 150s action watchdog.
  assert.equal(travelBudgetMs(500), MAX_TRAVEL_MS);
  assert.ok(MAX_TRAVEL_MS < 150_000, "must stay well inside the action watchdog");
});

test("budget grows with distance", () => {
  assert.ok(travelBudgetMs(50) > travelBudgetMs(20));
  assert.ok(travelBudgetMs(20) > travelBudgetMs(12));
});

test("nonsense distances fall back to the floor, never NaN", () => {
  // A NaN here would become a NaN timeout and hang the action until the watchdog.
  assert.equal(travelBudgetMs(Number.NaN), MIN_TRAVEL_MS);
  assert.equal(travelBudgetMs(-5), MIN_TRAVEL_MS);
  assert.equal(travelBudgetMs(Infinity), MIN_TRAVEL_MS);
});
