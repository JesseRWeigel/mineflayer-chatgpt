import { test } from "node:test";
import assert from "node:assert/strict";

import { isStallResult, shouldForceDigOut, STALL_RESCUE_THRESHOLD } from "./stall-rescue.js";

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

test("rescues only after a run of stalls, not on the first", () => {
  // One stall is ordinary. Three in a row means the bot cannot reach anything.
  assert.equal(shouldForceDigOut(1), false);
  assert.equal(shouldForceDigOut(STALL_RESCUE_THRESHOLD - 1), false);
  assert.equal(shouldForceDigOut(STALL_RESCUE_THRESHOLD), true);
  assert.equal(shouldForceDigOut(STALL_RESCUE_THRESHOLD + 5), true);
});

test("threshold is low enough to matter at the observed rate", () => {
  // 204 stalls in 52 minutes is roughly four a minute. A threshold in the tens
  // would leave a bot trapped for most of an hour.
  assert.ok(STALL_RESCUE_THRESHOLD <= 5, `${STALL_RESCUE_THRESHOLD} is too slow to rescue anything`);
});
