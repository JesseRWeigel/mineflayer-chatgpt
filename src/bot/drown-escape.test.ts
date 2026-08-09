import { test } from "node:test";
import assert from "node:assert/strict";

import { chooseDrownEscape, ESCAPE_DIRECTIONS } from "./drown-escape.js";

const solid = (name: string) => ({ name, boundingBox: "block" as const });
const empty = (name = "water") => ({ name, boundingBox: "empty" as const });

// THE BUG THIS FILE EXISTS FOR.
//
// The drowning dig-out only ever looked straight up. When that one block was
// precious it logged "will not dig it" and gave up, leaving the bot to swim
// against a ceiling until it died — with three untouched stone walls beside it.
//
// Mason drowned 5 times and Atlas 4 times in a single hour, all within a few
// blocks of the stash, and the log says exactly why:
//
//   [Drown] Mason enclosed at air=1 but ceiling is chest — will not dig it
//   [Drown] Mason enclosed at air=0 but ceiling is chest — will not dig it
//   [Drown] Mason air=0 at (290,70,-312) shore=289,71,-313 pathfinderStopped=true
//
// The guard is right that team storage must not be destroyed. It was wrong that
// refusing costs "one respawn": the bot respawns, walks back to the same pocket
// under the same chest, and drowns again. The swarm banked 0 items that hour,
// so the storage the guard protects was producing nothing while two bots looped.
//
// Refusing to dig the chest is still correct. Refusing to LOOK ANYWHERE ELSE
// is what killed them.
test("digs a side wall rather than giving up under a chest", () => {
  const escape = chooseDrownEscape({
    up: solid("chest"),
    north: solid("stone"),
    south: solid("chest"),
    east: solid("chest"),
    west: solid("chest"),
  });
  assert.equal(escape?.direction, "north");
  assert.equal(escape?.block.name, "stone");
});

test("prefers up when up is ordinary — it is the shortest path to air", () => {
  const escape = chooseDrownEscape({
    up: solid("stone"),
    north: solid("dirt"),
    south: solid("dirt"),
    east: solid("dirt"),
    west: solid("dirt"),
  });
  assert.equal(escape?.direction, "up");
});

test("never digs a precious block, however desperate", () => {
  const escape = chooseDrownEscape({
    up: solid("chest"),
    north: solid("furnace"),
    south: solid("bedrock"),
    east: solid("crafting_table"),
    west: solid("barrel"),
  });
  assert.equal(escape, null, "all routes precious must yield nothing to dig, not a chest");
});

// Water and air are not obstacles, so digging them is wasted air. The bot is
// already swimming through them.
test("open blocks are not escape routes", () => {
  const escape = chooseDrownEscape({
    up: empty("water"),
    north: empty("water"),
    south: empty("air"),
    east: solid("stone"),
    west: empty("water"),
  });
  assert.equal(escape?.direction, "east", "the only solid wall is the only thing worth digging");
});

test("nothing solid anywhere means nothing to dig", () => {
  assert.equal(
    chooseDrownEscape({
      up: empty(),
      north: empty(),
      south: empty(),
      east: empty(),
      west: empty(),
    }),
    null,
  );
});

// A missing block is an unloaded chunk, not a wall. Digging at it would waste
// the remaining air on a block the client cannot even see.
test("unknown blocks are not dug", () => {
  const escape = chooseDrownEscape({ up: null, north: null, south: solid("stone"), east: null, west: null });
  assert.equal(escape?.direction, "south");
  assert.equal(chooseDrownEscape({ up: null, north: null, south: null, east: null, west: null }), null);
});

// Up first, then the sides. Down is deliberately absent: digging down in water
// floods the new hole and moves the bot further from air.
test("up is tried first and down is never tried", () => {
  assert.equal(ESCAPE_DIRECTIONS[0], "up");
  assert.ok(!ESCAPE_DIRECTIONS.includes("down" as never), "digging down moves away from air");
  assert.equal(ESCAPE_DIRECTIONS.length, 5);
});
