/**
 * Where to put the portal.
 *
 * buildNetherPortal sited the frame two blocks east of wherever the bot happened
 * to be standing, with no check that the space was clear or that the floor row
 * had anything to rest on. A portal is a 4x5 volume; two east of a bot walking
 * a ridge line is a frame that cannot be placed.
 *
 * This is the most expensive mistake this skill can make. Each obsidian block
 * costs a round trip to a lava pool, because a bucket holds one fluid, so a
 * badly sited frame burns ten trips and yields nothing.
 *
 * The world is reached through an injected probe so the decision is pure and
 * testable without a server.
 */

import { framePositions, interiorPositions } from "./portal-geometry.js";
import type { Vec3Like } from "./fluid.js";

export type BlockKind = "air" | "solid" | "liquid" | "obsidian" | "unknown";
export type BlockProbe = (p: Vec3Like) => BlockKind;

/** Can the frame and its interior actually be built here? */
export function siteIsBuildable(origin: Vec3Like, axis: "x" | "z", probe: BlockProbe): boolean {
  const frame = framePositions(origin, axis);

  // Frame slots may be empty, already obsidian (a resumed build), or LAVA —
  // a lava-filled frame cell is a gift, since wetting it casts the obsidian
  // in place. Blade carved a site at a pool's edge and the validator refused
  // it over exactly such a cell. Water still disqualifies: wetting cannot
  // turn water to obsidian, only displace the frame.
  for (const p of frame) {
    const k = probe(p);
    if (k !== "air" && k !== "obsidian" && k !== "liquid") return false;
  }

  // The interior must be genuinely clear; the portal fills it.
  for (const p of interiorPositions(origin, axis)) {
    if (probe(p) !== "air") return false;
  }

  // Every floor slot needs something to place against. bot.placeBlock builds
  // off an existing face, so a floor row over a void cannot be started.
  for (const p of frame) {
    if (p.y !== origin.y - 1) continue;
    if (probe({ x: p.x, y: p.y - 1, z: p.z }) !== "solid") return false;
  }

  return true;
}

/**
 * Nearest buildable site to `centre`, searched outward in rings.
 *
 * Outward order matters: the bot walks to wherever this points, and every
 * block of that walk is time not spent hauling lava.
 */
export function findSite(centre: Vec3Like, axis: "x" | "z", probe: BlockProbe, radius: number): Vec3Like | null {
  for (let r = 0; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        // Only the shell of each ring; the interior was covered by smaller r.
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const candidate = { x: centre.x + dx, y: centre.y, z: centre.z + dz };
        if (siteIsBuildable(candidate, axis, probe)) return candidate;
      }
    }
  }
  return null;
}

/**
 * Why is this origin not buildable? The first offending cell, named — the
 * carve fallback ran once in the wild and the re-probe still failed with no
 * way to tell whether the digger ran out of budget, the floor lacks support,
 * or a chunk read came back unknown.
 */
export function firstObstacle(origin: Vec3Like, axis: "x" | "z", probe: BlockProbe): string | null {
  for (const p of framePositions(origin, axis)) {
    const k = probe(p);
    if (k !== "air" && k !== "obsidian" && k !== "liquid") return `frame cell ${p.x},${p.y},${p.z} is ${k}`;
  }
  for (const p of interiorPositions(origin, axis)) {
    const k = probe(p);
    if (k !== "air") return `interior cell ${p.x},${p.y},${p.z} is ${k}`;
  }
  for (const p of framePositions(origin, axis)) {
    if (p.y !== origin.y - 1) continue;
    const k = probe({ x: p.x, y: p.y - 1, z: p.z });
    if (k !== "solid") return `floor support under ${p.x},${p.y},${p.z} is ${k}`;
  }
  return null;
}

/**
 * findSite, but willing to bend: either frame orientation, and a step up or
 * down from the centre's level. One axis at exactly the bot's Y needs a flat
 * 4-block shelf with five clear above it in a specific direction — around the
 * village that condition failed at radius 6 every time it ran, and the model
 * was told "move somewhere open" with nowhere concrete to go. Rings stay
 * outermost so a near site in any variant beats a far site in the preferred
 * one; the walk there is time not spent hauling lava.
 */
export function findSiteFlexible(
  centre: Vec3Like,
  probe: BlockProbe,
  radius: number,
): { origin: Vec3Like; axis: "x" | "z" } | null {
  for (let r = 0; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, 1, -1]) {
          const candidate = { x: centre.x + dx, y: centre.y + dy, z: centre.z + dz };
          for (const axis of ["x", "z"] as const) {
            if (siteIsBuildable(candidate, axis, probe)) return { origin: candidate, axis };
          }
        }
      }
    }
  }
  return null;
}
