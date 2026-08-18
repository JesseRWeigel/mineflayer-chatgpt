import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import mcDataLoader from "minecraft-data";
import { Vec3 as Vec3Ctor } from "vec3";

// A bucket is 3 iron ingots and the first rung of the nether chain.
//
// This replaces skills/generated/craftBucket.js, which imported mcData from a
// package that does not export it and therefore threw on line one. Written as
// a first-class skill rather than a generated one because everything downstream
// -- lava, obsidian, the portal -- is blocked until it works.

const BUCKET_IRON = 3;

/**
 * Ledger for the bucket recipe: what to smelt, and what is still missing.
 *
 * Kept separate from the bot so the brain can ask "is this worth trying?"
 * without a server, and so the arithmetic is testable.
 */
export function ironNeededFor(have: { iron_ingot?: number; raw_iron?: number }): {
  smelt: number;
  short: number;
} {
  const ingots = have.iron_ingot ?? 0;
  const raw = have.raw_iron ?? 0;
  const deficit = Math.max(0, BUCKET_IRON - ingots);
  const smelt = Math.min(deficit, raw);
  return { smelt, short: deficit - smelt };
}

function counts(bot: Bot): { iron_ingot: number; raw_iron: number } {
  const tally = { iron_ingot: 0, raw_iron: 0 };
  for (const item of bot.inventory.items()) {
    if (item.name === "iron_ingot") tally.iron_ingot += item.count;
    if (item.name === "raw_iron") tally.raw_iron += item.count;
  }
  return tally;
}

/**
 * Craft a bucket from iron already on hand. Returns a plain status string;
 * craftBucketSkill below derives `success` from whether a bucket actually
 * ended up in the inventory, so this never needs to lie about outcomes.
 */
export async function craftBucket(bot: Bot): Promise<string> {
  if (bot.inventory.items().some((i) => i.name === "bucket")) return "Already have a bucket.";

  const have = counts(bot);
  const { smelt, short } = ironNeededFor(have);
  if (short > 0) {
    // A precondition, not a bug: say so in wording that does NOT start with
    // "<name> failed:", so the reliability layer treats it as an environment
    // problem rather than a crash.
    return `Need ${short} more iron for a bucket. Mine iron_ore, then smelt_ores.`;
  }

  if (smelt > 0) {
    // Do NOT smelt here. smelt_ores is an existing registered skill that already
    // builds a furnace, finds fuel, and reports precondition failures properly.
    // Duplicating it would give the swarm two smelting paths with different bugs.
    return `Have raw_iron but only ${have.iron_ingot} ingots. Run smelt_ores first, then retry craft_bucket.`;
  }

  let table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });

  // Walk to it. Flora stood with seven ingots and got "craft did not produce
  // a bucket": findBlock accepts a table 32 blocks out, but bot.craft needs
  // the table in interaction reach and fails silently from farther away.
  if (table) {
    const { baseMoves, safeGoto } = await import("../bot/navigation.js");
    const pkg = (await import("mineflayer-pathfinder")).default;
    bot.pathfinder.setMovements(baseMoves(bot));
    try {
      await safeGoto(bot, new pkg.goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 30_000);
    } catch {
      /* measured below */
    }
    if (bot.entity.position.distanceTo(table.position) > 4.5) table = null;
  }

  // No reachable table — make one. The village tables live inside Mason's
  // houses where the pathfinder cannot always follow (Flora banked six ingots
  // and bounced off a roof-top table). Four planks fit the pocket grid, and
  // planks come from any log the same way.
  const mcData0 = mcDataLoader(bot.version);
  if (!table) {
    const planksHeld = () =>
      bot.inventory
        .items()
        .filter((i) => i.name.endsWith("_planks"))
        .reduce((n, i) => n + i.count, 0);
    if (planksHeld() < 4) {
      const log = bot.inventory.items().find((i) => i.name.endsWith("_log"));
      if (log) {
        const plankName = log.name.replace("_log", "_planks");
        const pr = mcData0.itemsByName[plankName]
          ? bot.recipesFor(mcData0.itemsByName[plankName].id, null, 1, null)[0]
          : null;
        if (pr) await bot.craft(pr, 1, undefined).catch(() => {});
      }
    }
    if (!bot.inventory.items().some((i) => i.name === "crafting_table")) {
      const tr = bot.recipesFor(mcData0.itemsByName.crafting_table.id, null, 1, null)[0];
      if (tr) await bot.craft(tr, 1, undefined).catch(() => {});
    }
    const tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
    if (tableItem) {
      const feet = bot.entity.position.floored();
      const below = bot.blockAt(feet.offset(1, -1, 0));
      if (below && below.name !== "air") {
        try {
          await bot.equip(tableItem, "hand");
          await bot.placeBlock(below, new Vec3Ctor(0, 1, 0));
        } catch {
          /* re-checked below */
        }
      }
      table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 4 });
    }
  }
  if (!table || bot.entity.position.distanceTo(table.position) > 4.5) {
    return "No reachable crafting_table and could not place one (need 4 planks or a log). Gather wood, then retry.";
  }

  const mcData = mcDataLoader(bot.version);
  const recipe = bot.recipesFor(mcData.itemsByName.bucket.id, null, 1, table)[0];
  if (!recipe) return "No bucket recipe available with the materials on hand.";

  await bot.craft(recipe, 1, table);
  return bot.inventory.items().some((i) => i.name === "bucket")
    ? "Crafted a bucket."
    : "Bucket craft did not produce a bucket.";
}

export const craftBucketSkill: Skill = {
  name: "craft_bucket",
  description:
    "Craft a bucket from 3 iron ingots at a crafting table. First rung of the nether chain (bucket -> lava -> obsidian -> portal). If short on ingots, run smelt_ores first.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, _signal, _onProgress): Promise<SkillResult> {
    const message = await craftBucket(bot);
    const success = bot.inventory.items().some((i) => i.name === "bucket");
    return { success, message };
  },
};
