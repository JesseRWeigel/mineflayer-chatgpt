// src/skills/portal-geometry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { framePositions, interiorPositions, ignitionTarget, PORTAL_OBSIDIAN } from "./portal-geometry.js";

// WHAT THIS FILE PINS DOWN.
//
// A Nether portal is 4 wide by 5 tall with the four corners optional, so the
// cheapest legal frame is 10 obsidian around a 2x3 interior. Getting this wrong
// costs the swarm 10 round trips to a lava pool per attempt, which at iron tier
// with one bucket is the most expensive mistake available to it.
//
// Corners are deliberately excluded: including them would make the frame 14
// blocks, a 40% increase in casting trips for no gameplay benefit.

const origin = { x: 100, y: 64, z: 200 };

test("the cheapest legal frame is ten blocks", () => {
  assert.equal(PORTAL_OBSIDIAN, 10);
  assert.equal(framePositions(origin, "x").length, 10);
  assert.equal(framePositions(origin, "z").length, 10);
});

test("the interior is two wide and three tall", () => {
  const inner = interiorPositions(origin, "x");
  assert.equal(inner.length, 6);
  assert.equal(new Set(inner.map((p) => p.y)).size, 3, "three distinct heights");
});

test("no corner is included in the frame", () => {
  const frame = framePositions(origin, "x");
  // Corners sit diagonally out from the interior at both bottom and top.
  for (const corner of [
    { x: origin.x - 1, y: origin.y - 1, z: origin.z },
    { x: origin.x + 2, y: origin.y - 1, z: origin.z },
    { x: origin.x - 1, y: origin.y + 3, z: origin.z },
    { x: origin.x + 2, y: origin.y + 3, z: origin.z },
  ]) {
    assert.ok(
      !frame.some((p) => p.x === corner.x && p.y === corner.y && p.z === corner.z),
      `corner ${JSON.stringify(corner)} must not be in the frame`,
    );
  }
});

test("frame and interior never overlap", () => {
  const frame = framePositions(origin, "x").map((p) => `${p.x},${p.y},${p.z}`);
  const inner = interiorPositions(origin, "x").map((p) => `${p.x},${p.y},${p.z}`);
  assert.equal(frame.filter((p) => inner.includes(p)).length, 0);
});

test("the frame is a closed ring around the interior", () => {
  const frame = framePositions(origin, "x");
  const inner = interiorPositions(origin, "x");
  // Every interior block has all four orthogonal neighbours either interior or frame.
  const known = new Set([...frame, ...inner].map((p) => `${p.x},${p.y},${p.z}`));
  for (const p of inner) {
    for (const d of [
      { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
    ]) {
      assert.ok(
        known.has(`${p.x + d.x},${p.y + d.y},${p.z}`),
        `interior ${p.x},${p.y} has an open side at ${d.x},${d.y}`,
      );
    }
  }
});

test("the z-axis portal is the x-axis portal rotated, not translated", () => {
  const fx = framePositions(origin, "x");
  const fz = framePositions(origin, "z");
  assert.equal(new Set(fx.map((p) => p.x)).size, 4, "x-axis portal varies in x");
  assert.equal(new Set(fz.map((p) => p.z)).size, 4, "z-axis portal varies in z");
  assert.equal(new Set(fz.map((p) => p.x)).size, 1, "z-axis portal is flat in x");
});

test("ignition targets a block inside the frame, at the bottom", () => {
  const t = ignitionTarget(origin, "x");
  assert.equal(t.y, origin.y, "strike the bottom row of the interior");
  const inner = interiorPositions(origin, "x");
  assert.ok(inner.some((p) => p.x === t.x && p.y === t.y && p.z === t.z));
});
