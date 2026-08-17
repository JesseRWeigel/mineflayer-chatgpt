// src/skills/fluid.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { isSourceBlock, noSourceAdvice, withinReach, REACH_BLOCKS, FLUID_SEARCH_BLOCKS } from "./fluid.js";

// WHAT THIS FILE PINS DOWN.
//
// The swarm had zero fluid handling: no bucket, no lava, no obsidian, no
// ignition anywhere in src/. The one generated craftBucket.js imported
// `require('mineflayer-collectblock').mcData`, which is not a real export, and
// had never been attempted.
//
// Two things kill a cast silently and are worth pinning:
//
//   1. Only a SOURCE block makes obsidian. Water hitting FLOWING lava produces
//      cobblestone. In Minecraft a fluid block's metadata is 0 when it is a
//      source and non-zero when it is flowing, so a bot that ignores metadata
//      builds a cobblestone rectangle and never understands why.
//
//   2. Standing on or above the lava you are about to scoop is how a bot dies
//      holding the team's only iron bucket.

test("a source block is metadata 0", () => {
  assert.equal(isSourceBlock({ name: "lava", metadata: 0 }), true);
  assert.equal(isSourceBlock({ name: "water", metadata: 0 }), true);
});

test("flowing fluid is not a source and must never be scooped for a cast", () => {
  assert.equal(isSourceBlock({ name: "lava", metadata: 1 }), false);
  assert.equal(isSourceBlock({ name: "lava", metadata: 7 }), false);
});

test("a missing block is not a source", () => {
  assert.equal(isSourceBlock(null), false);
});

test("a non-fluid block is not a source however its metadata reads", () => {
  assert.equal(isSourceBlock({ name: "stone", metadata: 0 }), false);
});

// ── REGRESSION: a failure the brain cannot act on gets retried unchanged ──
//
// fill_bucket ran 13 times and returned "Cannot find a lava source within 32
// blocks" every time. True, and useless: Forge was at y=73, where surface lava
// is rare, and nothing said that lava pools sit below y=10 or that strip_mine
// is how you get there. The bot retried from the same spot.

test("lava advice names the depth and the skill that gets you there", () => {
  const a = noSourceAdvice("lava", 73);
  assert.match(a, /y=73/, "say where the bot actually is");
  assert.match(a, /strip_mine/, "name the route down");
});

test("a bot already deep is told to explore sideways, not to dig further", () => {
  const a = noSourceAdvice("lava", 8);
  assert.doesNotMatch(a, /strip_mine/, "it is already deep enough");
  assert.match(a, /cave|sideways/i);
});

test("water advice points at the surface, not underground", () => {
  const a = noSourceAdvice("water", 70);
  assert.doesNotMatch(a, /strip_mine/);
  assert.match(a, /lake|river|ocean/i);
});

test("advice never begins with a crash prefix", () => {
  // "<name> failed:" marks a thrown skill and always counts against retirement.
  for (const y of [73, 8]) assert.doesNotMatch(noSourceAdvice("lava", y), /^\s*\S+ failed:/);
});

test("the advice cannot loop: its threshold is above what strip_mine can reach", async () => {
  // strip_mine's TARGET_Y is 16. If LAVA_DEPTH sat below that, a bot that dug
  // down perfectly would arrive at 16, be told it is still too high, and dig
  // again forever. The first version of this used 10 and would have.
  const { LAVA_DEPTH } = await import("./fluid.js");
  const stripMineTarget = 16;
  assert.ok(
    LAVA_DEPTH > stripMineTarget,
    `LAVA_DEPTH ${LAVA_DEPTH} must exceed strip_mine's TARGET_Y ${stripMineTarget} or the advice loops`,
  );
  assert.doesNotMatch(noSourceAdvice("lava", stripMineTarget), /strip_mine/);
});

// ── REGRESSION: scooping from out of reach reports a lie ──
//
// Measured 2026-08-15: fill_bucket descended 46 blocks to y=-29, found lava,
// and returned "Bucket did not fill from the lava source". findBlock searches
// 32 blocks; the walk to the approach square is best-effort and swallows its
// own failure; and activateItem does nothing to a block outside the ~4.5 block
// reach. So a bot 20 blocks from lava "tried to scoop" and reported a failure
// that read like a mechanics problem rather than a distance one.

test("out of reach is reported as distance, not as a failed scoop", () => {
  assert.equal(withinReach(0, 0, 0, 20, 0, 0), false);
  assert.equal(withinReach(0, 0, 0, 3, 0, 1), true);
});

test("the reach limit matches Minecraft's, not an invented number", () => {
  assert.ok(REACH_BLOCKS >= 3 && REACH_BLOCKS <= 6, `REACH_BLOCKS ${REACH_BLOCKS} is not a plausible reach`);
});

test("the fluid search reaches beyond a single cave chamber", () => {
  // 32 blocks was too short underground: a bot inside a cave system reported
  // "cannot find a lava source" and dug a fresh 46-block shaft instead of
  // walking to the pool it was already near.
  assert.ok(FLUID_SEARCH_BLOCKS >= 64, `${FLUID_SEARCH_BLOCKS} is too short to find cave lava`);
});

test("the no-source message reports the radius actually searched", () => {
  assert.match(noSourceAdvice("lava", 70), new RegExp(String(FLUID_SEARCH_BLOCKS)));
});
