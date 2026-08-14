// src/skills/fluid.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { isSourceBlock, pickApproach } from "./fluid.js";

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

test("the approach position is adjacent, level, and never the fluid itself", () => {
  const source = { x: 10, y: 40, z: 10 };
  const stand = pickApproach({ x: 14, y: 40, z: 10 }, source);
  assert.ok(stand, "an approach must be found for an open source");
  const dx = Math.abs(stand.x - source.x);
  const dz = Math.abs(stand.z - source.z);
  assert.equal(stand.y, source.y, "stand level with the source, not above it");
  assert.ok(dx + dz === 1, `must be orthogonally adjacent, got dx=${dx} dz=${dz}`);
});

test("the approach is the side nearest the bot so it does not cross the pool", () => {
  const source = { x: 0, y: 40, z: 0 };
  assert.deepEqual(pickApproach({ x: 9, y: 40, z: 0 }, source), { x: 1, y: 40, z: 0 });
  assert.deepEqual(pickApproach({ x: -9, y: 40, z: 0 }, source), { x: -1, y: 40, z: 0 });
  assert.deepEqual(pickApproach({ x: 0, y: 40, z: 9 }, source), { x: 0, y: 40, z: 1 });
});

test("a bot already standing on the source is moved off it, not left there", () => {
  const source = { x: 5, y: 40, z: 5 };
  const stand = pickApproach(source, source);
  assert.ok(stand);
  assert.notDeepEqual(stand, source);
});
