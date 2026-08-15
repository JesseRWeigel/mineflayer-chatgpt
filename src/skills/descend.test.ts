import { test } from "node:test";
import assert from "node:assert/strict";

import { safeToDigDown, DANGER_LOOKAHEAD } from "./descend.js";

// THE BUG THIS FILE EXISTS FOR.
//
// strip_mine descends with a pathfinder GoalY(16). Measured 2026-08-15 across
// one hour: 12 runs never reached ore depth and 2 did. The failures stalled at
// y=69, 66, 62, 71, 64, 55 -- barely moved -- while the successes reached y=16
// and even y=-33 comfortably inside the same 60s budget.
//
// So it is not a timeout. The pathfinder simply cannot route a dig path from
// certain terrain, and raising the budget would only re-create the problem
// noted at strip-mine.ts:182, where an over-long descent timeout ran the skill
// into the 240s watchdog and stalled the miner.
//
// The fallback is what a player does: dig straight down. That is also the
// classic way to die, so the safety check is the part worth pinning. Digging
// into lava while carrying the team's only iron bucket is the specific
// disaster.

const solid = () => "solid" as const;

test("solid rock below is safe to dig", () => {
  assert.equal(safeToDigDown(solid).safe, true);
});

test("lava anywhere in the lookahead is refused", () => {
  for (let d = 1; d <= DANGER_LOOKAHEAD; d++) {
    const probe = (depth: number) => (depth === d ? ("lava" as const) : ("solid" as const));
    const r = safeToDigDown(probe);
    assert.equal(r.safe, false, `lava at depth ${d} must stop the dig`);
    assert.match(r.reason, /lava/i);
  }
});

test("water is refused too — a flooded shaft drowns the bot", () => {
  assert.equal(safeToDigDown((d) => (d === 2 ? "water" : "solid")).safe, false);
});

test("an open drop is refused rather than fallen into", () => {
  // Air below means a cave: digging the last block drops the bot into it.
  const r = safeToDigDown((d) => (d === 2 ? "air" : "solid"));
  assert.equal(r.safe, false);
  assert.match(r.reason, /drop|air|cave/i);
});

test("unknown blocks are refused, not assumed solid", () => {
  // An unloaded chunk below is exactly where a bot should not dig blind.
  assert.equal(safeToDigDown((d) => (d === 3 ? "unknown" : "solid")).safe, false);
});

test("the lookahead is deep enough to matter", () => {
  // One block is not enough: you need to see what you are about to stand over.
  assert.ok(DANGER_LOOKAHEAD >= 3, `lookahead ${DANGER_LOOKAHEAD} is too shallow to be safe`);
});

test("the refusal reason is human-readable for the log", () => {
  const r = safeToDigDown((d) => (d === 1 ? "lava" : "solid"));
  assert.ok(r.reason.length > 8, "the log line has to explain itself");
});
