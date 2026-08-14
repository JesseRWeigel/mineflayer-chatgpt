// src/skills/portal-geometry.ts
//
// Where the obsidian goes.
//
// Pure arithmetic, deliberately separated from the skill that places blocks:
// each obsidian block costs a round trip to a lava pool, so an off-by-one here
// is the most expensive class of bug available to a bot at iron tier.
//
// `origin` is the bottom-left INTERIOR block. Corners are omitted, which is
// legal and makes the frame 10 blocks instead of 14.

import type { Vec3Like } from "./fluid.js";

export const PORTAL_OBSIDIAN = 10;

const WIDTH = 2; // interior
const HEIGHT = 3; // interior

/** Offset helper: `w` runs along the portal's width axis, `h` is vertical. */
function at(origin: Vec3Like, axis: "x" | "z", w: number, h: number): Vec3Like {
  return axis === "x"
    ? { x: origin.x + w, y: origin.y + h, z: origin.z }
    : { x: origin.x, y: origin.y + h, z: origin.z + w };
}

export function interiorPositions(origin: Vec3Like, axis: "x" | "z"): Vec3Like[] {
  const out: Vec3Like[] = [];
  for (let h = 0; h < HEIGHT; h++) for (let w = 0; w < WIDTH; w++) out.push(at(origin, axis, w, h));
  return out;
}

export function framePositions(origin: Vec3Like, axis: "x" | "z"): Vec3Like[] {
  const out: Vec3Like[] = [];
  for (let w = 0; w < WIDTH; w++) {
    out.push(at(origin, axis, w, -1)); // floor
    out.push(at(origin, axis, w, HEIGHT)); // lintel
  }
  for (let h = 0; h < HEIGHT; h++) {
    out.push(at(origin, axis, -1, h)); // left jamb
    out.push(at(origin, axis, WIDTH, h)); // right jamb
  }
  return out;
}

/** Flint and steel is struck on the bottom-left interior square. */
export function ignitionTarget(origin: Vec3Like, axis: "x" | "z"): Vec3Like {
  return at(origin, axis, 0, 0);
}
