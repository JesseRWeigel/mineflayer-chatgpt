import { test } from "node:test";
import assert from "node:assert/strict";

import { isAcceptableRespawn, respawnTarget, MAX_SPAWN_ELEVATION_ABOVE_STASH } from "./respawn.js";

const STASH = { x: 286, y: 70, z: -314 };

// The measured failure: 49 spawnpoints set at y=114-121 against a y=70 stash,
// after which Forge died 29 times, 28 of them falls, from those same heights.
test("rejects the mountain peaks spreadplayers actually chose", () => {
  for (const y of [114, 115, 117, 118, 119, 120, 121]) {
    assert.equal(isAcceptableRespawn(y, STASH.y), false, `y=${y} is ${y - STASH.y} above the stash`);
  }
});

test("accepts ground at or near the stash", () => {
  assert.equal(isAcceptableRespawn(70, STASH.y), true);
  assert.equal(isAcceptableRespawn(78, STASH.y), true);
  assert.equal(isAcceptableRespawn(70 + MAX_SPAWN_ELEVATION_ABOVE_STASH, STASH.y), true, "boundary is inclusive");
  assert.equal(isAcceptableRespawn(70 + MAX_SPAWN_ELEVATION_ABOVE_STASH + 1, STASH.y), false);
});

test("spawning below the stash is fine — the danger is height, not distance", () => {
  // Bots strip-mine well below the base. Walking up is survivable; falling is not.
  assert.equal(isAcceptableRespawn(20, STASH.y), true);
  assert.equal(isAcceptableRespawn(-40, STASH.y), true);
});

test("a too-high landing redirects to the stash", () => {
  const landed = { x: 280, y: 119, z: -322 };
  assert.deepEqual(respawnTarget(landed, STASH), STASH);
});

test("an acceptable landing is kept as-is", () => {
  const landed = { x: 300, y: 74, z: -300 };
  assert.deepEqual(respawnTarget(landed, STASH), landed);
});

test("no known stash means keep the landing rather than have no spawn at all", () => {
  const landed = { x: 280, y: 119, z: -322 };
  assert.deepEqual(respawnTarget(landed, undefined), landed);
});
