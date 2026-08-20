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

const SCAFFOLD = ["cobblestone", "dirt", "stone", "netherrack", "andesite", "diorite", "granite", "deepslate"];

/** Cell contents that cannot support a fluid pour and need scaffold instead. */
const NEEDS_SCAFFOLD = new Set(["air", "cave_air", "water", "flowing_water", "lava", "flowing_lava"]);

/** Place a throwaway block at `at` so a fluid poured above it has support. */
async function placeScaffold(bot: Bot, at: Vec3Like): Promise<boolean> {
  const item = bot.inventory.items().find((i) => SCAFFOLD.includes(i.name));
  if (!item) return false;
  const below = bot.blockAt(new Vec3(at.x, at.y - 1, at.z));
  if (!below || below.name === "air") return false; // nothing to build off
  let err = "";
  try {
    await bot.equip(item, "hand");
    await bot.placeBlock(below, new Vec3(0, 1, 0));
  } catch (e: any) {
    err = e?.message ?? String(e);
  }
  const placed = bot.blockAt(new Vec3(at.x, at.y, at.z));
  const ok = !!placed && placed.name !== "air";
  if (!ok)
    console.log(
      `[Cast] scaffold at ${at.x},${at.y},${at.z} failed (${item.name} on ${below.name}): ${err || "no error, block still air"}`,
    );
  return ok;
}

/** Is `pos` or a touching cell wet, so lava poured there converts on contact? */
function touchesWater(bot: Bot, pos: Vec3Like): boolean {
  for (const [dx, dy, dz] of [
    [0, 0, 0],
    [0, 1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ]) {
    const n = bot.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
    if (n && (n.name === "water" || n.name === "flowing_water")) return true;
  }
  return false;
}

/**
 * Cast obsidian at each position, in the only order physics allows: bottom-up.
 *
 * A lava source needs solid support to rest on, so the floor row casts on the
 * ground, the jambs cast beside it, and the lintel needs SCAFFOLD in the
 * interior first (the interior-clearing step before ignition digs it back
 * out). Water contact converts the source: pour water beside the slot onto a
 * supported cell and let the flow do it — probe-verified that a pour needs a
 * solid block for its eye-ray to hit, so "onto the lava" is not a target.
 *
 * One block per lava trip, because a bucket holds one fluid. The frame site
 * is chosen beside a lava pool, so trips are hops.
 */
export async function castInPlace(bot: Bot, positions: Vec3Like[], deadline?: number): Promise<string> {
  const sorted = [...positions].sort((a, b) => a.y - b.y);
  const total = positions.length;
  let cast = 0;

  for (const pos of sorted) {
    // Ten slots of fills, walks and pours can outrun any caller's window —
    // the cast had no clock of its own and was the last uncovered stage when
    // twenty watchdog kills hit one hour. Banked blocks survive: a resumed
    // cast counts existing obsidian and continues from where this stopped.
    if (deadline && Date.now() > deadline) {
      return `Stopped after ${cast}/${total}: out of time this run — retry to continue this same frame.`;
    }
    const existing = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (existing?.name === "obsidian") {
      cast++;
      continue;
    }
    // A slot already holding a lava SOURCE (pool-edge sites have them) only
    // needs wetting — skip the fill-and-pour and convert what is there.
    if (existing?.name === "lava" && touchesWater(bot, pos)) {
      await new Promise((r) => setTimeout(r, 600));
      if (bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "obsidian") {
        cast++;
        continue;
      }
    }

    // Solid support first — a source cannot rest on air, and the pour ray
    // needs the support block to hit. Bottom-up order means the cell below is
    // ground, an earlier cast, or interior space we can scaffold. Flowing
    // water from the station counts as NEEDING scaffold, not as support —
    // solid blocks place into flow just fine, and a pour cannot hit water.
    const below = bot.blockAt(new Vec3(pos.x, pos.y - 1, pos.z));
    if (!below || NEEDS_SCAFFOLD.has(below.name)) {
      const ok = await placeScaffold(bot, { x: pos.x, y: pos.y - 1, z: pos.z });
      if (!ok)
        return `Stopped after ${cast}/${total}: no scaffold blocks (carry cobblestone or dirt) to support ${pos.x},${pos.y},${pos.z}.`;
    }

    // WATER FIRST, then lava into the water. Lava-first was probe-tested and
    // is a trap: the poured source's flow floods every neighbouring cell, so
    // there is nowhere left to pour the water, and the caster stands in the
    // spreading lava. Water flow is harmless, and lava placed into a
    // water-occupied cell converts to obsidian on the spot — no free-flowing
    // lava ever exists, and both pours aim at the same solid support.
    if (!touchesWater(bot, pos)) {
      const water = await fillBucket(bot, "water");
      if (!water.startsWith("Filled")) return `Stopped after ${cast}/${total}: ${water}`;
      // Pour the water on a NEIGHBOUR, not the slot: lava poured into the wet
      // slot would replace the source, spending one full water round trip per
      // block (probe-observed). A source beside the slot wets it by flow,
      // survives the cast, and keeps wetting the rest of the row.
      const isSlot = (c: Vec3Like) => positions.some((q) => q.x === c.x && q.y === c.y && q.z === c.z);
      const station = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
      ]
        .map(([dx, dz]) => ({ x: pos.x + dx, y: pos.y, z: pos.z + dz }))
        .find((c) => {
          if (isSlot(c)) return false;
          const cell = bot.blockAt(new Vec3(c.x, c.y, c.z));
          const support = bot.blockAt(new Vec3(c.x, c.y - 1, c.z));
          // Same standard emptyBucket holds the pour to: SOLID support only.
          return cell?.name === "air" && !!support && !NEEDS_SCAFFOLD.has(support.name);
        });
      const pouredWater = await emptyBucket(bot, station ?? pos);
      if (!pouredWater.startsWith("Poured")) return `Stopped after ${cast}/${total}: ${pouredWater}`;
      await new Promise((r) => setTimeout(r, 600)); // let the flow reach the slot
    }

    // A slot that already held a lava source needs no pour — the station's
    // flow converts it where it lies. Only empty slots get lava fetched.
    if (existing?.name === "lava") {
      await new Promise((r) => setTimeout(r, 800));
      if (bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "obsidian") cast++;
      continue;
    }

    const lava = await fillBucket(bot, "lava");
    if (!lava.startsWith("Filled")) return `Stopped after ${cast}/${total}: ${lava}`;
    const pouredLava = await emptyBucket(bot, pos);
    if (!pouredLava.startsWith("Poured")) return `Stopped after ${cast}/${total}: ${pouredLava}`;

    await new Promise((r) => setTimeout(r, 600));
    const now = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (now?.name === "obsidian") cast++;
  }
  return cast === total
    ? `Cast ${cast} obsidian in place.`
    : `Cast ${cast} of ${total} obsidian; the rest did not convert.`;
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

export async function acquireObsidian(bot: Bot, positions: Vec3Like[], deadline?: number): Promise<string> {
  const names = bot.inventory.items().map((i) => i.name);
  if (chooseStrategy(names) === "mine") {
    const held = bot.inventory
      .items()
      .filter((i) => i.name === "obsidian")
      .reduce((n, i) => n + i.count, 0);
    if (held >= positions.length) return `Already holding ${held} obsidian.`;
    const res = await mineObsidian(bot, positions.length - held);
    // Mining can come up short if no obsidian is nearby; fall back rather than stall.
    if (res.startsWith("Mined")) return res;
  }
  return castInPlace(bot, positions, deadline);
}
