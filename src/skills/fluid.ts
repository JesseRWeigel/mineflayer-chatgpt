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
  // Already carrying the goods — filling would be a wasted round trip.
  if (bot.inventory.items().some((i) => i.name === `${fluid}_bucket`)) {
    return `Filled bucket with ${fluid} (already had it).`;
  }

  // A bucket full of the WRONG fluid is not "no bucket": the portal's
  // readiness check accepts any bucket, so a bot arriving with water could
  // never start the lava-first cast — 29 of the hour's 53 portal failures
  // were this exact dead end. Dump it where we stand and carry on.
  let bucket = bot.inventory.items().find((i) => i.name === "bucket");
  if (!bucket) {
    const wrong = bot.inventory.items().find((i) => i.name === "water_bucket" || i.name === "lava_bucket");
    if (wrong) {
      // Three blocks aside, not at the feet — the wrong fluid can be lava,
      // and a bot must not pour lava on itself to free up its own bucket.
      const feet = bot.entity.position.floored();
      await emptyBucket(bot, { x: feet.x + 3, y: feet.y, z: feet.z });
      bucket = bot.inventory.items().find((i) => i.name === "bucket");
    }
  }
  if (!bucket) return `No empty bucket to fill with ${fluid}.`;

  const source = bot.findBlock({
    matching: (b) => b.name === fluid && isSourceBlock(b),
    maxDistance: FLUID_SEARCH_BLOCKS,
  });
  if (!source) return noSourceAdvice(fluid, Math.floor(bot.entity.position.y));

  // Let the PATHFINDER choose where to stand. pickApproach dictated a single
  // cell at the source's own y, which for a buried pool is a cell inside the
  // ground — an unsatisfiable goal that burned the whole walk budget and
  // produced an hour of "could not get closer — the path there is blocked"
  // at underground water pockets. GoalNear radius 2 lets the pathfinder pick
  // any standable cell it can actually reach; the reach check below still
  // gates the scoop.
  bot.pathfinder.setMovements(baseMoves(bot));
  try {
    await safeGoto(bot, new goals.GoalNear(source.position.x, source.position.y, source.position.z, 2), 45_000);
  } catch {
    /* fall through to the reach check below, which reports the real distance */
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

  // Walk into pouring range first. Filling lava can end 100+ blocks below the
  // portal site, and activateBlock beyond ~4.5 blocks does nothing — the pour
  // silently failed from the fill spot and no obsidian ever converted.
  const dist = bot.entity.position.distanceTo(new Vec3(at.x, at.y, at.z));
  if (dist > 4) {
    bot.pathfinder.setMovements(baseMoves(bot));
    try {
      await safeGoto(bot, new goals.GoalNear(at.x, at.y, at.z, 2), 45000);
    } catch {
      // fall through to the reach check below
    }
    if (bot.entity.position.distanceTo(new Vec3(at.x, at.y, at.z)) > 4.5) {
      return `Could not get within pouring range of ${at.x},${at.y},${at.z} — the path back is blocked.`;
    }
  }

  // Pouring is the same packet dance as filling: the server runs the bucket's
  // own eye-ray trace when the ITEM is used, so "look at the top face of the
  // block below the target space, then use the held item". activateBlock was
  // the pour-side twin of the fill-side bug that cost a day — it survived here
  // on the unverified reasoning that pouring "clicks a solid block, where it's
  // right". Six "Bucket did not empty" failures an hour said otherwise.
  // The pour ray needs a SOLID block to hit. Probe-verified 2026-08-17:
  // aiming at the seam (0.02 under the target space) missed and the bucket
  // stayed full; aiming at the support block's centre emptied it. And when
  // the support is air there is nothing to hit and nowhere for a fluid
  // source to rest — report that instead of "did not empty".
  const target = bot.blockAt(new Vec3(at.x, at.y - 1, at.z));
  if (!target) return `Nothing to pour against at ${at.x},${at.y},${at.z}.`;
  if (target.name === "air" || target.name === "cave_air" || FLUIDS.has(target.name)) {
    return `No solid support under ${at.x},${at.y},${at.z} to pour against.`;
  }

  await bot.equip(full, "hand");
  await bot.lookAt(new Vec3(at.x + 0.5, at.y - 0.5, at.z + 0.5), true);
  bot.activateItem();
  await new Promise((r) => setTimeout(r, 500)); // let the inventory packet land

  const emptied = bot.inventory.items().some((i) => i.name === "bucket");
  return emptied ? `Poured ${full.name.replace("_bucket", "")} at ${at.x},${at.y},${at.z}.` : "Bucket did not empty.";
}
