import { test } from "node:test";
import assert from "node:assert/strict";

import { siteIsBuildable, findSite, findSiteFlexible, type BlockProbe } from "./portal-siting.js";
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

test("liquid in the INTERIOR is a veto — the portal cannot form in a puddle", () => {
  const inner = interiorPositions(origin, "x")[0];
  const puddle: BlockProbe = (p) => (p.x === inner.x && p.y === inner.y && p.z === inner.z ? "liquid" : flatGround(p));
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

// ── findSiteFlexible: both axes and a step of vertical tolerance ────────────
//
// One axis at exactly the bot's Y needs a flat shelf in a specific direction;
// around the village that failed at radius 6 every time it ran, and the model
// was told "move somewhere open" with nowhere concrete to go.

test("flexible siting finds a site one step below the centre", () => {
  // Bot stands on a one-block rise: ground is y<64 everywhere, so a frame
  // centred at y=66 (bot's feet y=65 + 1) only works one step down at y=65.
  const centre = { x: 0, y: 66, z: 0 };
  const site = findSiteFlexible(centre, flatGround, 4);
  assert.ok(site, "a site should exist one step below");
  assert.equal(site.origin.y, 65);
});

test("flexible siting falls back to the z axis when x is walled off", () => {
  // Two solid pillars where the x-frame's jambs would stand (x=-1 and x=2 at
  // z=0). The z-oriented frame lives entirely on the x=0 column and its own
  // jambs at z=-1/2, so it is untouched — only the orientation is blocked.
  const zOnly: BlockProbe = (p) => {
    if (p.y < 64) return "solid";
    if ((p.x === -1 || p.x === 2) && p.z === 0) return "solid";
    return "air";
  };
  const site = findSiteFlexible({ x: 0, y: 65, z: 0 }, zOnly, 0);
  assert.ok(site, "the z orientation should rescue the site");
  assert.equal(site.axis, "z");
});

test("flexible siting still reports null when nothing fits", () => {
  const allSolid: BlockProbe = () => "solid";
  assert.equal(findSiteFlexible({ x: 0, y: 65, z: 0 }, allSolid, 3), null);
});

test("a lava-filled FRAME cell is an asset", () => {
  // Blade carved a site at a pool's edge and the validator refused it over a
  // lava cell — the one block that casts itself once wet.
  const cell = framePositions(origin, "x")[0];
  const lavaInFrame: BlockProbe = (p) =>
    p.x === cell.x && p.y === cell.y && p.z === cell.z ? "liquid" : flatGround(p);
  assert.equal(siteIsBuildable(origin, "x", lavaInFrame), true);
});
