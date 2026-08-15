import { test } from "node:test";
import assert from "node:assert/strict";

import { safeToDigDown, DANGER_LOOKAHEAD, shouldKeepDigging } from "./descend.js";

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

test("a drop too deep to survive is refused rather than fallen into", () => {
  // Air from d=2 with the floor 5 blocks down: a 4-block fall, past the
  // no-damage threshold. (A 1-block step is fine and is covered below — this
  // test originally refused that too, which is what stalled every descent at
  // the first cave.)
  const r = safeToDigDown((d) => (d >= 2 && d <= 6 ? "air" : "solid"));
  assert.equal(r.safe, false);
  assert.match(r.reason, /drop|fall|shaft/i);
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

// ── REGRESSION: refusing every cave means never reaching the lava sea ──
//
// Measured 2026-08-15: "Dug down 15 to y=53, then stopped: open air 3 block(s)
// below — a cave drop, not a dig." Correct as written, and fatal to the goal:
// the lava sea is at y=-52 and caves riddle everything between. A descent that
// halts at the first cavity never arrives.
//
// A short drop onto solid floor is harmless — fall damage starts above 3
// blocks. A long one is not. The check has to tell them apart instead of
// refusing both.

test("a short drop onto solid floor is allowed", () => {
  // air at 2, floor at 3: a 1-block step down.
  const probe = (d: number) => (d === 2 ? ("air" as const) : ("solid" as const));
  assert.equal(safeToDigDown(probe).safe, true, "a 1-block step is not a fall");
});

test("a long drop is still refused", () => {
  // air all the way through the lookahead and beyond: a real shaft.
  assert.equal(safeToDigDown(() => "air").safe, false);
});

test("lava under a short drop is still refused", () => {
  // The gap is survivable; what is at the bottom is not.
  const probe = (d: number) => (d === 2 ? ("air" as const) : d >= 3 ? ("lava" as const) : ("solid" as const));
  assert.equal(safeToDigDown(probe).safe, false);
});

// ── REGRESSION: the descent must fit inside the skill watchdog ──
//
// fill_bucket got a three-shaft retry loop, each shaft up to 140 blocks. At
// roughly a second per block that is well past the executor's 240s watchdog,
// and 2 of 6 fill_bucket runs came back "timed out after Ns — aborted to free
// the bot", losing whatever descent progress they had made.
//
// A budget the caller can shrink is the fix: the loop stops on its own terms
// and reports where it got, instead of being killed mid-shaft.

test("the descent stops when its time budget is spent", () => {
  // 0 remaining means stop before the first block.
  assert.equal(shouldKeepDigging(0, 5, 100), false);
});

test("a fresh budget keeps digging", () => {
  assert.equal(shouldKeepDigging(60_000, 5, 100), true);
});

test("the block cap still applies independently of time", () => {
  assert.equal(shouldKeepDigging(60_000, 100, 100), false);
});
