import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chestPlacementOffsets,
  CHEST_MIN_RING,
  CHEST_MAX_RING,
  CHEST_NEIGHBOUR_OFFSETS,
  summarizeDepositFailure,
  shouldAttemptExpansion,
  obstructsChest,
  canClearObstruction,
  bestToolFor,
  type DepositFailure,
} from "./stash.js";

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

// The three sites that abandon a category all printed "No reachable chest", so a
// 596-event failure mode was unattributable. These lock in that the causes stay
// distinguishable and that the dominant one leads.
test("summarizeDepositFailure names the dominant cause first", () => {
  const failures = new Map<DepositFailure, number>([
    ["chest_open_failed", 3],
    ["no_chest_found", 9],
  ]);
  const msg = summarizeDepositFailure(failures);
  assert.match(msg, /^9 no chest serves that category/);
  assert.match(msg, /3 the chest wouldn't open/);
});

test("summarizeDepositFailure keeps the three causes distinct", () => {
  const wordings = (["no_chest_found", "chest_unreachable", "chest_open_failed"] as DepositFailure[]).map((r) =>
    summarizeDepositFailure(new Map([[r, 1]])),
  );
  assert.equal(new Set(wordings).size, 3, "each cause must read differently or the log stays ambiguous");
});

test("summarizeDepositFailure omits zero-count causes", () => {
  const msg = summarizeDepositFailure(
    new Map<DepositFailure, number>([
      ["no_chest_found", 0],
      ["chest_unreachable", 4],
    ]),
  );
  assert.equal(msg, "4 couldn't walk to the chest");
});

// Expansion fired 18 times against 0 no_chest_found failures, burning a 45s
// placement budget each time on a chest shortage that did not exist. Adding a
// chest cannot make an already-located adjacent chest open.
test("expansion only when a category genuinely had no chest", () => {
  assert.equal(shouldAttemptExpansion(new Map([["no_chest_found", 1]])), true);
  assert.equal(shouldAttemptExpansion(new Map([["chest_open_failed", 18]])), false);
  assert.equal(shouldAttemptExpansion(new Map([["chest_unreachable", 20]])), false);
});

test("expansion still fires when a real shortage is mixed with other causes", () => {
  const mixed = new Map<DepositFailure, number>([
    ["chest_open_failed", 18],
    ["chest_unreachable", 20],
    ["no_chest_found", 2],
  ]);
  assert.equal(shouldAttemptExpansion(mixed), true);
});

test("no failures means no expansion", () => {
  assert.equal(shouldAttemptExpansion(new Map()), false);
  assert.equal(shouldAttemptExpansion(new Map([["no_chest_found", 0]])), false);
});

// 77 of 78 attributed deposit failures had an opaque block directly above the
// chest (47 cobblestone, 30 oak_planks, 1 air). Minecraft will not open a chest
// under an opaque block, which produced both attributed causes at once.
test("obstructsChest flags what actually landed on the stash", () => {
  assert.equal(obstructsChest("cobblestone"), true);
  assert.equal(obstructsChest("oak_planks"), true);
  assert.equal(obstructsChest("oak_stairs"), true);
  assert.equal(obstructsChest("air"), false);
  assert.equal(obstructsChest("water"), false);
});

test("obstructsChest treats unknown blocks as obstructing", () => {
  // Erring the other way costs another silent 10s openContainer timeout.
  assert.equal(obstructsChest("some_modded_slab"), true);
});

test("obstructsChest ignores unloaded chunks", () => {
  assert.equal(obstructsChest(undefined), false);
  assert.equal(obstructsChest(null), false);
});

// The drowning dig-out once destroyed a team chest to save one bot. Never trade
// storage for a deposit.
test("canClearObstruction refuses to break valuables", () => {
  assert.equal(canClearObstruction("chest"), false);
  assert.equal(canClearObstruction("trapped_chest"), false);
  assert.equal(canClearObstruction("furnace"), false);
  assert.equal(canClearObstruction("bed"), false);
  assert.equal(canClearObstruction("bedrock"), false);
});

test("canClearObstruction allows ordinary build blocks", () => {
  assert.equal(canClearObstruction("cobblestone"), true);
  assert.equal(canClearObstruction("oak_planks"), true);
  assert.equal(canClearObstruction("dirt"), true);
  assert.equal(canClearObstruction("air"), false);
});

// Hand-breaking cobblestone takes ~11s, which would relocate the stall rather
// than remove it. mineflayer-tool is not loaded, so the pick is ours to make.
test("bestToolFor matches tool kind to the block", () => {
  assert.equal(bestToolFor("cobblestone", ["iron_pickaxe", "iron_axe"]), "iron_pickaxe");
  assert.equal(bestToolFor("oak_planks", ["iron_pickaxe", "iron_axe"]), "iron_axe");
  assert.equal(bestToolFor("oak_stairs", ["stone_axe"]), "stone_axe");
  assert.equal(bestToolFor("dirt", ["iron_shovel"]), "iron_shovel");
});

test("bestToolFor prefers the best material the bot actually carries", () => {
  assert.equal(bestToolFor("cobblestone", ["wooden_pickaxe", "iron_pickaxe"]), "iron_pickaxe");
  assert.equal(bestToolFor("cobblestone", ["wooden_pickaxe"]), "wooden_pickaxe");
});

test("bestToolFor returns null when no suitable tool is carried", () => {
  assert.equal(bestToolFor("cobblestone", ["iron_axe", "bread"]), null);
  assert.equal(bestToolFor("wool", ["iron_pickaxe"]), null);
});

// The substring version classified oak_stairs as open sky because "stairs"
// contains "air", silently skipping the dig for 47 of the observed obstructions.
test("obstructsChest matches tokens, not substrings", () => {
  assert.equal(obstructsChest("oak_stairs"), true, "stairs contains 'air'");
  assert.equal(obstructsChest("grass_block"), true, "solid grass_block is not tall_grass");
  assert.equal(obstructsChest("snow_block"), true);
  assert.equal(obstructsChest("cave_air"), false);
  assert.equal(obstructsChest("tall_grass"), false);
  assert.equal(obstructsChest("oak_wall_sign"), false);
});
