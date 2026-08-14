import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import mcDataLoader from "minecraft-data";

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

  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  if (!table) return "No crafting_table within 32 blocks. Place one, then retry.";

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
