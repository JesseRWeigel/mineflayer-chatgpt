import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import mcDataLoader from "minecraft-data";

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
export function igniterPlan(have: {
  flint?: number;
  gravel?: number;
  iron_ingot?: number;
  flint_and_steel?: number;
}): { have: boolean; needGravel: number; needIron: number } {
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

/**
 * Craft flint_and_steel from flint + iron already on hand. Returns a plain
 * status string; craftFlintAndSteelSkill below derives `success` from whether
 * a flint_and_steel actually ended up in the inventory, so this never needs
 * to lie about outcomes.
 */
export async function craftFlintAndSteel(bot: Bot): Promise<string> {
  const plan = igniterPlan(tally(bot));
  if (plan.have) return "Already have flint_and_steel.";
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
  if (!recipe) return "No flint_and_steel recipe available with the materials on hand.";

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
