import { test } from "node:test";
import assert from "node:assert/strict";

import { siteIsBuildable, findSite, type BlockProbe } from "./portal-siting.js";
import { framePositions, interiorPositions } from "./portal-geometry.js";

// WHAT THIS FILE PINS DOWN.
//
// buildNetherPortal sited the frame at "two blocks east of wherever the bot is
// standing", with no check that the space was clear or that the floor had
// anything under it. A portal is a 4x5 volume; two east of a bot walking along
// a cliff or into a hillside is a frame that cannot be placed.
//
// That is the most expensive failure available to this skill. Each obsidian
// block costs a round trip to a lava pool because a bucket holds one fluid, so
// a badly sited frame burns ten trips and produces nothing.
//
// The probe is injected so this is testable without a server.

// origin is the bottom-left INTERIOR block, so it sits one above the frame's
// floor row, which in turn rests ON the ground surface. With solid ground up to
// y=63, the floor row is y=64 and the interior starts at y=65. Putting origin at
// y=64 would bury the floor row in the dirt.
const origin = { x: 0, y: 65, z: 0 };

/** A world that is solid below y=64 and air at or above it. */
const flatGround: BlockProbe = (p) => (p.y < 64 ? "solid" : "air");

test("flat open ground with support is buildable", () => {
  assert.equal(siteIsBuildable(origin, "x", flatGround), true);
});

test("a site with no floor support is rejected", () => {
  // Air all the way down: the floor row has nothing to place against.
  const voidBelow: BlockProbe = () => "air";
  assert.equal(siteIsBuildable(origin, "x", voidBelow), false);
});

test("a site blocked by terrain is rejected", () => {
  // Solid everywhere: the frame and interior have no room.
  const solidRock: BlockProbe = () => "solid";
  assert.equal(siteIsBuildable(origin, "x", solidRock), false);
});

test("one intruding block anywhere in the volume is enough to reject", () => {
  const inner = interiorPositions(origin, "x")[3];
  const oneBoulder: BlockProbe = (p) =>
    p.x === inner.x && p.y === inner.y && p.z === inner.z ? "solid" : flatGround(p);
  assert.equal(siteIsBuildable(origin, "x", oneBoulder), false);
});

test("lava or water in the volume is rejected, not treated as air", () => {
  const frame = framePositions(origin, "x")[0];
  const puddle: BlockProbe = (p) => (p.x === frame.x && p.y === frame.y && p.z === frame.z ? "liquid" : flatGround(p));
  assert.equal(siteIsBuildable(origin, "x", puddle), false);
});

test("obsidian already in a frame slot is fine — a resumed build", () => {
  const frame = framePositions(origin, "x")[0];
  const partial: BlockProbe = (p) =>
    p.x === frame.x && p.y === frame.y && p.z === frame.z ? "obsidian" : flatGround(p);
  assert.equal(siteIsBuildable(origin, "x", partial), true);
});

test("unknown blocks are refused rather than assumed clear", () => {
  // Unloaded chunks read as unknown. Building into one is how a frame ends up
  // half-placed with the lava already spent.
  const unloaded: BlockProbe = (p) => (p.y < 64 ? "solid" : "unknown");
  assert.equal(siteIsBuildable(origin, "x", unloaded), false);
});

test("findSite returns the nearest buildable spot on open ground", () => {
  const found = findSite({ x: 0, y: 65, z: 0 }, "x", flatGround, 4);
  assert.ok(found, "flat ground must yield a site");
  assert.equal(siteIsBuildable(found, "x", flatGround), true);
});

test("findSite gives up rather than returning an unbuildable site", () => {
  assert.equal(
    findSite({ x: 0, y: 65, z: 0 }, "x", () => "solid", 3),
    null,
  );
});

test("findSite searches outward, so a nearby clearing beats a distant one", () => {
  // Only a narrow band around x=2 is open; everything else is rock.
  const slot: BlockProbe = (p) => {
    if (p.y < 64) return "solid";
    return p.x >= 1 && p.x <= 5 ? "air" : "solid";
  };
  const found = findSite({ x: 0, y: 65, z: 0 }, "x", slot, 8);
  assert.ok(found, "the open band must be found");
  assert.ok(found.x >= 1 && found.x <= 5, `site ${found.x} should sit in the open band`);
});
