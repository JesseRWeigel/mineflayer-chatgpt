/**
 * Digging straight down, carefully.
 *
 * strip_mine descends with a pathfinder GoalY. Measured over one hour: 12 runs
 * never reached ore depth and 2 did, and the failures stalled at y=69, 66, 62 --
 * barely moved -- while the successes reached y=16 and y=-33 inside the same
 * budget. The pathfinder simply cannot route a dig path out of some terrain,
 * and raising the timeout would re-create the stall noted at strip-mine.ts:182.
 *
 * So: fall back to what a player does. Digging straight down is also the classic
 * way to die, which is why the safety check is a separate pure function with its
 * own tests. Dropping into lava while carrying the team's only iron bucket is
 * the specific disaster being avoided.
 */

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

export type BlockKind = "solid" | "air" | "lava" | "water" | "unknown";

/** How many blocks below the feet must be inspected before breaking one. */
export const DANGER_LOOKAHEAD = 3;

/** Blocks the bot may fall without taking damage. */
export const SAFE_FALL = 3;

/** How far past the lookahead to search for a floor under a cavity. */
const FLOOR_SEARCH = SAFE_FALL + 2;

/**
 * Keep going, or stop and report?
 *
 * The executor kills a skill at 240s. fill_bucket's three-shaft retry could
 * spend far more than that digging, so 2 of 6 runs were killed mid-shaft and
 * lost their progress. A skill that manages its own budget stops on its own
 * terms and says where it got to.
 */
export function shouldKeepDigging(msRemaining: number, dug: number, maxBlocks: number): boolean {
  return msRemaining > 0 && dug < maxBlocks;
}

export interface DigVerdict {
  safe: boolean;
  reason: string;
}

/**
 * Is it safe to break the block under the bot's feet?
 *
 * `probe(depth)` reports the block `depth` blocks below the feet, 1-indexed.
 * Anything other than solid rock in the lookahead stops the dig: lava and water
 * for the obvious reasons, air because it means an open cave the bot would fall
 * into, and unknown because an unloaded chunk is precisely where not to guess.
 */
export function safeToDigDown(probe: (depth: number) => BlockKind): DigVerdict {
  for (let d = 1; d <= DANGER_LOOKAHEAD; d++) {
    const kind = probe(d);
    if (kind === "lava") return { safe: false, reason: `lava ${d} block(s) below — refusing to dig into it` };
    if (kind === "water") return { safe: false, reason: `water ${d} block(s) below — the shaft would flood` };
    if (kind === "unknown") {
      return { safe: false, reason: `cannot see ${d} block(s) below (unloaded chunk) — not digging blind` };
    }
    if (kind === "air" && d > 1) {
      // A cavity is not automatically a hazard, and refusing every one meant
      // halting at the first cave — with the lava sea at y=-52 and caves
      // riddling everything above it, the descent never arrived. Look for a
      // floor within a survivable fall, and check what that floor is.
      for (let f = d + 1; f <= d + FLOOR_SEARCH; f++) {
        const under = probe(f);
        if (under === "lava") return { safe: false, reason: `lava under a ${f - d}-block drop` };
        if (under === "water") return { safe: false, reason: `water under a ${f - d}-block drop` };
        if (under === "unknown") return { safe: false, reason: `cannot see the floor under the drop` };
        if (under === "solid") {
          const fall = f - d;
          return fall <= SAFE_FALL
            ? { safe: true, reason: `${fall}-block step down onto solid floor` }
            : { safe: false, reason: `${fall}-block drop below — too far to fall` };
        }
      }
      return { safe: false, reason: `open air ${d} block(s) below with no floor in sight — a shaft, not a dig` };
    }
  }
  return { safe: true, reason: "solid ground below" };
}

/** Pickaxe quality, best last. Mirrors tool-tier's ordering. */
function rank(name: string): number {
  return ["wooden", "golden", "stone", "iron", "diamond", "netherite"].findIndex((m) => name.startsWith(m));
}

function kindOf(bot: Bot, pos: Vec3): BlockKind {
  const b = bot.blockAt(pos);
  if (!b) return "unknown";
  if (b.name === "lava") return "lava";
  if (b.name === "water") return "water";
  if (b.name === "air" || b.name === "cave_air" || b.name === "void_air") return "air";
  return "solid";
}

/**
 * Dig straight down toward `targetY`, one block at a time, stopping at the first
 * unsafe lookahead. Returns a sentence describing where it ended up and why.
 */
const SEAL_BLOCKS = ["cobblestone", "dirt", "stone", "netherrack", "andesite", "diorite", "granite", "deepslate"];

/** Place a throwaway block into a water cell so the shaft can pass it. */
async function sealCell(bot: Bot, cell: Vec3): Promise<boolean> {
  const item = bot.inventory.items().find((i) => SEAL_BLOCKS.includes(i.name));
  if (!item) return false;
  await bot.equip(item, "hand").catch(() => {});
  // A reference face adjacent to the cell: prefer the block underneath (the
  // aquifer floor), then the four side walls of the shaft.
  const options: Array<[Vec3, Vec3]> = [
    [cell.offset(0, -1, 0), new Vec3(0, 1, 0)],
    [cell.offset(1, 0, 0), new Vec3(-1, 0, 0)],
    [cell.offset(-1, 0, 0), new Vec3(1, 0, 0)],
    [cell.offset(0, 0, 1), new Vec3(0, 0, -1)],
    [cell.offset(0, 0, -1), new Vec3(0, 0, 1)],
  ];
  for (const [refPos, face] of options) {
    const ref = bot.blockAt(refPos);
    if (!ref || ref.name === "air" || ref.name.includes("water") || ref.name.includes("lava")) continue;
    try {
      await bot.placeBlock(ref, face);
    } catch {
      continue;
    }
    const now = bot.blockAt(cell);
    if (now && now.name !== "water" && now.name !== "flowing_water" && now.name !== "air") return true;
  }
  return false;
}

export async function digDownTo(bot: Bot, targetY: number, maxBlocks = 80, budgetMs = 90_000): Promise<string> {
  const startY = Math.floor(bot.entity.position.y);
  const deadline = Date.now() + budgetMs;
  let dug = 0;

  // Stone needs a pickaxe. Without this the first bot.dig on stone returned
  // "could not break stone: Digging aborted" after 0 blocks — the descent
  // existed and could not start.
  const pick = bot.inventory
    .items()
    .filter((i) => i.name.endsWith("_pickaxe"))
    .sort((a, b) => rank(b.name) - rank(a.name))[0];
  if (pick) await bot.equip(pick, "hand").catch(() => {});

  let seals = 0;
  while (Math.floor(bot.entity.position.y) > targetY && shouldKeepDigging(deadline - Date.now(), dug, maxBlocks)) {
    const feet = bot.entity.position.floored();
    const verdict = safeToDigDown((d) => kindOf(bot, feet.offset(0, -d, 0)));
    if (!verdict.safe) {
      // A blanket aquifer defeats both the refusal and the sidestep: Atlas
      // circled at y=62 for an hour, 25 blocks above his pool, hitting
      // "water 1 block(s) below" from every fresh shaft. Seal the water
      // with a throwaway block and dig on through — aquifers are a few
      // blocks thick and the pack always carries cobble.
      const water = /^water (\d+) block\(s\) below/.exec(verdict.reason);
      if (water && seals < 6) {
        const cell = feet.offset(0, -parseInt(water[1], 10), 0);
        if (await sealCell(bot, cell)) {
          seals++;
          continue;
        }
      }
      return `Dug down ${dug} to y=${Math.floor(bot.entity.position.y)}, then stopped: ${verdict.reason}.`;
    }

    const below = bot.blockAt(feet.offset(0, -1, 0));
    if (!below) return `Dug down ${dug} to y=${Math.floor(bot.entity.position.y)}, then lost sight of the floor.`;

    // "Digging aborted" is usually not this block's fault: a survival reflex
    // (flee, eat) calls stopDigging mid-swing, and treating that one aborted
    // swing as fatal ended four vertical sinks at "Dug down 0". An interrupt
    // costs one retry, not the descent. Re-equip too — the reflex may have
    // swapped the pickaxe for a sword.
    let broke = false;
    let lastErr = "";
    for (let swing = 0; swing < 3 && !broke; swing++) {
      try {
        if (pick && bot.heldItem?.name !== pick.name) await bot.equip(pick, "hand").catch(() => {});
        await bot.dig(below);
        broke = true;
      } catch (err) {
        lastErr = (err as Error).message;
        if (!/aborted/i.test(lastErr)) break; // a real failure, not an interrupt
        await new Promise((r) => setTimeout(r, 800)); // let the reflex finish
      }
    }
    if (!broke) {
      return `Dug down ${dug} to y=${Math.floor(bot.entity.position.y)}, then could not break ${below.name}: ${lastErr}`;
    }
    dug++;
    // Let the fall land before probing again, or the next lookahead reads the
    // block the bot is still falling through.
    await new Promise((r) => setTimeout(r, 350));
  }

  const endY = Math.floor(bot.entity.position.y);
  if (endY > targetY && Date.now() >= deadline) {
    return `Dug down ${dug} blocks from y=${startY} to y=${endY}, then ran out of time (target y=${targetY}).`;
  }
  return endY <= targetY
    ? `Dug down from y=${startY} to y=${endY}.`
    : `Dug down ${dug} blocks from y=${startY}, now at y=${endY} (target y=${targetY}).`;
}
