import { test } from "node:test";
import assert from "node:assert/strict";

import { sampleMovement, isStuck, freshState, SAMPLE_MOVE_BLOCKS } from "./stuck-detector.js";

// THE BUG THIS FILE EXISTS FOR.
//
// The unstick timer compared the bot's position against an anchor that only
// advanced when the bot moved more than 2 blocks in a single 25s sample:
//
//   if (!lastMovePos || pos.distanceTo(lastMovePos) > 2) {
//     lastMovePos = pos.clone();
//     lastMoveAt = Date.now();
//
// A bot doing legitimate localised work -- mining out a vein, smelting at a
// furnace, building a wall, crafting -- drifts less than 2 blocks per sample, so
// the anchor never advanced, lastMoveAt never refreshed, and after 90 seconds it
// was declared stuck and dug out MID-ACTION.
//
// Measured live 2026-08-15 over 5.5 hours: 892 unstick events across 5 bots,
// about 178 each, which at a 90s floor is continuous firing for the entire
// session. In the same window the swarm completed 14 skills and earned zero
// advancements. The rescue meant to save wedged bots was interrupting every bot
// that was actually working.
//
// The fix is to compare against the PREVIOUS SAMPLE rather than a stale anchor.
// A bot doing anything at all moves more than a block in 25 seconds; a genuinely
// wedged bot does not move at all.

const P = (x: number, y: number, z: number) => ({ x, y, z });

test("a bot working within a small radius is not stuck", () => {
  // Mining a vein: never more than 2 blocks from where it started, but moving.
  let s = freshState(P(0, 64, 0), 0);
  let t = 0;
  for (const p of [P(1, 64, 0), P(0, 64, 1), P(1, 64, 1), P(0, 64, 0), P(1, 63, 0)]) {
    t += 25_000;
    s = sampleMovement(s, p, t);
  }
  assert.equal(isStuck(s, t, 90_000), false, "localised work must not read as stuck");
});

test("a genuinely wedged bot is detected", () => {
  let s = freshState(P(10, 70, 10), 0);
  let t = 0;
  for (let i = 0; i < 5; i++) {
    t += 25_000;
    s = sampleMovement(s, P(10, 70, 10), t);
  }
  assert.equal(isStuck(s, t, 90_000), true, "a bot that never moves at all is stuck");
});

test("sub-block jitter does not count as movement", () => {
  // Physics nudge, mob push, standing on a slab edge.
  let s = freshState(P(5, 64, 5), 0);
  let t = 0;
  for (const p of [P(5.2, 64, 5.1), P(5.05, 64, 4.95), P(5.1, 64, 5.2)]) {
    t += 25_000;
    s = sampleMovement(s, p, t);
  }
  assert.equal(isStuck(s, t, 60_000), true, "jitter is not progress");
});

test("one real move resets the clock", () => {
  let s = freshState(P(0, 64, 0), 0);
  let t = 0;
  for (let i = 0; i < 4; i++) {
    t += 25_000;
    s = sampleMovement(s, P(0, 64, 0), t);
  }
  assert.equal(isStuck(s, t, 90_000), true);
  t += 25_000;
  s = sampleMovement(s, P(20, 64, 20), t);
  assert.equal(isStuck(s, t, 90_000), false, "a bot that just moved is not stuck");
});

test("the threshold is per-sample, not cumulative from an anchor", () => {
  // Walking steadily but slowly: 1.5 blocks every sample. The old anchor logic
  // called this stuck because it never exceeded 2 from the ORIGINAL position.
  let s = freshState(P(0, 64, 0), 0);
  let t = 0;
  for (let i = 1; i <= 6; i++) {
    t += 25_000;
    s = sampleMovement(s, P(i * 1.5, 64, 0), t);
  }
  assert.equal(isStuck(s, t, 90_000), false, "steady slow travel is movement");
});

test("a descent counts as movement even with no horizontal change", () => {
  // strip_mine digging straight down.
  let s = freshState(P(0, 64, 0), 0);
  let t = 0;
  for (const y of [61, 58, 55, 52]) {
    t += 25_000;
    s = sampleMovement(s, P(0, y, 0), t);
  }
  assert.equal(isStuck(s, t, 90_000), false, "vertical progress is progress");
});

test("the first sample never reports stuck", () => {
  const s = freshState(P(0, 64, 0), 1000);
  assert.equal(isStuck(s, 1000, 90_000), false);
});

test("the per-sample threshold is under one block so slow work still counts", () => {
  assert.ok(SAMPLE_MOVE_BLOCKS <= 1, `threshold ${SAMPLE_MOVE_BLOCKS} would miss slow legitimate work`);
  assert.ok(SAMPLE_MOVE_BLOCKS > 0.5, `threshold ${SAMPLE_MOVE_BLOCKS} would count physics jitter as movement`);
});
