// src/skills/nether-portal.ts
//
// Build the frame, light it, step through, and be able to come home.
//
// The return trip is not decoration. The Nether is 8:1, so a bot that walks
// away from its arrival portal cannot navigate back by overworld coordinates,
// and it is carrying the iron the whole plan was spent acquiring.

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { findSiteFlexible, firstObstacle, type BlockKind } from "./portal-siting.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import type { Skill, SkillResult } from "./types.js";
import { framePositions, interiorPositions, ignitionTarget } from "./portal-geometry.js";
import { acquireObsidian } from "./obsidian.js";
import { craftFlintAndSteel } from "./flint-and-steel.js";
import { fillBucket, isSourceBlock, LAVA_DEPTH, type Vec3Like } from "./fluid.js";
import { digDownTo } from "./descend.js";
import { baseMoves, safeGoto } from "../bot/navigation.js";
import { persistentSet, persistBlacklist, persistentRecord, persistRecord } from "./blacklists.js";

const REQUIRED = ["bucket", "flint_and_steel"] as const;

export function readinessOf(names: string[]): { ready: boolean; missing: string[] } {
  const has = (want: string) =>
    want === "bucket"
      ? names.some((n) => n === "bucket" || n === "water_bucket" || n === "lava_bucket")
      : names.includes(want);
  const missing = REQUIRED.filter((r) => !has(r));
  return { ready: missing.length === 0, missing: [...missing] };
}

/** Where each bot's portal is, so it can find its way back. */
const portals = new Map<string, { origin: Vec3Like; axis: "x" | "z" }>();

/**
 * The site a bot has already started building on. Without this, every retry
 * sited a fresh frame wherever the bot happened to be standing — the hour's
 * log shows "No clear 4x5 space" alternating with "frame is not complete"
 * as the site moved between attempts, scattering partial frames that could
 * never individually finish. Casting resumes on a remembered site because
 * castInPlace counts already-obsidian positions as done.
 */
const plannedSites = new Map<string, { origin: Vec3Like; axis: "x" | "z" }>(
  Object.entries(persistentRecord<{ origin: Vec3Like; axis: "x" | "z" }>("plannedSites")),
);
const savePlannedSites = () => persistRecord("plannedSites", Object.fromEntries(plannedSites));

/**
 * Frames that hold banked obsidian, keyed by origin, independent of which bot
 * built them. Per-bot plannedSites dies with abandons, overwrites and role
 * churn; the blocks stay in the world. Anyone passing within resume range
 * adopts the nearest banked frame instead of prospecting fresh.
 */
const bankedFrames = persistentRecord<{
  origin: Vec3Like;
  axis: "x" | "z";
  banked?: number;
  lavaStrikes?: number;
  lastStrikeAt?: number;
  lastProgressAt?: number;
}>("bankedFrames");
const saveBankedFrames = () => persistRecord("bankedFrames", bankedFrames);
// A banked frame whose lava keeps proving unreachable is a trap, not an
// asset: the 5-block frame at 392 sat beside a pool sealed under a lake —
// 500+ commute legs funneled the whole swarm into a walk that could never
// end in a pour. Three strikes retire the frame as a commute/adopt target;
// its blocks stay in the world and the registry, but the swarm stops
// pilgrimage to lava that is not there.
const LAVA_STRIKE_LIMIT = 3;
// Recent progress overrides strikes: the strike system benched TWO frames
// that were actively casting — approach failures from 19 and even 100
// blocks out counted the same as the lake-trap's point-blank futility. A
// frame that banked a block in the last six hours has proven its lava
// works; pathing noise cannot retire it. The lake-trap signature (days
// without a single cast) still benches on schedule.
const PROGRESS_SHIELD_MS = 6 * 60 * 60_000;
const frameLavaDead = (e: { lavaStrikes?: number; lastProgressAt?: number }) =>
  (e.lavaStrikes ?? 0) >= LAVA_STRIKE_LIMIT &&
  (!e.lastProgressAt || Date.now() - e.lastProgressAt > PROGRESS_SHIELD_MS);
const RESUME_RANGE = 48;

/**
 * Lava pools the march keeps failing to reach. Atlas burned three runs at a
 * pool guarded by a cavern his sink refused to cross and his walk could not
 * route around — the same nearest-first trap as the drowned ore. Three
 * fell-short endings for the same pool and the next search looks elsewhere.
 */
const lavaFails = new Map<string, number>();
const badLava = persistentSet("badLava");
const lavaKey = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
function recordLavaFellShort(p: { x: number; y: number; z: number }): void {
  const k = lavaKey(p);
  const n = (lavaFails.get(k) ?? 0) + 1;
  lavaFails.set(k, n);
  if (n >= 3) {
    badLava.add(k);
    persistBlacklist("badLava", badLava);
  }
}

export function recordPortal(bot: Bot, origin: Vec3Like, axis: "x" | "z"): void {
  portals.set(bot.username, { origin, axis });
}

export function lastPortal(botName: string): { origin: Vec3Like; axis: "x" | "z" } | undefined {
  return portals.get(botName);
}

/**
 * Place the frame against existing solid blocks. bot.placeBlock needs a
 * REFERENCE block and a face vector to build off, not a target coordinate
 * (src/skills/build-bridge.ts:95), so a position with nothing below it yet
 * cannot be placed on the first pass. Floor first, then jambs bottom-up, then
 * the lintel -- each row gives the next something solid to build against.
 * Run the whole loop twice: the second pass catches whatever the first left
 * behind once earlier rows filled in the missing support.
 */
async function placeFrame(bot: Bot, origin: Vec3Like, axis: "x" | "z"): Promise<void> {
  const frame = framePositions(origin, axis);
  const floor = frame.filter((p) => p.y === origin.y - 1);
  const jambs = frame.filter((p) => p.y >= origin.y && p.y < origin.y + 3).sort((a, b) => a.y - b.y);
  const lintel = frame.filter((p) => p.y === origin.y + 3);
  const ordered = [...floor, ...jambs, ...lintel];

  for (let pass = 0; pass < 2; pass++) {
    for (const pos of ordered) {
      const target = new Vec3(pos.x, pos.y, pos.z);
      if (bot.blockAt(target)?.name === "obsidian") continue;

      const held = bot.inventory.items().find((i) => i.name === "obsidian");
      if (!held) return; // out of obsidian; nothing left to place with

      const below = bot.blockAt(target.offset(0, -1, 0));
      if (!below || below.name === "air") continue; // nothing to build off yet, catch it next pass

      await bot.equip(held, "hand");
      await bot.placeBlock(below, new Vec3(0, 1, 0)).catch(() => {});
    }
  }
}

/**
 * Dig a portal-shaped void out of the rock. Cave geometry beside a lava
 * pocket almost never has a natural 4x5 clearance — two runs arrived at the
 * pool and died on "No clear 4x5 space within 16 blocks". The bot carries a
 * pickaxe and stone is free; carving the frame's volume (plus a standing
 * pocket in front) turns any wall beside the lava into a site. Bounded per
 * dig and overall, best effort — the caller re-probes afterwards.
 */
async function carveSite(bot: Bot, origin: Vec3Like, axis: "x" | "z"): Promise<void> {
  const pick = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
  if (!pick) return;
  await bot.equip(pick, "hand").catch(() => {});

  const cells = [...framePositions(origin, axis), ...interiorPositions(origin, axis)];
  // A standing pocket in front of the frame so the caster can work it.
  const front = interiorPositions(origin, axis).map((c) =>
    axis === "x" ? { x: c.x, y: c.y, z: c.z + 1 } : { x: c.x + 1, y: c.y, z: c.z },
  );
  const deadline = Date.now() + 90_000;
  for (const cell of [...cells, ...front]) {
    if (Date.now() > deadline) return;
    const b = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
    if (!b || b.name === "air" || b.name === "cave_air" || b.name === "water" || b.name === "lava") continue;
    if (b.name === "obsidian" || b.name === "bedrock") continue;
    // Step toward cells outside the ~4.5 dig reach. The first wild carve left
    // a floor cell solid ("carve left: frame cell ... is solid") because the
    // digger swung from one standing spot and far cells failed silently.
    if (bot.entity.position.distanceTo(b.position) > 4.3) {
      try {
        await safeGoto(bot, new goals.GoalNear(cell.x, cell.y, cell.z, 2), 10_000);
      } catch {
        /* the dig below will fail fast if still out of reach */
      }
    }
    try {
      await Promise.race([
        bot.dig(b),
        new Promise((_, rej) => setTimeout(() => rej(new Error("dig timeout")), 12_000)),
      ]);
    } catch {
      bot.stopDigging();
    }
  }
}

export async function buildNetherPortal(bot: Bot): Promise<string> {
  // Own the clock. The executor's 240s watchdog killed eight runs in one
  // hour once the chain grew to water-charge + descent + closures + carve +
  // cast — and a watchdog kill returns no resumable hand-back, so the
  // auto-continue never fires and the model has to rediscover the plan. A
  // run that ends ITSELF ends with progress banked and the protocol marker.
  const runDeadline = Date.now() + 200_000;
  const timeLeft = () => runDeadline - Date.now();
  const outOfTime = (doing: string) => {
    const p = bot.entity.position.floored();
    return `Out of run time while ${doing} (at ${p.x},${p.y},${p.z}) — progress is banked. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
  };

  const names = bot.inventory.items().map((i) => i.name);
  let { ready, missing } = readinessOf(names);

  // Make the prerequisites rather than asking the model to chain skills across
  // decisions. That advice has failed three times now: craft_bucket sat unused
  // until its goal named it, fill_bucket ran from the surface after strip_mine
  // had already descended, and craft_flint_and_steel is registered, in Forge's
  // menu, and named by nothing. A skill that needs a thing should make it.
  // The stash first: before the kit-retention rule (2545cec) every deposit
  // trip donated buckets and igniters to the chest, so the cheapest kit is
  // usually sitting there already — withdrawing beats re-grinding four iron.
  if (!ready) {
    const { withdrawStash } = await import("./stash.js");
    const { STASH_POS } = await import("../bot/role.js");
    for (const item of missing) {
      await withdrawStash(bot, STASH_POS, item, 1).catch(() => {});
    }
    ({ ready, missing } = readinessOf(bot.inventory.items().map((i) => i.name)));
  }

  // The bucket, self-supplied too. "Missing bucket. Craft those first." has
  // been the igniter-holders' wall for three cycles — craft_bucket refuses
  // without three ingots on hand, and nobody delivers them. The igniter's
  // proven one-ingot chain runs up to twice per attempt; ingots persist in
  // the inventory, so successive runs accumulate to three and then craft.
  if (!ready && missing.includes("bucket")) {
    const { craftBucket } = await import("./craft-bucket.js");
    const { obtainOneIron } = await import("./flint-and-steel.js");
    const ingots = () =>
      bot.inventory
        .items()
        .filter((i) => i.name === "iron_ingot")
        .reduce((n, i) => n + i.count, 0);
    for (let round = 0; round < 2 && ingots() < 3 && timeLeft() > 60_000; round++) {
      const got = await obtainOneIron(bot, Math.min(120_000, timeLeft() - 50_000));
      console.log(`[Bucket] ${bot.username} iron (${ingots()}/3): ${got}`);
      if (!/withdrew|mined and smelted|picked up/.test(got)) break; // no progress — stop burning budget
    }
    if (ingots() >= 3) {
      const bucketMsg = await craftBucket(bot);
      console.log(`[Bucket] ${bot.username}: ${bucketMsg}`);
    }
    ({ ready, missing } = readinessOf(bot.inventory.items().map((i) => i.name)));
  }

  if (!ready && missing.includes("flint_and_steel")) {
    // The igniter chain (ore walk, dig, smelt, fuel hunt) is the single
    // longest readiness stage; twenty watchdog kills in one hour traced to
    // pre-clock stages like this one running the window dry.
    if (timeLeft() < 60_000) return outOfTime("assembling the igniter");
    const igniter = await craftFlintAndSteel(bot, timeLeft() - 45_000);
    ({ ready, missing } = readinessOf(bot.inventory.items().map((i) => i.name)));
    if (!ready) return `Not ready for a portal: missing ${missing.join(", ")}. ${igniter}`;
  }
  if (!ready)
    return `Not ready for a portal: missing ${missing.join(", ")}. Keep re-invoking — each run banks iron toward the bucket.`;

  const p = bot.entity.position;
  let axis: "x" | "z" = "x";

  // Siting used to be "two blocks east of wherever the bot stands", unchecked.
  // A portal is a 4x5 volume; two east of a bot on a ridge is a frame that
  // cannot be placed, and each obsidian block costs a round trip to a lava pool.
  // Probe the world instead and refuse to start rather than burn ten trips.
  const probe = (q: Vec3Like): BlockKind => {
    const b = bot.blockAt(new Vec3(q.x, q.y, q.z));
    if (!b) return "unknown"; // unloaded chunk — never assume it is clear
    if (b.name === "obsidian") return "obsidian";
    if (b.name === "water" || b.name === "lava") return "liquid";
    if (b.name === "air" || b.name === "cave_air" || b.name === "void_air") return "air";
    return "solid";
  };

  // Resume a half-built frame before siting a new one.
  let prior = plannedSites.get(bot.username);
  // No site of our own in range? Adopt any TEAM frame that already banked
  // obsidian. Two 1-block frames sat unvisited for days because per-bot site
  // memory died with abandons and overwrites while the blocks stood in the
  // world — the registry outlives both the bot's plans and the process.
  if (!prior || Math.hypot(prior.origin.x - p.x, prior.origin.y - p.y, prior.origin.z - p.z) > RESUME_RANGE) {
    for (const entry of Object.values(bankedFrames)) {
      if (frameLavaDead(entry)) continue;
      if (Math.hypot(entry.origin.x - p.x, entry.origin.y - p.y, entry.origin.z - p.z) <= RESUME_RANGE) {
        console.log(
          `[Portal] ${bot.username}: adopting team frame with banked obsidian at ${entry.origin.x},${entry.origin.y},${entry.origin.z}`,
        );
        prior = entry;
        break;
      }
    }
  }
  let origin: Vec3Like | null = null;
  if (prior && Math.hypot(prior.origin.x - p.x, prior.origin.y - p.y, prior.origin.z - p.z) <= RESUME_RANGE) {
    origin = prior.origin;
    axis = prior.axis;
    try {
      await safeGoto(bot, new goals.GoalNear(origin.x, origin.y, origin.z, 3), 30000);
    } catch {
      // Casting re-checks reach per block; being short of the site is survivable.
    }
  } else {
    // Carry the water DOWN. Three runs in a row reached the cast phase and
    // died trying to tunnel to a buried aquifer at y=-3 — at lava depth,
    // water is rare and encased, but the village lake is thirty seconds away
    // on the surface. One carried charge becomes the site's station (the
    // cast pours it on a neighbour cell and re-scoops it), so fill BEFORE
    // descending, while water is cheap. Best effort: a failed surface fill
    // just falls back to hunting water at depth like before.
    // Four watchdog kills came back within a day of the run clock landing:
    // readiness (stash trips, the iron accumulator, fuel gathering) is not
    // clock-checked and can eat most of the window before the first check in
    // the march loop ever runs. Guard the expensive early stages too.
    if (timeLeft() < 70_000) return outOfTime("after gathering the kit");
    const hasFluid = () => bot.inventory.items().some((i) => i.name === "water_bucket" || i.name === "lava_bucket");
    if (!hasFluid() && bot.entity.position.y > LAVA_DEPTH) {
      const surfaceWater = await fillBucket(bot, "water");
      console.log(`[Portal] ${bot.username} surface water charge: ${surfaceWater}`);
    }

    // Site the frame beside the lava it will drink from, not beside the bot.
    // A surface site over deep lava charges every one of ten casts a full
    // descent round trip — the run that exposed this filled its bucket at
    // depth and then could not climb back within budget ("Could not get
    // within pouring range... the path back is blocked"). Ten of those can
    // never fit one watchdog window; ten five-block hops can. As a bonus,
    // the wrong-fluid dump in fillBucket lands its water near the site,
    // becoming the refill station for the cast's water half.
    const findLava = () =>
      bot.findBlock({
        // b.position is NULL for section-scanned blocks inside findBlock's
        // matching callback — six runs crashed on it. Judge the blacklist only
        // when a position exists (the trap the playbook warned about, form 2).
        matching: (b) => b.name === "lava" && isSourceBlock(b) && (!b.position || !badLava.has(lavaKey(b.position))),
        maxDistance: 96,
      });
    let lava = findLava();

    // No lava in range means the bot is invoking from the surface. Telling
    // the model "strip_mine down, then retry" asked it to hold a two-step
    // plan across separate decisions — the same shape that stranded
    // craft_bucket and the igniter. The skill descends itself with the
    // proven bounded digger, then looks again.
    // Known frames outrank blind prospecting. With banked obsidian standing
    // in the world, "no lava within 96" at the deforested village means
    // COMMUTE — and leaving that walk to model attention lost whole nights
    // of runs to descents into terrain the refusals mapped out days ago.
    // A WELL-BUILT frame outranks local prospecting too: run 301's first
    // hour went entirely to a village descent toward virgin deep lava (five
    // "ran out of time" legs toward y=-60) while the 3/10 frame with proven
    // lava sat one commute away — the descent would only have smeared an
    // eighth frame across the map. With 3+ blocks banked at a healthy frame
    // in range, commute even though lava is findable here; thin frames (1-2
    // blocks) still lose to lava in hand.
    {
      const q0 = bot.entity.position;
      // Most-built frame wins; distance only breaks ties. Nearest-first sent
      // the whole swarm to a one-block frame with a jammed approach while the
      // four-block frame at the proven pool got no visitors.
      let nearest: { origin: Vec3Like; d: number; banked: number } | null = null;
      for (const e of Object.values(bankedFrames)) {
        if (frameLavaDead(e)) continue;
        const d = Math.hypot(e.origin.x - q0.x, e.origin.y - q0.y, e.origin.z - q0.z);
        if (d > 220) continue;
        const b = e.banked ?? 1;
        if (!nearest || b > nearest.banked || (b === nearest.banked && d < nearest.d)) {
          nearest = { origin: e.origin, d, banked: b };
        }
      }
      if (nearest && nearest.d > RESUME_RANGE && (!lava || nearest.banked >= 3)) {
        console.log(
          `[Portal] ${bot.username}: ${lava ? "well-built frame outranks local lava" : "no local lava"} — commuting to banked frame at ${nearest.origin.x},${nearest.origin.y},${nearest.origin.z} (${nearest.d.toFixed(0)} away)`,
        );
        bot.pathfinder.setMovements(baseMoves(bot));
        for (let leg = 0; leg < 2; leg++) {
          if (timeLeft() < 60_000) return outOfTime("commuting to the banked frame");
          try {
            await safeGoto(bot, new goals.GoalNear(nearest.origin.x, nearest.origin.y, nearest.origin.z, 8), 45_000);
          } catch {
            /* legs bank distance */
          }
          if (
            bot.entity.position.distanceTo(new Vec3(nearest.origin.x, nearest.origin.y, nearest.origin.z)) <=
            RESUME_RANGE
          )
            break;
        }
        const dNow = bot.entity.position.distanceTo(new Vec3(nearest.origin.x, nearest.origin.y, nearest.origin.z));
        // Hand back on ARRIVAL as well as mid-march: continuing in-run from
        // here would site a fresh frame beside whatever lava is local — the
        // exact move that minted the 388 one-block stubs two cells from the
        // real frame. The re-invocation lands in the adoption path instead,
        // which resumes the registered origin.
        return `Commuting to the banked frame at ${nearest.origin.x},${nearest.origin.y},${nearest.origin.z} — ${dNow <= RESUME_RANGE ? "arrived in adoption range" : `still ${dNow.toFixed(0)} blocks away`}. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
      }
    }

    if (!lava && bot.entity.position.y > LAVA_DEPTH) {
      console.log(`[Portal] ${bot.username}: no lava within 96 — descending first`);
      // fill_bucket's proven shape: a refused shaft ("open air below — a
      // shaft, not a dig", an aquifer) is a LOCAL verdict, not proof there is
      // no way down — two runs in a row ended at the same y=67 ledge. Step
      // aside and sink a fresh hole, all inside one budget so the executor's
      // watchdog never kills the descent mid-dig.
      if (timeLeft() < 60_000) return outOfTime("before the descent");
      const deadline = Date.now() + Math.min(100_000, timeLeft() - 30_000);
      for (let attempt = 0; attempt < 2 && !lava; attempt++) {
        const left = deadline - Date.now();
        if (left < 15_000) break;
        const dug = await digDownTo(bot, -40, 80, left);
        console.log(`[Portal] ${bot.username} descent: ${dug}`);
        lava = findLava();
        if (lava || bot.entity.position.y <= LAVA_DEPTH) break;
        try {
          const q = bot.entity.position;
          await safeGoto(bot, new goals.GoalNear(q.x + 6, q.y, q.z + 6, 1), 12_000);
        } catch {
          break; // boxed in — stop rather than spin
        }
      }
    }
    if (!lava) {
      return `No lava source within 96 blocks even at y=${Math.floor(bot.entity.position.y)}. Explore sideways through caves, then invoke_skill {"skill":"build_nether_portal"} again.`;
    }

    // Keep walking while the gap is closing. A single 60s leg once ended the
    // run "still 40 blocks away" with ~170s of watchdog budget unused, and
    // the model wandered off instead of re-invoking. Two more bounded legs
    // fit comfortably under the 240s watchdog even after a 100s descent.
    bot.pathfinder.setMovements(baseMoves(bot));
    for (let leg = 0; leg < 3; leg++) {
      if (timeLeft() < 55_000) return outOfTime("marching to lava");
      const gap = bot.entity.position.distanceTo(lava.position);
      if (gap <= 10) break;
      try {
        await safeGoto(bot, new goals.GoalNear(lava.position.x, lava.position.y, lava.position.z, 5), 45000);
      } catch {
        /* measured below */
      }
      const now = bot.entity.position.distanceTo(lava.position);
      if (now >= gap - 2) {
        // Not closing. Four runs reported the same "75 blocks away" from a
        // pool at y=-4: the gap was almost entirely VERTICAL, and the
        // pathfinder cannot plan a 70-block dig column — digDownTo can
        // execute exactly that. Sink toward the pool's level and try the
        // walk again from depth.
        const drop = bot.entity.position.y - lava.position.y;
        if (now > 15 && drop > 15) {
          if (timeLeft() < 45_000) return outOfTime("sinking toward the pool");
          const dug = await digDownTo(bot, Math.floor(lava.position.y) + 2, 80, Math.min(90_000, timeLeft() - 25_000));
          console.log(`[Portal] ${bot.username} vertical closure: ${dug}`);
          // A shaft refused at its very first swing (water/void below, open
          // water underfoot) will be refused identically from the same cell
          // forever — Atlas logged nine "water 3 block(s) below" from one
          // spot across three legs and three encores. Sidestep before the
          // next attempt, the same medicine the initial descent takes.
          if (/Dug down 0|cannot start here|kept breaking/.test(dug)) {
            const p = bot.entity.position;
            await safeGoto(bot, new goals.GoalNear(p.x + 6, p.y, p.z + 6, 2), 15_000).catch(() => {});
          }
          continue;
        }
        break; // genuinely blocked laterally
      }
    }

    // Do NOT plan a frame the walk never reached. "Site wherever we got to"
    // re-created the doomed surface frame: lava was findable 90 blocks below
    // the village, the walk fell short, and the surface site it committed was
    // then resumed all run. Better to end this run partway down — the next
    // invocation continues from here.
    const lavaGap = bot.entity.position.distanceTo(lava.position);
    if (lavaGap > 15) {
      recordLavaFellShort(lava.position);
      console.log(`[Portal] ${bot.username}: walk fell short — ${lavaGap.toFixed(0)} blocks from lava`);
      return `Walking to lava at ${lava.position.x},${lava.position.y},${lava.position.z} — still ${lavaGap.toFixed(0)} blocks away. invoke_skill {"skill":"build_nether_portal"} again to continue from here.`;
    }

    // Start one above the bot's feet: the frame's floor row rests ON the
    // ground, so the interior begins a block higher.
    const here = bot.entity.position;
    const centre: Vec3Like = { x: Math.floor(here.x) + 2, y: Math.floor(here.y) + 1, z: Math.floor(here.z) };
    let site = findSiteFlexible(centre, probe, 16);
    if (!site) {
      // No natural void beside the pool — carve one out of the rock and
      // re-probe. Stone is free and the pickaxe is already in the pack.
      console.log(`[Portal] ${bot.username}: no natural site — carving one at ${centre.x},${centre.y},${centre.z}`);
      if (timeLeft() < 40_000) return outOfTime("about to carve a site");
      await carveSite(bot, centre, axis);
      site = findSiteFlexible(centre, probe, 16);
      if (!site) {
        const obstacle = firstObstacle(centre, axis, probe) ?? "no obstacle at centre?";
        console.log(`[Portal] ${bot.username} carve left: ${obstacle}`);
        // The chronic ending — ten carves finished ONE cell short of a site
        // and the run walked away. When the re-probe names a single solid
        // cell, spend one focused trip on exactly that cell instead of
        // hoping a future carve budget reaches it.
        const m = /cell (-?\d+),(-?\d+),(-?\d+) is (?:solid|unknown)/.exec(obstacle);
        if (m && timeLeft() > 30_000) {
          const cellV = new Vec3(+m[1], +m[2], +m[3]);
          const b = bot.blockAt(cellV);
          if (b && b.name !== "bedrock" && b.name !== "obsidian" && b.name !== "air") {
            try {
              await safeGoto(bot, new goals.GoalNear(cellV.x, cellV.y, cellV.z, 2), 15_000);
            } catch {
              /* dig below fails fast if still out of reach */
            }
            bot.pathfinder.setGoal(null);
            const pick = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
            if (pick) await bot.equip(pick, "hand").catch(() => {});
            try {
              await Promise.race([
                bot.dig(b),
                new Promise((_, rej) => setTimeout(() => rej(new Error("dig timeout")), 12_000)),
              ]);
            } catch {
              bot.stopDigging();
            }
            site = findSiteFlexible(centre, probe, 16);
            if (site) console.log(`[Portal] ${bot.username}: focused dig finished the carve`);
          }
        }
      }
    }
    if (site) {
      ({ origin, axis } = site);
      plannedSites.set(bot.username, { origin, axis });
      savePlannedSites();
    }
  }
  if (!origin)
    return "No clear 4x5 space for a portal within 16 blocks even after carving. Move somewhere open and retry.";

  if (timeLeft() < 60_000) return outOfTime("reaching the casting step");
  const frame = framePositions(origin, axis);

  // Scaffold for the cast, self-supplied: Blade reached a banked frame and
  // stalled on "no scaffold blocks (carry cobblestone or dirt)" — sealing
  // aquifers and capping shafts spend the cobble long before the lintel
  // needs it. Stone and dirt are everywhere; dig up to four blocks nearby
  // first, never touching the frame's own volume or its floor support.
  if (timeLeft() > 90_000) {
    // Count ONLY what the pathfinder can tower with. The broad stone family
    // satisfies the cast's own scaffold placer, but pillaring out of a pit
    // accepts dirt and cobblestone alone — a bot passed this check holding
    // granite and still reported towers=0 at the pour walk-back. Same rule
    // for what to dig: stone and dirt drop tower-usable items; andesite,
    // diorite, granite and deepslate drop items the pathfinder ignores.
    const SCAFF = new Set(["cobblestone", "dirt"]);
    const scaffCount = () =>
      bot.inventory
        .items()
        .filter((i) => SCAFF.has(i.name))
        .reduce((n, i) => n + i.count, 0);
    const DIGGABLE = new Set(["stone", "dirt", "grass_block"]);
    const protectedCells = new Set(
      [...frame, ...interiorPositions(origin, axis)].flatMap((p) => [
        `${p.x},${p.y},${p.z}`,
        `${p.x},${p.y - 1},${p.z}`,
      ]),
    );
    // Eight, doubled from four: the census caught Atlas stranded at the pool
    // with a full lava bucket and ZERO tower blocks — the walk back up the
    // cave chimney at the 252 site needs pathfinder pillars, and the frame
    // supports had eaten his four. The pour trip spends scaffold the lintel
    // math never budgeted.
    for (let s = 0; s < 8 && scaffCount() < 8; s++) {
      const blk = bot.findBlock({
        matching: (b) =>
          DIGGABLE.has(b.name) &&
          (!b.position || !protectedCells.has(`${b.position.x},${b.position.y},${b.position.z}`)),
        maxDistance: 8,
      });
      if (!blk) break;
      try {
        await Promise.race([
          bot.dig(blk),
          new Promise((_, rej) => setTimeout(() => rej(new Error("dig timeout")), 10_000)),
        ]);
        await new Promise((r) => setTimeout(r, 800));
      } catch {
        bot.stopDigging();
        break;
      }
    }
    if (scaffCount() < 8) {
      console.log(`[Portal] ${bot.username}: scaffold short (${scaffCount()}/8) — the cast may stop at the lintel`);
    }
  }

  const got = await acquireObsidian(bot, frame, runDeadline - 15_000);
  console.log(`[Portal] ${bot.username} obsidian step: ${got}`);

  // Any obsidian in the frame makes it team property worth returning to.
  const frameKey = `${origin.x},${origin.y},${origin.z}`;
  {
    const bankedNow = frame.filter((pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "obsidian").length;
    const before = bankedFrames[frameKey];
    if (bankedNow > 0 && before?.banked !== bankedNow) {
      // Fresh obsidian in the ring is proof the lava here still pours —
      // clear any strikes along with recording the new count.
      const grew = bankedNow > (before?.banked ?? 0);
      bankedFrames[frameKey] = {
        origin,
        axis,
        banked: bankedNow,
        lavaStrikes: grew ? 0 : (before?.lavaStrikes ?? 0),
        lastStrikeAt: grew ? undefined : before?.lastStrikeAt,
        lastProgressAt: grew ? Date.now() : before?.lastProgressAt,
      };
      saveBankedFrames();
    }
  }
  if (!got.startsWith("Cast") && !got.startsWith("Mined") && !got.startsWith("Already")) {
    // A site whose lava cannot be reached is a trap, not an asset: the
    // planned-site resume walked Atlas back to the same doomed frame twice in
    // an hour ("could not get closer than 13/25 blocks"). If NOTHING has been
    // banked in the frame yet, abandon it and let the next run site fresh
    // beside lava it can actually drink from. A frame holding any obsidian
    // stays — banked blocks are worth walking back to.
    const banked = frame.filter((pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "obsidian").length;
    if (
      banked === 0 &&
      /could not get closer|could not get within pouring range|Cannot find a lava source/i.test(got)
    ) {
      plannedSites.delete(bot.username);
      savePlannedSites();
      // Strike the POOL, not just the site: Atlas abandoned a frame and then
      // re-sited two blocks away against the same unreachable lava, carving
      // and abandoning again. The fell-short counter already retires pools
      // the walk cannot reach; a cast that proved the rim undrinkable is the
      // same evidence, so it casts the same vote.
      const src = /at (-?\d+),(-?\d+),(-?\d+)/.exec(got);
      if (src) recordLavaFellShort({ x: +src[1], y: +src[2], z: +src[3] });
      console.log(
        `[Portal] ${bot.username} abandoned empty site at ${origin.x},${origin.y},${origin.z} — lava unreachable from it`,
      );
      return `Portal stalled getting obsidian: ${got} Site abandoned; the next attempt sites a fresh frame beside reachable lava.`;
    }
    // A BANKED frame that cannot reach its lava earns a strike. Pour-range
    // failures are excluded on purpose: those mean the lava filled the
    // bucket fine and only the walk back to the ring jammed — the 252 frame
    // reached 3/10 through exactly that noise. Only "the lava itself is out
    // of reach" evidence retires a frame.
    // Two more exclusions, learned when three routine misses retired the
    // healthiest frame in the registry within one hour of it CASTING a
    // block: a miss that voted its cell out ("that cell is blacklisted") is
    // the rotation self-healing, so it never strikes; and strikes are
    // rate-limited to one per frame per half hour, so only sustained
    // futility across hours — the 392 lake-trap signature — reaches the
    // limit, while a healthy site's bad stretch cannot outrun its own
    // progress resets.
    if (
      banked > 0 &&
      /could not get closer|Cannot find a lava source/i.test(got) &&
      !/that cell is blacklisted/i.test(got)
    ) {
      const entry = bankedFrames[frameKey];
      const rested = !entry?.lastStrikeAt || Date.now() - entry.lastStrikeAt > 30 * 60_000;
      if (entry && rested) {
        entry.lavaStrikes = (entry.lavaStrikes ?? 0) + 1;
        entry.lastStrikeAt = Date.now();
        saveBankedFrames();
        if (frameLavaDead(entry)) {
          console.log(
            `[Portal] ${bot.username}: frame at ${frameKey} has dead local lava (${entry.lavaStrikes} strikes) — retired as a commute target`,
          );
        }
      }
    }
    return `Portal stalled getting obsidian: ${got}`;
  }

  // Placed-block route: if obsidian ended up in inventory (the mine route, or
  // any leftover from casting), set the frame by hand. Casting already writes
  // obsidian directly into the world at each position, so this is a no-op
  // there beyond the already-obsidian check inside placeFrame.
  if (bot.inventory.items().some((i) => i.name === "obsidian")) {
    await placeFrame(bot, origin, axis);
  }

  const frameComplete = frame.every((pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "obsidian");
  if (!frameComplete) return `Frame unfinished so far (${got}) — retry to continue this same frame.`;

  // Clear the interior so the portal has room to form.
  for (const pos of interiorPositions(origin, axis)) {
    const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (b && b.name !== "air" && b.name !== "nether_portal") await bot.dig(b).catch(() => {});
  }

  const igniter = bot.inventory.items().find((i) => i.name === "flint_and_steel");
  if (!igniter) return "Frame built but no flint_and_steel to light it.";
  await bot.equip(igniter, "hand");

  const t = ignitionTarget(origin, axis);
  const below = bot.blockAt(new Vec3(t.x, t.y - 1, t.z));
  if (below) await bot.activateBlock(below).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));

  const lit = interiorPositions(origin, axis).some(
    (pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "nether_portal",
  );
  if (!lit) return "Frame built but the portal did not light. Check the frame is complete.";

  recordPortal(bot, origin, axis);
  plannedSites.delete(bot.username);
  savePlannedSites();
  return `Portal built and lit at ${origin.x},${origin.y},${origin.z}.`;
}

// Read behind a function call so tsc does not narrow bot.game.dimension to a
// single literal across the awaits below — the whole point of re-checking it
// after walking and waiting is that it CAN change out from under us.
function dimensionOf(bot: Bot): string {
  return bot.game.dimension;
}

function isNether(dim: string): boolean {
  return dim === "the_nether" || dim === "minecraft:the_nether";
}

function isOverworld(dim: string): boolean {
  return dim === "overworld" || dim === "minecraft:overworld";
}

export async function returnThroughPortal(bot: Bot): Promise<string> {
  if (!isNether(dimensionOf(bot))) {
    return "Not in the Nether — nothing to return from.";
  }
  const portal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 64 });
  if (!portal) return "Cannot find a nether_portal within 64 blocks.";

  bot.pathfinder.setMovements(baseMoves(bot));
  try {
    await safeGoto(bot, new goals.GoalBlock(portal.position.x, portal.position.y, portal.position.z), 20000);
  } catch {
    // Best effort — still worth standing near the portal and waiting for the
    // dimension change even if pathfinder gave up short of the exact block.
  }

  // Standing in the portal is what triggers the transition; give it time.
  await new Promise((r) => setTimeout(r, 6000));
  const home = isOverworld(dimensionOf(bot));
  return home ? "Returned to the overworld." : "Stood in the portal but did not transition.";
}

export const buildNetherPortalSkill: Skill = {
  name: "build_nether_portal",
  description:
    "Build and light a Nether portal near your current position. Casts obsidian from lava and water, crafts an igniter if you lack one, lights the portal, and records its location for return_from_nether. Needs a bucket.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, _signal, _onProgress): Promise<SkillResult> {
    const message = await buildNetherPortal(bot);
    const success = message.startsWith("Portal built and lit");
    return { success, message };
  },
};

export const returnFromNetherSkill: Skill = {
  name: "return_from_nether",
  description:
    "Walk to the nearest nether_portal and step through to return to the overworld. Use after build_nether_portal has taken you to the Nether.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, _signal, _onProgress): Promise<SkillResult> {
    const message = await returnThroughPortal(bot);
    const success = message === "Returned to the overworld.";
    return { success, message };
  },
};
