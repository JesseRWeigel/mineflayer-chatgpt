import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";

/**
 * breed_animals — earn "The Parrots and the Bats" (husbandry/breed_an_animal).
 *
 * The strategic model never assembles the two-adults-plus-food ritual on its
 * own. This skill does it deterministically: pick a species we hold food for,
 * feed two nearby adults, and let them breed. Food is stash-first so a farmer's
 * pooled wheat/seeds get used.
 */

// Food each species accepts, in order of what the swarm most reliably has.
const FEED: { food: string; species: string[] }[] = [
  { food: "wheat", species: ["cow", "sheep", "mooshroom", "goat"] },
  { food: "wheat_seeds", species: ["chicken"] },
  { food: "carrot", species: ["pig"] },
  { food: "potato", species: ["pig"] },
];

function count(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}

async function tryWithdraw(bot: Bot, name: string, n: number): Promise<void> {
  try {
    const { withdrawStash } = await import("./stash.js");
    const { STASH_POS } = await import("../bot/role.js");
    if (Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z) > 60) return;
    await Promise.race([withdrawStash(bot, STASH_POS, name, n), new Promise<void>((r) => setTimeout(r, 30_000))]).catch(
      () => {},
    );
  } catch {
    /* stash unavailable */
  }
}

export const breedAnimalsSkill: Skill = {
  name: "breed_animals",
  description:
    "Breed two farm animals (feed two cows/sheep wheat, or chickens seeds) to earn the breeding advancement. Uses held or stashed food.",
  params: {},
  timeoutMs: 240_000,

  estimateMaterials() {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"breed_animals"} again to continue from here.`;
    const step = (progress: number, message: string) =>
      onProgress({ skillName: "breed_animals", phase: "Breeding", progress, message, active: true });
    bot.pathfinder.setMovements(baseMoves(bot));

    // Pick the first food we hold (or can withdraw) whose species is nearby.
    for (const { food, species } of FEED) {
      if (count(bot, food) < 2) await tryWithdraw(bot, food, 2);
      if (count(bot, food) < 2) continue;

      const nearby = Object.values(bot.entities)
        .filter((e) => e.name && species.includes(e.name) && e.position.distanceTo(bot.entity.position) < 24)
        // Babies can't be fed into love mode; metadata age < 0 marks a baby on
        // most versions, but it is not always populated, so this is a best
        // effort — feeding a baby is a harmless no-op and the next adult works.
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));

      if (nearby.length < 2) continue;

      let fed = 0;
      for (const animal of nearby) {
        if (fed >= 2 || signal.aborted) break;
        step(0.2 + fed * 0.3, `Feeding ${food.replace("_", " ")} to a ${animal.name} (${fed}/2)...`);
        try {
          await safeGoto(bot, new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 2), 20_000);
        } catch {
          continue;
        }
        if (animal.position.distanceTo(bot.entity.position) > 3.5 || !animal.isValid) continue;
        const foodItem = bot.inventory.items().find((i) => i.name === food);
        if (!foodItem) break;
        try {
          await bot.equip(foodItem, "hand");
          await bot.activateEntity(animal);
          fed++;
          await new Promise((r) => setTimeout(r, 600));
        } catch {
          /* animal moved or full — try the next one */
        }
      }

      if (fed >= 2) {
        // Two fed adults enter love mode and produce a baby within a moment.
        await new Promise((r) => setTimeout(r, 2500));
        return {
          success: true,
          message: `Fed two ${species[0]}s ${food.replace("_", " ")} — they should breed (The Parrots and the Bats).`,
          stats: { fed },
        };
      }
      if (fed === 1) {
        return { success: false, message: resumable(`Fed one ${species[0]}, need a second nearby to breed.`) };
      }
    }

    return {
      success: false,
      message: resumable("No breedable animals within reach of the food I hold — move near cows/sheep/chickens first."),
    };
  },
};
