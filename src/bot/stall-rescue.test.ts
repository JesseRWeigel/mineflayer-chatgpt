import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isStallResult,
  shouldForceDigOut,
  pruneStalls,
  STALL_RESCUE_THRESHOLD,
  STALL_WINDOW_MS,
} from "./stall-rescue.js";

// 204 stalls in 52 minutes, 111 at one spot four blocks from the stash and
// three below it, cobblestone on three sides. maxDropDown=3 lets a bot walk
// into that; safeMoves forbids digging and towers, so it cannot climb out.
test("recognises every way the bot reports failing to get somewhere", () => {
  for (const r of [
    "Stuck — not making progress toward goal.",
    "Action failed: Navigation timed out — goal may be unreachable.",
    "Action failed: No path to the goal!",
    "Action failed: Path was stopped before it could be completed! Thus, the desired goal was not reached.",
  ]) {
    assert.equal(isStallResult(r), true, `should count as a stall: ${r.slice(0, 40)}`);
  }
});

// A refusal the bot chose is not a bot that is trapped. Digging in response
// would be pointless vandalism, and these two were 71 of one session's failures.
test("a chosen refusal is not a stall", () => {
  assert.equal(isStallResult('Blocked: "mine_block" recently failed. Try something else.'), false);
  assert.equal(isStallResult('Action "mine_block" not allowed for Blade. Use: attack, flee, go_to'), false);
});

test("success is never a stall", () => {
  assert.equal(isStallResult("Mined 4x iron_ore (vein)."), false);
  assert.equal(isStallResult("Deposited 12 items at the stash."), false);
  assert.equal(isStallResult(""), false);
});

const NOW = 1_800_000_000_000;
const agoMs = (ms: number) => NOW - ms;

test("rescues on a rate, not on a run", () => {
  // One stall is ordinary. Five inside three minutes means the bot cannot reach
  // anything, whether or not it managed an eat or an idle in between.
  assert.equal(shouldForceDigOut([NOW], NOW), false);
  const nearMiss = Array.from({ length: STALL_RESCUE_THRESHOLD - 1 }, (_, i) => agoMs(i * 1000));
  assert.equal(shouldForceDigOut(nearMiss, NOW), false);
  const enough = Array.from({ length: STALL_RESCUE_THRESHOLD }, (_, i) => agoMs(i * 1000));
  assert.equal(shouldForceDigOut(enough, NOW), true);
});

// The old rule wanted CONSECUTIVE stalls, so any success in between reset it.
// Across one 2h38m session it fired 23 times against 749 stalls: 3%.
test("interleaved successes no longer disarm the rescue", () => {
  // These five stalls are spread over two minutes with other actions between
  // them. Consecutive counting saw a run of one, over and over.
  const spread = [agoMs(110_000), agoMs(90_000), agoMs(60_000), agoMs(30_000), agoMs(5_000)];
  assert.equal(shouldForceDigOut(spread, NOW), true);
});

test("old stalls fall out of the window", () => {
  // A bot that stalled five times an hour ago and is now fine must not dig.
  const stale = Array.from({ length: 8 }, (_, i) => agoMs(STALL_WINDOW_MS + 60_000 + i * 1000));
  assert.equal(shouldForceDigOut(stale, NOW), false);
  assert.equal(pruneStalls(stale, NOW).length, 0);
});

test("pruning keeps only what is still inside the window", () => {
  const mixed = [agoMs(STALL_WINDOW_MS + 10_000), agoMs(20_000), agoMs(1_000)];
  assert.equal(pruneStalls(mixed, NOW).length, 2);
});

test("threshold stays low enough to matter at the observed rate", () => {
  // 749 stalls in 2h38m is roughly five a minute for the worst bot.
  assert.ok(STALL_RESCUE_THRESHOLD <= 6, `${STALL_RESCUE_THRESHOLD} is too slow to rescue anything`);
});

// Measured per-bot stall rates over a 5h40m session. Forge was demonstrably
// wedged (51 stalls at one 1x1 cobblestone shaft) yet sat below the old
// 1.67/min bar, so the rescue fired 22 times against 802 stalls.
test("catches a bot grinding at the observed stuck rate", () => {
  // Forge: 1.19 stalls/min sustained.
  const forge = Array.from({ length: 6 }, (_, i) => NOW - i * 50_000); // ~1.2/min
  assert.equal(shouldForceDigOut(forge, NOW), true, "a sustained grind must trigger the rescue");
});

test("leaves the healthy bots alone", () => {
  // Mason 0.39/min, Blade 0.33, Atlas 0.26, Flora 0.19 — none were looping.
  const mason = Array.from({ length: 2 }, (_, i) => NOW - i * 150_000); // ~0.4/min
  assert.equal(shouldForceDigOut(mason, NOW), false);
});

test("the window is wide enough for a grind, not just a burst", () => {
  assert.ok(STALL_WINDOW_MS >= 5 * 60 * 1000, "3 minutes demanded 1.67/min and missed a 1.19/min grind");
});
