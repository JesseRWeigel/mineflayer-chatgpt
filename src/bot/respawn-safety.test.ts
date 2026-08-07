import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldFleeOnRespawn, RESPAWN_DANGER_RADIUS } from "./respawn-safety.js";

// Across one 9h25m session the first action after a death was explore 23 times,
// go_to 13, mine_block 5, attack 3, and flee ZERO times. Flora died three times
// in 76 seconds at y=69 with the stash at y=70, respawning next to the zombie
// that had just killed her. Her role has flee but no attack.
test("a hostile standing at the respawn point means run first", () => {
  assert.equal(shouldFleeOnRespawn(1), true, "killed by the mob you woke up next to");
  assert.equal(shouldFleeOnRespawn(RESPAWN_DANGER_RADIUS), true, "boundary is inclusive");
});

test("a distant hostile does not interrupt work", () => {
  // Fleeing from everything would stop the swarm doing anything at night.
  assert.equal(shouldFleeOnRespawn(RESPAWN_DANGER_RADIUS + 0.1), false);
  assert.equal(shouldFleeOnRespawn(40), false);
});

test("no hostile means resume normally", () => {
  assert.equal(shouldFleeOnRespawn(null), false);
});

test("an unmeasured distance never triggers a flee", () => {
  // A NaN here would send every respawning bot running for no reason.
  assert.equal(shouldFleeOnRespawn(Number.NaN), false);
  assert.equal(shouldFleeOnRespawn(Infinity), false);
});

test("radius is wide enough to cover a mob that just killed you", () => {
  // Zombie aggro range is 16 blocks; respawn is within a couple of blocks of the
  // stash. A radius under ~8 would miss the case this exists for.
  assert.ok(RESPAWN_DANGER_RADIUS >= 8, `${RESPAWN_DANGER_RADIUS} is too tight to catch the killer`);
});
