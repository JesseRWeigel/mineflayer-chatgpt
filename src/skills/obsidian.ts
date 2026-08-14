// src/skills/obsidian.ts
//
// Two routes to a portal frame.
//
// Casting needs no diamond: water on a lava SOURCE makes obsidian in place.
// Mining needs a diamond pickaxe but is the only route that puts obsidian in
// the inventory, which is what story/form_obsidian actually triggers on.
//
// The swarm is at iron tier with one diamond, so casting is the route that
// works today and mining is the upgrade.

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { pickaxeTier } from "../bot/tool-tier.js";
import { fillBucket, emptyBucket, type Vec3Like } from "./fluid.js";

const DIAMOND_TIER = 3;

export function chooseStrategy(inventoryNames: string[]): "mine" | "cast" {
  const best = inventoryNames.reduce((acc, n) => Math.max(acc, pickaxeTier(n) ?? -1), -1);
  return best >= DIAMOND_TIER ? "mine" : "cast";
}

/**
 * Cast obsidian at each position: lava first, then water over it.
 *
 * One block per round trip, because a bucket holds one fluid. Ten trips for a
 * frame. Slow, and the only route available at iron tier.
 */
export async function castInPlace(bot: Bot, positions: Vec3Like[]): Promise<string> {
  let cast = 0;
  for (const pos of positions) {
    const existing = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (existing?.name === "obsidian") {
      cast++;
      continue;
    }

    const lava = await fillBucket(bot, "lava");
    if (!lava.startsWith("Filled")) return `Cast stopped after ${cast}/${positions.length}: ${lava}`;
    await emptyBucket(bot, pos);

    const water = await fillBucket(bot, "water");
    if (!water.startsWith("Filled")) return `Cast stopped after ${cast}/${positions.length}: ${water}`;
    await emptyBucket(bot, { x: pos.x, y: pos.y + 1, z: pos.z });

    await new Promise((r) => setTimeout(r, 400));
    const now = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (now?.name === "obsidian") cast++;

    // No water-reclaim step here on purpose: emptyBucket already leaves the
    // bucket empty, and the next iteration fills LAVA first, not water. A
    // pre-emptive top-off with spilled water fills the bucket a step early
    // and starves the next lava fill of an empty bucket to scoop into,
    // stopping the cast after one block every time a bucket is the only one
    // the swarm owns.
  }
  return cast === positions.length
    ? `Cast ${cast} obsidian in place.`
    : `Cast ${cast} of ${positions.length} obsidian; the rest did not convert.`;
}

/** Mine existing obsidian. Requires a diamond pickaxe; earns story/form_obsidian. */
export async function mineObsidian(bot: Bot, count: number): Promise<string> {
  const pick = bot.inventory.items().find((i) => (pickaxeTier(i.name) ?? -1) >= DIAMOND_TIER);
  if (!pick) return "Need a diamond pickaxe to mine obsidian.";
  await bot.equip(pick, "hand");

  let mined = 0;
  for (let i = 0; i < count; i++) {
    const block = bot.findBlock({ matching: (b) => b.name === "obsidian", maxDistance: 32 });
    if (!block) break;
    await bot.dig(block);
    mined++;
  }
  return mined > 0 ? `Mined ${mined} obsidian.` : "Cannot find obsidian within 32 blocks.";
}

export async function acquireObsidian(bot: Bot, positions: Vec3Like[]): Promise<string> {
  const names = bot.inventory.items().map((i) => i.name);
  if (chooseStrategy(names) === "mine") {
    const held = bot.inventory.items().filter((i) => i.name === "obsidian").reduce((n, i) => n + i.count, 0);
    if (held >= positions.length) return `Already holding ${held} obsidian.`;
    const res = await mineObsidian(bot, positions.length - held);
    // Mining can come up short if no obsidian is nearby; fall back rather than stall.
    if (res.startsWith("Mined")) return res;
  }
  return castInPlace(bot, positions);
}
