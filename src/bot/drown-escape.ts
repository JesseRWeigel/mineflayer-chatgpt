// src/bot/drown-escape.ts
// Which block a drowning, enclosed bot should dig to get out.
//
// The dig-out looked straight up and nowhere else. When that block was precious
// it logged "will not dig it" and gave up, and the bot swam against the ceiling
// until it died — with three untouched stone walls beside it.
//
//   [Drown] Mason enclosed at air=1 but ceiling is chest — will not dig it
//   [Drown] Mason air=0 at (290,70,-312) shore=289,71,-313 pathfinderStopped=true
//
// Mason drowned 5 times and Atlas 4 times in one hour that way, all a few blocks
// from the stash. Not digging the chest is still right; not looking anywhere
// else is what killed them.

import { isPreciousBlock } from "./navigation.js";

/**
 * Up first — it is the shortest path to air. Down is deliberately absent:
 * digging down in water floods the new hole and moves the bot away from the
 * surface, spending air to get further from it.
 */
export const ESCAPE_DIRECTIONS = ["up", "north", "south", "east", "west"] as const;

export type EscapeDirection = (typeof ESCAPE_DIRECTIONS)[number];

/** Just enough of a prismarine Block to make a decision, so this stays testable. */
export interface EscapeBlock {
  name: string;
  boundingBox: string;
}

export type EscapeNeighbours = Record<EscapeDirection, EscapeBlock | null | undefined>;

export interface DrownEscape {
  direction: EscapeDirection;
  block: EscapeBlock;
}

/**
 * The nearest diggable way out, or null when every route is water, unknown, or
 * something the swarm cannot afford to lose.
 *
 * Returning null for an all-precious enclosure is deliberate. The bot dies, and
 * that is the lesser loss: a broken stash chest scatters hundreds of banked
 * items, and the bot respawns. What must not happen is dying while a plain
 * stone wall sat one block to the north, unexamined.
 */
export function chooseDrownEscape(neighbours: EscapeNeighbours): DrownEscape | null {
  for (const direction of ESCAPE_DIRECTIONS) {
    const block = neighbours[direction];
    // A missing block is an unloaded chunk, not a wall. Digging at it would
    // spend the last of the air on something the client cannot see.
    if (!block) continue;
    // Water and air are what the bot is already swimming through.
    if (block.boundingBox !== "block") continue;
    if (isPreciousBlock(block.name)) continue;
    return { direction, block };
  }
  return null;
}
