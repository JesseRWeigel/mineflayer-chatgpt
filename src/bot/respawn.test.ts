import { test } from "node:test";
import assert from "node:assert/strict";

import { isAcceptableRespawn, respawnTarget, isAtBase, MAX_SPAWN_ELEVATION_ABOVE_STASH } from "./respawn.js";

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

// The regression: ae5325a sent respawns home to the y=70 stash, and the
// surface-rescue check (absolute `pos.y < 100`) then judged every arriving bot
// trapped underground, teleported it to y=200, and dropped it on a peak at
// y=118-121. The guard fired 44 times in one hour and Forge still died 24 times.
test("standing at the stash is home, not lost underground", () => {
  assert.equal(isAtBase({ x: 286, y: 70, z: -314 }, STASH), true);
  assert.equal(isAtBase({ x: 290, y: 72, z: -310 }, STASH), true, "working a few blocks from the chests");
  assert.equal(isAtBase({ x: 286, y: 62, z: -314 }, STASH), true, "just below the stash floor");
});

test("genuinely lost bots still qualify for rescue", () => {
  assert.equal(isAtBase({ x: 286, y: 20, z: -314 }, STASH), false, "deep in a cave under the base");
  assert.equal(isAtBase({ x: 500, y: 70, z: -314 }, STASH), false, "same height, far away");
  assert.equal(isAtBase({ x: 286, y: 70, z: -600 }, STASH), false);
});

test("no known stash means the old behaviour stands", () => {
  // Without a base there is nothing to be "at", so the height test decides.
  assert.equal(isAtBase({ x: 286, y: 70, z: -314 }, undefined), false);
});

test("base check uses horizontal distance, not a bounding box", () => {
  // Diagonal corner of a 24-block box is ~34 away and should not count.
  assert.equal(isAtBase({ x: 286 + 24, y: 70, z: -314 + 24 }, STASH), false);
  assert.equal(isAtBase({ x: 286 + 24, y: 70, z: -314 }, STASH), true, "exactly on the radius");
});
