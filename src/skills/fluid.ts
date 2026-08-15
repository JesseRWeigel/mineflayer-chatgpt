// src/skills/fluid.ts
//
// Bucket handling. The swarm had none, which is why story/lava_bucket sat on
// the frontier untouched while it was the first rung of the only route to the
// Nether's 24 advancements.
//
// The geometry helpers are pure so they can be tested without a server; the
// bot-driving functions are thin wrappers over mineflayer and are proven by a
// live run.

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";

export type Vec3Like = { x: number; y: number; z: number };

const FLUIDS = new Set(["water", "lava", "flowing_water", "flowing_lava"]);

/**
 * Source blocks have metadata 0; flowing fluid is 1-7 (and 8+ for falling).
 *
 * This matters more than it looks: water poured onto FLOWING lava makes
 * cobblestone, and onto a SOURCE makes obsidian. A caster that ignores this
 * builds a cobblestone rectangle and reports success.
 */
export function isSourceBlock(block: { name: string; metadata?: number } | null): boolean {
  if (!block || !FLUIDS.has(block.name)) return false;
  if (block.name.startsWith("flowing_")) return false;
  return (block.metadata ?? 0) === 0;
}

/**
 * A square to stand on while scooping: orthogonally adjacent, level with the
 * source, on the side the bot is already nearest.
 *
 * Never the source square itself and never directly above it — a bot that
 * approaches lava from on top falls in holding the team's only iron bucket.
 */
export function pickApproach(botPos: Vec3Like, source: Vec3Like): Vec3Like | null {
  const dx = botPos.x - source.x;
  const dz = botPos.z - source.z;
  // Favour the dominant axis so the bot does not walk around the pool.
  if (Math.abs(dx) >= Math.abs(dz)) {
    return { x: source.x + (dx >= 0 ? 1 : -1), y: source.y, z: source.z };
  }
  return { x: source.x, y: source.y, z: source.z + (dz >= 0 ? 1 : -1) };
}

/**
 * Depth at or below which we stop telling the bot to dig deeper.
 *
 * Must sit ABOVE strip_mine's TARGET_Y (16), or the advice is a loop: the bot
 * digs down, arrives at 16, is told it is still too high, and digs again
 * forever. The first version of this used 10 and would have done exactly that.
 */
export const LAVA_DEPTH = 20;

/** How close the bot must be for activateItem to affect a block. */
export const REACH_BLOCKS = 4.5;

/**
 * How far to look for a fluid source.
 *
 * 32 was too small to be useful underground. A bot standing in a cave system at
 * y=-29 had lava somewhere in it and reported "cannot find a lava source",
 * which sent it digging a fresh 46-block shaft instead of walking to the pool
 * it was already near. Walking is cheaper than excavating, and the whole
 * three-shaft apparatus existed to work around a search that was too short.
 */
export const FLUID_SEARCH_BLOCKS = 96;

/** Is the target close enough to interact with at all? */
export function withinReach(bx: number, by: number, bz: number, tx: number, ty: number, tz: number): boolean {
  return Math.hypot(bx - tx, by - ty, bz - tz) <= REACH_BLOCKS;
}

/**
 * What to do when there is no source in range.
 *
 * "Cannot find a lava source within 32 blocks" is true and useless: it never
 * says that Forge was standing at y=73, where surface lava is rare, while lava
 * pools are common below y=10. The bot re-ran the skill from the same spot.
 *
 * Same shape as tool-tier's harvestAdvice, for the same reason: a failure the
 * brain cannot act on gets retried unchanged.
 */
export function noSourceAdvice(fluid: "water" | "lava", y: number): string {
  const base = `Cannot find a ${fluid} source within ${FLUID_SEARCH_BLOCKS} blocks.`;
  if (fluid === "water") return `${base} Look for a lake, river or ocean on the surface.`;
  if (y > LAVA_DEPTH) {
    return `${base} You are at y=${y}; open lava is rare this high. invoke_skill {"skill":"strip_mine"} to dig down to ore depth, then retry.`;
  }
  return `${base} You are deep enough — explore sideways through caves to find a pool.`;
}

/** Equip a bucket, walk to a safe approach square, and scoop. Returns a result sentence. */
export async function fillBucket(bot: Bot, fluid: "water" | "lava"): Promise<string> {
  const bucket = bot.inventory.items().find((i) => i.name === "bucket");
  if (!bucket) return `No empty bucket to fill with ${fluid}.`;

  const source = bot.findBlock({
    matching: (b) => b.name === fluid && isSourceBlock(b),
    maxDistance: FLUID_SEARCH_BLOCKS,
  });
  if (!source) return noSourceAdvice(fluid, Math.floor(bot.entity.position.y));

  const stand = pickApproach(bot.entity.position, source.position);
  if (stand) {
    // Walk, and give it time to actually arrive: the source may now be up to
    // FLUID_SEARCH_BLOCKS away, where the old 15s budget could not reach.
    // Failing to arrive used to be swallowed, so the bot "scooped" from 20
    // blocks off and reported a mechanics failure.
    bot.pathfinder.setMovements(baseMoves(bot));
    try {
      await safeGoto(bot, new goals.GoalNear(stand.x, stand.y, stand.z, 1), 45_000);
    } catch {
      /* fall through to the reach check below, which reports the real distance */
    }
  }

  // findBlock searches 32 blocks and the walk above is best-effort, so the bot
  // may still be nowhere near the lava. activateItem does nothing outside the
  // ~4.5 block reach, which produced "Bucket did not fill from the lava source"
  // — a mechanics-sounding failure for what was really a distance problem.
  const p = bot.entity.position;
  const sp = source.position;
  if (!withinReach(p.x, p.y, p.z, sp.x + 0.5, sp.y + 0.5, sp.z + 0.5)) {
    const d = Math.hypot(p.x - sp.x, p.y - sp.y, p.z - sp.z);
    return `Found ${fluid} at ${sp.x},${sp.y},${sp.z} but could not get closer than ${d.toFixed(0)} blocks — the path there is blocked. Try approaching from another side.`;
  }

  await bot.equip(bucket, "hand");

  // Fluids have NO interaction shape, so bot.activateBlock does nothing to them
  // — there is no block face to click. Filling a bucket is "look at the fluid,
  // then use the held item", which is a different packet entirely.
  //
  // This cost a day: the skill reached lava at negative y and reported "Bucket
  // did not fill from the lava source", because activateBlock had been
  // substituted for lookAt+activateItem on the reasoning that it looks at the
  // block internally. It does, and that is correct for solid blocks and inert
  // for fluid ones.
  await bot.lookAt(source.position.offset(0.5, 0.5, 0.5), true);
  bot.activateItem();
  await new Promise((r) => setTimeout(r, 500)); // let the inventory packet land

  const filled = bot.inventory.items().some((i) => i.name === `${fluid}_bucket`);
  return filled ? `Filled a bucket with ${fluid}.` : `Bucket did not fill from the ${fluid} source.`;
}

/** Pour a full bucket so the fluid lands at `at`. Returns a result sentence. */
export async function emptyBucket(bot: Bot, at: Vec3Like): Promise<string> {
  const full = bot.inventory.items().find((i) => i.name === "water_bucket" || i.name === "lava_bucket");
  if (!full) return "No full bucket to empty.";

  // Right-clicking a block's top face pours the fluid into the space above
  // it, so target the block directly below where the fluid should end up.
  const target = bot.blockAt(new Vec3(at.x, at.y - 1, at.z));
  if (!target) return `Nothing to pour against at ${at.x},${at.y},${at.z}.`;

  await bot.equip(full, "hand");
  await bot.activateBlock(target);
  await new Promise((r) => setTimeout(r, 500)); // let the inventory packet land

  const emptied = bot.inventory.items().some((i) => i.name === "bucket");
  return emptied ? `Poured ${full.name.replace("_bucket", "")} at ${at.x},${at.y},${at.z}.` : "Bucket did not empty.";
}
