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

/** Equip a bucket, walk to a safe approach square, and scoop. Returns a result sentence. */
export async function fillBucket(bot: Bot, fluid: "water" | "lava"): Promise<string> {
  const bucket = bot.inventory.items().find((i) => i.name === "bucket");
  if (!bucket) return `No empty bucket to fill with ${fluid}.`;

  const source = bot.findBlock({
    matching: (b) => b.name === fluid && isSourceBlock(b),
    maxDistance: 32,
  });
  if (!source) return `Cannot find a ${fluid} source within 32 blocks.`;

  const stand = pickApproach(bot.entity.position, source.position);
  if (stand) {
    bot.pathfinder.setMovements(baseMoves(bot));
    try {
      await safeGoto(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), 15000);
    } catch {
      // Best effort — an unreachable approach square still leaves scooping
      // from wherever the bot ended up worth trying rather than bailing.
    }
  }

  await bot.equip(bucket, "hand");
  // activateBlock targets this exact block (and looks at it internally), so
  // there is no separate lookAt-then-hope-the-raycast-agrees step needed.
  await bot.activateBlock(source);
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
