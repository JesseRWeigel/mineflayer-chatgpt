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

/**
 * The bucket-use critical section. The reactive brain is allowed to interrupt
 * skills by design (survival reflexes win), but a "Flee from creeper" fired in
 * the ~2s between equipping the bucket and the use packet drags the bot away
 * mid-scoop — probe-verified: the identical code fills lava flawlessly with no
 * brain attached, while the fleet failed point-blank (standing 1.2, dy=1 — the
 * displacement IS the flee). The brain defers reactive events while this latch
 * is fresh; the window is short enough that the threat is still there after.
 */
const handsBusyMap = new WeakMap<Bot, number>();
export function handsBusy(bot: Bot): boolean {
  return (handsBusyMap.get(bot) ?? 0) > Date.now();
}
export function holdHands(bot: Bot, ms: number): void {
  handsBusyMap.set(bot, Date.now() + ms);
  // The reactive brain defers while the latch is fresh — but mineflayer-auto-eat
  // swaps the held item on its own timer, outside the brain entirely. A third
  // point-blank scoop failure (standing 1.8, dy=0) survived the latch; a bot
  // whose hunger dips mid-scoop equips food instead of the bucket. Pause it
  // for the same window.
  const ae = (bot as { autoEat?: { disableAuto?: () => void; enableAuto?: () => void } }).autoEat;
  if (ae?.disableAuto) {
    ae.disableAuto();
    setTimeout(() => ae.enableAuto?.(), ms);
  }
}

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

export type DumpProbe = (p: Vec3Like) => "air" | "solid" | "liquid" | "unknown";

/**
 * Where can a wrong-fluid dump actually land?
 *
 * The dump used to aim at a fixed cell three east of the feet. Atlas stood at
 * a lake edge with water east of him, so that cell had no solid support, the
 * pour was refused, and fillBucket reported "No empty bucket" while a full
 * water bucket sat in the pack — the cast died at 0/10 one step from the pool
 * it needed. A dump target must be found the way the cast finds its water
 * station: an air cell over solid ground, searched outward. `minR` keeps lava
 * dumps off the caster's own feet; water is harmless at any distance.
 */
export function findDumpCell(feet: Vec3Like, probe: DumpProbe, minR: number, maxR = 4): Vec3Like | null {
  for (let r = minR; r <= maxR; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, 1, -1]) {
          const cell = { x: feet.x + dx, y: feet.y + dy, z: feet.z + dz };
          if (probe(cell) !== "air") continue;
          if (probe({ x: cell.x, y: cell.y - 1, z: cell.z }) !== "solid") continue;
          return cell;
        }
      }
    }
  }
  return null;
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

/**
 * Source cells that refused a point-blank, held-bucket, in-range scoop.
 *
 * The cursor diagnostic settled a two-day mystery: at the stubborn sources
 * the crosshair reads deepslate/andesite — the use-item trace to THAT cell is
 * blocked (a rim block, or a flowing cell the server refuses to scoop), while
 * the identical code fills from other cells all day. A pool has many source
 * cells; remember the deaf ones and let the next attempt aim at a neighbour.
 * Per-process, like badOres — restarts relearn, which is acceptable.
 */
const badScoops = new Set<string>();
const scoopKey = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

/** Equip a bucket, walk to a safe approach square, and scoop. Returns a result sentence. */
export async function fillBucket(bot: Bot, fluid: "water" | "lava"): Promise<string> {
  // Already carrying the goods — filling would be a wasted round trip.
  if (bot.inventory.items().some((i) => i.name === `${fluid}_bucket`)) {
    return `Filled bucket with ${fluid} (already had it).`;
  }

  // A bucket full of the WRONG fluid is not "no bucket": the portal's
  // readiness check accepts any bucket, so a bot arriving with water could
  // never start the lava-first cast — 29 of the hour's 53 portal failures
  // were this exact dead end. Dump it nearby and carry on. The dump cell is
  // SEARCHED, and lava keeps 3 blocks of clearance so the bot never pours
  // lava on itself to free up its own bucket.
  let bucket = bot.inventory.items().find((i) => i.name === "bucket");
  if (!bucket) {
    const wrong = bot.inventory.items().find((i) => i.name === "water_bucket" || i.name === "lava_bucket");
    if (wrong) {
      const feet = bot.entity.position.floored();
      const probe: DumpProbe = (p) => {
        const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
        if (!b) return "unknown";
        if (b.name === "air" || b.name === "cave_air") return "air";
        if (FLUIDS.has(b.name)) return "liquid";
        return "solid";
      };
      const spot = findDumpCell(feet, probe, wrong.name === "lava_bucket" ? 3 : 1);
      if (spot) {
        const dumped = await emptyBucket(bot, spot);
        if (!dumped.startsWith("Poured")) {
          console.log(`[Bucket] dump of ${wrong.name} at ${spot.x},${spot.y},${spot.z} failed: ${dumped}`);
        }
      } else {
        console.log(`[Bucket] no dumpable cell within 4 of ${feet.x},${feet.y},${feet.z} to free ${wrong.name}`);
      }
      bucket = bot.inventory.items().find((i) => i.name === "bucket");
    }
  }
  if (!bucket) return `No empty bucket to fill with ${fluid}.`;

  // The null-position guard is load-bearing: section-scanned blocks reach
  // matching callbacks with b.position === null (findblock-predicate-trap,
  // Form 2 — six anonymous crashes).
  const source = bot.findBlock({
    matching: (b) => b.name === fluid && isSourceBlock(b) && (!b.position || !badScoops.has(scoopKey(b.position))),
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
  const sp = source.position;
  // The pathfinder parks shy of lava (danger cost), so radius-2 walks often
  // end 4-5 blocks from the source's centre — just outside the server's
  // ~4.5 use-item reach. Atlas failed three fetches in one hour from "4
  // blocks away". The failed-scoop branch below has had a step-in retry for
  // days; the out-of-reach branch returned immediately. Step in once here
  // too before declaring the path blocked.
  const inReach = () => {
    const q = bot.entity.position;
    return withinReach(q.x, q.y, q.z, sp.x + 0.5, sp.y + 0.5, sp.z + 0.5);
  };
  if (!inReach()) {
    if (fluid === "lava") {
      // GoalNear radius 1 of a LAVA block is an order to stand in the pool:
      // Atlas swam in lava and burned to death within minutes of this branch
      // going live. For lava, step in by naming a SAFE cell — air over solid,
      // adjacent to the source — and walking to exactly that.
      const probe: DumpProbe = (c) => {
        const b = bot.blockAt(new Vec3(c.x, c.y, c.z));
        if (!b) return "unknown";
        if (b.name === "air" || b.name === "cave_air") return "air";
        if (FLUIDS.has(b.name)) return "liquid";
        return "solid";
      };
      const stand = findDumpCell({ x: sp.x, y: sp.y, z: sp.z }, probe, 1, 2);
      if (stand) {
        try {
          await safeGoto(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), 15_000);
        } catch {
          /* measured below */
        }
      }
    } else {
      try {
        await safeGoto(bot, new goals.GoalNear(sp.x, sp.y, sp.z, 1), 15_000);
      } catch {
        /* measured below */
      }
    }
  }
  if (!inReach()) {
    const q = bot.entity.position;
    const d = Math.hypot(q.x - (sp.x + 0.5), q.y - (sp.y + 0.5), q.z - (sp.z + 0.5));
    return `Found ${fluid} at ${sp.x},${sp.y},${sp.z} but could not get closer than ${d.toFixed(1)} blocks — the path there is blocked. Try approaching from another side.`;
  }

  holdHands(bot, 2_500);
  // Fresh item, unconditional equip, and a beat for the server to register
  // it: "held=cobblestone" at the moment of a failed scoop revealed a THIRD
  // item-swapper — the pathfinder equips blocks while bridging and digging —
  // and a stale heldItem read let the old conditional re-equip skip.
  const b1 = bot.inventory.items().find((i) => i.name === "bucket");
  if (!b1) return `Bucket vanished on the way to the ${fluid}.`;
  await bot.equip(b1, "hand");
  await new Promise((r) => setTimeout(r, 150));

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

  let filled = bot.inventory.items().some((i) => i.name === `${fluid}_bucket`);
  if (!filled) {
    // The reach check passes at 4.5 but the server's own use-item ray starts
    // at the EYES and can fall short or clip a pool-rim block from that far.
    // The probe validated scoops at ~2 blocks; step in once and try again.
    try {
      await safeGoto(bot, new goals.GoalNear(sp.x, sp.y, sp.z, 1), 15_000);
    } catch {
      /* retry from wherever we got */
    }
    holdHands(bot, 2_500);
    const b2 = bot.inventory.items().find((i) => i.name === "bucket");
    if (!b2) return `Bucket vanished on the way to the ${fluid}.`;
    await bot.equip(b2, "hand");
    await new Promise((r) => setTimeout(r, 150));
    await bot.lookAt(source.position.offset(0.5, 0.5, 0.5), true);
    bot.activateItem();
    await new Promise((r) => setTimeout(r, 500));
    filled = bot.inventory.items().some((i) => i.name === `${fluid}_bucket`);
  }
  if (filled) return `Filled a bucket with ${fluid}.`;
  const q = bot.entity.position;
  const dNow = Math.hypot(q.x - sp.x, q.y - sp.y, q.z - sp.z);
  // held= is the tell: RCON confirmed the fourth same-coords failure targeted
  // a genuine level-0 source with the bot in range — if the hand shows food
  // or a sword here, something still swaps items despite the latch.
  // What is the eye-ray actually hitting? Three point-blank failures with
  // held=bucket at RCON-verified sources leave occlusion as the live suspect:
  // at dy=0 the ray from the eyes skims the pool rim, and a rim block between
  // eye and source swallows the use-item trace. Name the block under the
  // crosshair so the next failure identifies its own occluder.
  const cursor = (bot as unknown as { blockAtCursor?: (d: number) => { name: string } | null }).blockAtCursor?.(5);
  // A held-bucket, in-range miss means THIS cell is deaf to us; stop asking it.
  badScoops.add(scoopKey(sp));
  return `Bucket did not fill from the ${fluid} source at ${sp.x},${sp.y},${sp.z} (standing ${dNow.toFixed(1)} away, dy=${(q.y - sp.y).toFixed(0)}, held=${bot.heldItem?.name ?? "nothing"}, cursor=${cursor?.name ?? "nothing"}) — that cell is now blacklisted; retry aims at a different source.`;
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

  holdHands(bot, 2_500);
  const fullNow = bot.inventory.items().find((i) => i.name === "water_bucket" || i.name === "lava_bucket");
  if (!fullNow) return "No full bucket to empty.";
  await bot.equip(fullNow, "hand");
  await new Promise((r) => setTimeout(r, 150));
  await bot.lookAt(new Vec3(at.x + 0.5, at.y - 0.5, at.z + 0.5), true);
  bot.activateItem();
  await new Promise((r) => setTimeout(r, 500)); // let the inventory packet land

  const emptied = bot.inventory.items().some((i) => i.name === "bucket");
  return emptied ? `Poured ${full.name.replace("_bucket", "")} at ${at.x},${at.y},${at.z}.` : "Bucket did not empty.";
}
