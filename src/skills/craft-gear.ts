import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { LOG_TYPES } from "./materials.js";
import mcDataLoader from "minecraft-data";

/** Tool tiers from best to worst. */
const TIERS = [
  { name: "diamond", material: "diamond" },
  { name: "iron", material: "iron_ingot" },
  { name: "stone", material: "cobblestone" },
  { name: "wooden", material: "oak_planks" },
];

const TOOL_TYPES = ["pickaxe", "axe", "sword", "shovel"];

export const craftGearSkill: Skill = {
  name: "craft_gear",
  description: "Craft the best tool set (pickaxe, axe, sword, shovel) from available materials. No gathering needed — uses what's in inventory.",
  params: {},

  estimateMaterials(_bot, _params) {
    // This skill uses whatever is already in inventory — no gathering phase
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const mcData = mcDataLoader(bot.version);
    const crafted: string[] = [];
    let total = TOOL_TYPES.length;
    let done = 0;

    // Ensure we have sticks (need at least 8 for a full set)
    await ensureSticks(bot, 8, signal);

    for (const toolType of TOOL_TYPES) {
      if (signal.aborted) break;

      done++;
      onProgress({
        skillName: "craft_gear",
        phase: "Crafting tools",
        progress: done / total,
        message: `Trying to craft ${toolType}...`,
        active: true,
      });

      // Try each tier from best to worst
      for (const tier of TIERS) {
        const itemName = `${tier.name}_${toolType}`;
        const mcItem = mcData.itemsByName[itemName];
        if (!mcItem) continue;

        // Check if we already have this or better
        const have = bot.inventory.items().find((i) => i.name === itemName);
        if (have) {
          crafted.push(`${itemName} (already had)`);
          break;
        }

        // Find crafting table if needed for 3x3 recipe
        let table = bot.findBlock({
          matching: (b) => b.name === "crafting_table",
          maxDistance: 32,
        });

        let recipe = table
          ? bot.recipesFor(mcItem.id, null, 1, table)[0]
          : bot.recipesFor(mcItem.id, null, 1, null)[0];

        if (!recipe) continue;

        // Navigate to table if needed
        if (table && recipe) {
          const pkg = await import("mineflayer-pathfinder");
          const { goals, Movements } = pkg.default;
          const moves = new Movements(bot);
          moves.canDig = false;
          bot.pathfinder.setMovements(moves);
          try {
            await bot.pathfinder.goto(
              new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2),
            );
          } catch { /* try anyway */ }
        }

        try {
          await bot.craft(recipe, 1, table || undefined);
          crafted.push(itemName);
          break;
        } catch {
          continue;
        }
      }
    }

    if (crafted.length === 0) {
      return {
        success: false,
        message: "Couldn't craft any tools. Need materials: wood, cobblestone, iron, or diamonds!",
      };
    }

    return {
      success: true,
      message: `Gear crafted! Got: ${crafted.join(", ")}. Ready for action!`,
      stats: { toolsCrafted: crafted.length },
    };
  },
};

async function ensureSticks(bot: Bot, count: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const mcData = mcDataLoader(bot.version);
  const stickItem = mcData.itemsByName["stick"];
  if (!stickItem) return;

  const have = bot.inventory.items().filter((i) => i.name === "stick").reduce((s, i) => s + i.count, 0);
  if (have >= count) return;

  // First ensure we have planks — craft any log type into its planks
  for (const logType of LOG_TYPES) {
    if (signal.aborted) break;
    const logCount = bot.inventory.items()
      .filter((i) => i.name === logType)
      .reduce((s, i) => s + i.count, 0);
    if (logCount === 0) continue;

    const plankName = logType.replace("_log", "_planks");
    const mcItem = mcData.itemsByName[plankName];
    if (!mcItem) continue;

    // Craft a few logs into planks (don't convert all — just need enough for sticks)
    const craftCount = Math.min(logCount, 3);
    for (let i = 0; i < craftCount; i++) {
      const recipe = bot.recipesFor(mcItem.id, null, 1, null)[0];
      if (!recipe) break;
      try { await bot.craft(recipe, 1, undefined); } catch { break; }
    }
    break; // One log type is enough for sticks
  }

  // Now craft sticks (recipe uses any plank type via tags)
  const stickRecipe = bot.recipesFor(stickItem.id, null, 1, null)[0];
  if (stickRecipe) {
    const need = Math.ceil((count - have) / 4);
    try { await bot.craft(stickRecipe, need, undefined); } catch { /* ok */ }
  }
}
