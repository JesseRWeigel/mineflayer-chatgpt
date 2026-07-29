import { test } from "node:test";
import assert from "node:assert/strict";

import { chestPlacementOffsets, CHEST_MIN_RING, CHEST_MAX_RING, CHEST_NEIGHBOUR_OFFSETS } from "./stash.js";

// Regression: the original scan walked dx 10..16 with dz -2..2, which is a 7x5
// strip on the +X side of the stash only. Once that strip filled with base
// buildings, expansion became impossible no matter how many chests a bot
// carried. It surfaced as "All stash chests are full! Need more chests" and
// sent four rounds of fixes chasing chest supply. Measured before the fix: 41
// of 55 expansion attempts failed with a chest already in hand.

test("placement search covers every horizontal direction", () => {
  const offsets = chestPlacementOffsets();

  const hasNegX = offsets.some(([dx]) => dx < 0);
  const hasPosX = offsets.some(([dx]) => dx > 0);
  const hasNegZ = offsets.some(([, , dz]) => dz < 0);
  const hasPosZ = offsets.some(([, , dz]) => dz > 0);

  assert.ok(hasNegX, "search never looks in -X (the original one-directional bug)");
  assert.ok(hasPosX, "search never looks in +X");
  assert.ok(hasNegZ, "search never looks in -Z");
  assert.ok(hasPosZ, "search never looks in +Z");
});

test("placement search reaches all four quadrants", () => {
  const offsets = chestPlacementOffsets();
  const quadrant = (sx: number, sz: number) =>
    offsets.some(([dx, , dz]) => Math.sign(dx) === sx && Math.sign(dz) === sz);

  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    assert.ok(quadrant(sx, sz), `no candidate in quadrant (${sx}, ${sz})`);
  }
});

test("placement search respects the ring bounds", () => {
  const offsets = chestPlacementOffsets();

  for (const [dx, , dz] of offsets) {
    const ring = Math.max(Math.abs(dx), Math.abs(dz));
    assert.ok(ring >= CHEST_MIN_RING, `candidate at ring ${ring} crowds the stash rows`);
    assert.ok(ring <= CHEST_MAX_RING, `candidate at ring ${ring} is beyond the search radius`);
  }
});

test("placement search is ordered nearest ring first", () => {
  const rings = chestPlacementOffsets().map(([dx, , dz]) => Math.max(Math.abs(dx), Math.abs(dz)));

  for (let i = 1; i < rings.length; i++) {
    assert.ok(rings[i] >= rings[i - 1], "rings must be emitted in ascending order");
  }
});

test("placement search offers meaningfully more spots than the old strip", () => {
  // The old scan produced 35 candidates, all on one side.
  const offsets = chestPlacementOffsets();
  assert.ok(offsets.length > 35 * 10, `only ${offsets.length} candidates`);
});

test("placement search allows slight vertical tolerance for uneven ground", () => {
  const ys = new Set(chestPlacementOffsets().map(([, dy]) => dy));

  assert.ok(ys.has(0));
  assert.ok(ys.has(1) || ys.has(-1), "no vertical tolerance for uneven terrain");
});

// Regression: chest placement decayed to 10% success as the stash ring filled.
// The diagnostic showed 11 of 14 failures with the target in reach and in plain
// sight (sight=visible in=chest) — the bot standing among a dense chest cluster.
// Placing beside an existing chest forms a double chest, and a chest already
// paired into a double silently rejects the placement, so placeBlock never
// resolves. Candidate spots must therefore avoid chest neighbours.
test("chest neighbour offsets cover all four horizontal directions", () => {
  const dirs = CHEST_NEIGHBOUR_OFFSETS;

  assert.equal(dirs.length, 4, "a chest pairs horizontally in exactly four directions");
  assert.ok(dirs.some(([dx, dz]) => dx === 1 && dz === 0));
  assert.ok(dirs.some(([dx, dz]) => dx === -1 && dz === 0));
  assert.ok(dirs.some(([dx, dz]) => dx === 0 && dz === 1));
  assert.ok(dirs.some(([dx, dz]) => dx === 0 && dz === -1));

  // Diagonals do NOT pair into a double chest, so excluding them would
  // needlessly discard valid spots.
  assert.ok(!dirs.some(([dx, dz]) => dx !== 0 && dz !== 0), "diagonals do not form double chests");
});
