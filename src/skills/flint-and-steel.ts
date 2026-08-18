import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import mcDataLoader from "minecraft-data";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
import { baseMoves, safeGoto } from "../bot/navigation.js";

// Something to light the portal with.
//
// 1 flint + 1 iron ingot. Flint drops from gravel at roughly 10%, so the plan
// budgets ten gravel per flint rather than one -- a bot with an exact-count
// plan gives up after the first gravel block fails to drop.

/** Gravel blocks to break per flint wanted, at a ~10% drop rate. */
const GRAVEL_PER_FLINT = 10;

/**
 * Ledger for the flint_and_steel recipe: what's still missing.
 *
 * Kept separate from the bot so the brain can ask "is this worth trying?"
 * without a server, and so the arithmetic is testable.
 */
export function igniterPlan(have: { flint?: number; gravel?: number; iron_ingot?: number; flint_and_steel?: number }): {
  have: boolean;
  needGravel: number;
  needIron: number;
} {
  if ((have.flint_and_steel ?? 0) > 0) return { have: true, needGravel: 0, needIron: 0 };
  const needIron = Math.max(0, 1 - (have.iron_ingot ?? 0));
  if ((have.flint ?? 0) > 0) return { have: false, needGravel: 0, needIron };
  const needGravel = Math.max(0, GRAVEL_PER_FLINT - (have.gravel ?? 0));
  return { have: false, needGravel, needIron };
}

function tally(bot: Bot): Record<string, number> {
  const t: Record<string, number> = {};
  for (const i of bot.inventory.items()) t[i.name] = (t[i.name] ?? 0) + i.count;
  return t;
}

const count = (bot: Bot, name: string) =>
  bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((n, i) => n + i.count, 0);

/**
 * Ore positions that defeated a dig. The block at (297,43,-313) sits under
 * water — underwater digs run 5-25x slower than the timeout — and because
 * findBlock always returns the NEAREST ore, every bot elected the same trap
 * block for hours. A failed ore is remembered and the next search skips it.
 */
const badOres = new Set<string>();
const oreKey = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

/**
 * One iron ingot, by any honest means: stash withdrawal, then mine a nearby
 * ore and smelt one raw iron. Every call is bounded; failure returns a reason
 * and leaves the inventory as evidence.
 */
export async function obtainOneIron(bot: Bot): Promise<string> {
  const { goals } = pkg;

  // 1. The stash may hold ingots or raw iron.
  try {
    const { withdrawStash } = await import("./stash.js");
    const { STASH_POS } = await import("../bot/role.js");
    if (bot.entity.position.distanceTo(new Vec3(STASH_POS.x, STASH_POS.y, STASH_POS.z)) < 64) {
      await withdrawStash(bot, STASH_POS, "iron_ingot", 1).catch(() => {});
      if (count(bot, "iron_ingot") > 0) return "withdrew an ingot from the stash";
      await withdrawStash(bot, STASH_POS, "raw_iron", 1).catch(() => {});
    }
  } catch {
    /* stash unavailable — mine instead */
  }

  // 2. Mine one ore if no raw iron yet.
  if (count(bot, "raw_iron") === 0 && count(bot, "iron_ingot") === 0) {
    const ore = bot.findBlock({
      matching: (b) => (b.name === "iron_ore" || b.name === "deepslate_iron_ore") && !badOres.has(oreKey(b.position)),
      maxDistance: 64,
    });
    if (!ore) return "no iron ore within 64 blocks — strip_mine would find some";
    const pick = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
    if (!pick) return "no pickaxe to mine the ore";
    bot.pathfinder.setMovements(baseMoves(bot));
    try {
      await safeGoto(bot, new goals.GoalNear(ore.position.x, ore.position.y, ore.position.z, 2), 45_000);
    } catch {
      /* measured below */
    }
    // Same pattern as the scoop: the first approach can end just out of the
    // ~4.5 dig reach — step in once before giving up, and report the actual
    // distance so a repeat failure is arithmetic, not mystery. Two bots
    // reported bare "could not mine" on the same ore with no way to tell
    // whether the problem was reach, line of sight, or the dig itself.
    let d = bot.entity.position.distanceTo(ore.position);
    if (d > 4.5) {
      try {
        await safeGoto(bot, new goals.GoalNear(ore.position.x, ore.position.y, ore.position.z, 1), 15_000);
      } catch {
        /* measured below */
      }
      d = bot.entity.position.distanceTo(ore.position);
      if (d > 4.5) {
        return `ore at ${ore.position.x},${ore.position.y},${ore.position.z} unreachable (${d.toFixed(1)} away)`;
      }
    }
    await bot.equip(pick, "hand").catch(() => {});
    try {
      // 30s, not 15: an ore under water digs 5-25x slower, and the trap block
      // that ate five attempts was exactly that — in reach, real, just slow.
      await Promise.race([
        bot.dig(ore),
        new Promise((_, rej) => setTimeout(() => rej(new Error("dig timeout")), 30_000)),
      ]);
    } catch {
      bot.stopDigging();
      badOres.add(oreKey(ore.position));
      return `could not mine the ore at ${ore.position.x},${ore.position.y},${ore.position.z} (standing ${d.toFixed(1)} away) — will try a different ore next time`;
    }
    await new Promise((r) => setTimeout(r, 1500)); // let the drop land and get picked up
  }
  if (count(bot, "iron_ingot") > 0) return "already had an ingot after all";
  if (count(bot, "raw_iron") === 0) return "mined but no raw_iron landed in the pack";

  // 3. Smelt one raw iron. A furnace from earlier smelt runs is usually
  //    nearby; otherwise place one from the pack if we carry it.
  let furnace = bot.findBlock({ matching: (b) => b.name === "furnace", maxDistance: 32 });
  if (!furnace) {
    const item = bot.inventory.items().find((i) => i.name === "furnace");
    if (!item) return "raw_iron in hand but no furnace within 32 and none in the pack";
    const below = bot.blockAt(bot.entity.position.floored().offset(1, -1, 0));
    if (below && below.name !== "air") {
      try {
        await bot.equip(item, "hand");
        await bot.placeBlock(below, new Vec3(0, 1, 0));
      } catch {
        /* re-checked below */
      }
      furnace = bot.findBlock({ matching: (b) => b.name === "furnace", maxDistance: 8 });
    }
    if (!furnace) return "could not place a furnace";
  }
  bot.pathfinder.setMovements(baseMoves(bot));
  try {
    await safeGoto(bot, new goals.GoalNear(furnace.position.x, furnace.position.y, furnace.position.z, 2), 30_000);
  } catch {
    /* openFurnace below is bounded and will tell */
  }
  const fuel = bot.inventory
    .items()
    .find((i) =>
      [
        "coal",
        "charcoal",
        "oak_planks",
        "spruce_planks",
        "birch_planks",
        "oak_log",
        "spruce_log",
        "birch_log",
      ].includes(i.name),
    );
  if (!fuel) return "raw_iron ready but no fuel (coal/planks/logs) in the pack";
  try {
    const f: any = await Promise.race([
      bot.openFurnace(furnace),
      new Promise((_, rej) => setTimeout(() => rej(new Error("furnace GUI timeout")), 10_000)),
    ]);
    const mcData = mcDataLoader(bot.version);
    // Clear leftovers first: three smelts failed "destination full" because
    // earlier runs left output (or a different fuel/input) sitting in the
    // slots, and mineflayer's transfer refuses a mismatched occupied slot.
    await f.takeOutput().catch(() => {});
    await f.takeInput().catch(() => {});
    await f.takeFuel().catch(() => {});
    await f.putFuel(mcData.itemsByName[fuel.name].id, null, 1);
    await f.putInput(mcData.itemsByName.raw_iron.id, null, 1);
    // ~10s per smelt; wait, then take.
    await new Promise((r) => setTimeout(r, 12_000));
    await f.takeOutput().catch(() => {});
    f.close();
  } catch (e: any) {
    return `smelt failed: ${e?.message ?? e}`;
  }
  return count(bot, "iron_ingot") > 0 ? "mined and smelted one" : "smelted but no ingot appeared";
}

/**
 * Craft flint_and_steel from flint + iron already on hand. Returns a plain
 * status string; craftFlintAndSteelSkill below derives `success` from whether
 * a flint_and_steel actually ended up in the inventory, so this never needs
 * to lie about outcomes.
 */
export async function craftFlintAndSteel(bot: Bot): Promise<string> {
  let plan = igniterPlan(tally(bot));
  if (plan.have) return "Already have flint_and_steel.";

  // Obtain the single iron ingot ourselves. "Smelt raw_iron first" depended
  // on someone mining iron — and once the gateway compass pointed every bot
  // at the portal, nobody did: five runs in one hour all stopped on this one
  // ingot. Stash first, then mine a nearby ore and smelt one raw iron in a
  // found (or pocket) furnace with pocket fuel. All bounded, all best-effort;
  // an honest shortage still falls through to the message below.
  if (plan.needIron > 0) {
    const got = await obtainOneIron(bot);
    console.log(`[Igniter] ${bot.username} iron: ${got}`);
    plan = igniterPlan(tally(bot));
  }
  if (plan.needIron > 0) {
    // A precondition, not a bug: say so in wording that does NOT start with
    // "<name> failed:", so the reliability layer treats it as an environment
    // problem rather than a crash.
    return `Need ${plan.needIron} iron_ingot for flint_and_steel. Smelt raw_iron first.`;
  }
  if (plan.needGravel > 0) {
    return `Need about ${plan.needGravel} more gravel to get flint. Mine gravel, then retry.`;
  }

  // Flint and steel fits in the 2x2 player crafting grid, so a table is a
  // bonus, not a requirement -- pass null when none is nearby rather than
  // blocking on one the way craft_bucket does for its 3-wide recipe.
  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  const mcData = mcDataLoader(bot.version);
  const recipe = bot.recipesFor(mcData.itemsByName.flint_and_steel.id, null, 1, table ?? null)[0];
  if (!recipe) {
    // Seen live with the plan claiming both materials present — log the
    // actual counts so the contradiction is inspectable instead of a shrug.
    const t = tally(bot);
    return `No flint_and_steel recipe available (holding flint=${t.flint ?? 0}, iron_ingot=${t.iron_ingot ?? 0}, table=${!!table}).`;
  }

  await bot.craft(recipe, 1, table ?? undefined);
  return bot.inventory.items().some((i) => i.name === "flint_and_steel")
    ? "Crafted flint_and_steel."
    : "flint_and_steel craft did not produce one.";
}

export const craftFlintAndSteelSkill: Skill = {
  name: "craft_flint_and_steel",
  description:
    "Craft flint_and_steel from 1 flint + 1 iron ingot. Flint drops from gravel at ~10%, so budget about 10 gravel per flint. Needed to light the nether portal.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, _signal, _onProgress): Promise<SkillResult> {
    const message = await craftFlintAndSteel(bot);
    const success = bot.inventory.items().some((i) => i.name === "flint_and_steel");
    return { success, message };
  },
};
