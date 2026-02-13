import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";

export const buildFarmSkill: Skill = {
  name: "build_farm",
  description:
    "Build a wheat farm near water. Crafts a hoe, collects seeds, tills soil, plants crops. If mature wheat exists nearby, harvests and replants instead. Takes ~2 minutes.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    // --- Step 0: Harvest mature wheat if any nearby ---
    const harvested = await harvestMatureWheat(bot, signal, onProgress);
    if (harvested > 0) {
      return {
        success: true,
        message: `Harvested ${harvested} mature wheat! Got wheat and seeds. The farm cycle continues!`,
        stats: { wheatHarvested: harvested },
      };
    }

    // --- Step 1: Ensure we have a hoe ---
    onProgress({ skillName: "build_farm", phase: "Preparing tools", progress: 0, message: "Looking for a hoe...", active: true });

    let hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
    if (!hoe) {
      await craftHoe(bot, signal);
      hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
      if (!hoe) {
        return { success: false, message: "Can't craft a hoe! Need planks + sticks + a crafting table." };
      }
    }

    // --- Step 2: Find water ---
    onProgress({ skillName: "build_farm", phase: "Finding water", progress: 0.05, message: "Searching for water...", active: true });

    const water = bot.findBlock({
      matching: (b) => b.name === "water",
      maxDistance: 48,
    });
    if (!water) {
      return { success: false, message: "No water nearby! Explore to find a river or lake, then try build_farm." };
    }

    setMovements(bot);
    try {
      await bot.pathfinder.goto(new goals.GoalNear(water.position.x, water.position.y + 1, water.position.z, 4));
    } catch { /* ok */ }

    // --- Step 3: Collect seeds by breaking grass ---
    onProgress({ skillName: "build_farm", phase: "Collecting seeds", progress: 0.1, message: "Breaking grass for seeds...", active: true });

    let seedCount = countItem(bot, "wheat_seeds");
    for (let i = 0; i < 50 && seedCount < 16 && !signal.aborted; i++) {
      const grass = bot.findBlock({
        matching: (b) => b.name === "short_grass" || b.name === "tall_grass",
        maxDistance: 24,
      });
      if (!grass) break;

      try {
        setMovements(bot);
        await bot.pathfinder.goto(new goals.GoalNear(grass.position.x, grass.position.y, grass.position.z, 2));
        await bot.dig(grass);
        seedCount = countItem(bot, "wheat_seeds");
      } catch { continue; }
    }

    if (seedCount === 0) {
      return { success: false, message: "No seeds from grass! Try a grassier biome." };
    }

    // --- Step 4: Hoe dirt near water and plant ---
    onProgress({ skillName: "build_farm", phase: "Planting crops", progress: 0.25, message: "Tilling soil and planting...", active: true });

    let planted = 0;
    const target = Math.min(seedCount, 16);

    for (let i = 0; i < target + 25 && planted < target && !signal.aborted; i++) {
      // Find dirt/grass_block near water (within 4 blocks for hydration)
      const dirt = bot.findBlock({
        matching: (b) => {
          if (b.name !== "dirt" && b.name !== "grass_block") return false;
          return b.position.distanceTo(water.position) <= 5;
        },
        maxDistance: 20,
      });
      if (!dirt) break;

      try {
        setMovements(bot);
        await bot.pathfinder.goto(new goals.GoalNear(dirt.position.x, dirt.position.y, dirt.position.z, 2));

        // Equip hoe and till
        hoe = bot.inventory.items().find((it) => it.name.endsWith("_hoe"));
        if (!hoe) break;
        await bot.equip(hoe, "hand");
        await bot.activateBlock(dirt);
        await bot.waitForTicks(3);

        // Check if it became farmland
        const result = bot.blockAt(dirt.position);
        if (result && result.name === "farmland") {
          const seeds = bot.inventory.items().find((it) => it.name === "wheat_seeds");
          if (seeds) {
            await bot.equip(seeds, "hand");
            try {
              await bot.placeBlock(result, new Vec3(0, 1, 0));
              planted++;
              onProgress({
                skillName: "build_farm",
                phase: "Planting crops",
                progress: 0.25 + (planted / target) * 0.7,
                message: `Planted ${planted}/${target} wheat`,
                active: true,
              });
            } catch { /* skip this spot */ }
          }
        }
      } catch { continue; }
    }

    if (planted === 0) {
      return { success: false, message: "Couldn't plant anything. Need dirt blocks near water!" };
    }

    return {
      success: true,
      message: `Farm planted! ${planted} wheat seeds near water at ${water.position.x.toFixed(0)}, ${water.position.z.toFixed(0)}. Wheat grows in ~5 minutes — come back and use build_farm again to harvest!`,
      stats: { cropsPlanted: planted },
    };
  },
};

// --- Helpers ---

function setMovements(bot: Bot) {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  bot.pathfinder.setMovements(moves);
}

function countItem(bot: Bot, name: string): number {
  return bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
}

/** Harvest all mature wheat within 20 blocks. Returns count harvested. */
async function harvestMatureWheat(
  bot: Bot,
  signal: AbortSignal,
  onProgress: (p: any) => void,
): Promise<number> {
  let harvested = 0;

  for (let i = 0; i < 40 && !signal.aborted; i++) {
    const wheat = bot.findBlock({
      matching: (b) => b.name === "wheat" && b.metadata >= 7,
      maxDistance: 20,
    });
    if (!wheat) break;

    try {
      setMovements(bot);
      await bot.pathfinder.goto(new goals.GoalNear(wheat.position.x, wheat.position.y, wheat.position.z, 2));
      await bot.dig(wheat);
      harvested++;
      onProgress({
        skillName: "build_farm",
        phase: "Harvesting",
        progress: harvested / 20,
        message: `Harvested ${harvested} wheat`,
        active: true,
      });
    } catch { continue; }
  }

  // Replant seeds on empty farmland after harvesting
  if (harvested > 0) {
    let replanted = 0;
    for (let i = 0; i < 40 && !signal.aborted; i++) {
      const farmland = bot.findBlock({
        matching: (b) => {
          if (b.name !== "farmland") return false;
          const above = bot.blockAt(b.position.offset(0, 1, 0));
          return above !== null && above.name === "air";
        },
        maxDistance: 20,
      });
      if (!farmland) break;

      const seeds = bot.inventory.items().find((it) => it.name === "wheat_seeds");
      if (!seeds) break;

      try {
        setMovements(bot);
        await bot.pathfinder.goto(new goals.GoalNear(farmland.position.x, farmland.position.y, farmland.position.z, 2));
        await bot.equip(seeds, "hand");
        await bot.placeBlock(farmland, new Vec3(0, 1, 0));
        replanted++;
      } catch { continue; }
    }
    console.log(`[Skill] Harvested ${harvested} wheat, replanted ${replanted} seeds`);
  }

  return harvested;
}

async function craftHoe(bot: Bot, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const mcData = mcDataLoader(bot.version);

  // Ensure sticks
  const stickItem = mcData.itemsByName["stick"];
  if (stickItem) {
    const recipe = bot.recipesFor(stickItem.id, null, 1, null)[0];
    if (recipe) {
      try { await bot.craft(recipe, 1, undefined); } catch { /* ok */ }
    }
  }

  // Try each hoe tier (cheapest first — wooden only needs planks)
  const hoeTiers = ["wooden_hoe", "stone_hoe", "iron_hoe"];
  for (const hoeName of hoeTiers) {
    const mcItem = mcData.itemsByName[hoeName];
    if (!mcItem) continue;

    let recipe = bot.recipesFor(mcItem.id, null, 1, null)[0];
    if (recipe) {
      try { await bot.craft(recipe, 1, undefined); return; } catch { continue; }
    }

    const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
    if (table) {
      setMovements(bot);
      try {
        await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
      } catch { /* try anyway */ }
      recipe = bot.recipesFor(mcItem.id, null, 1, table)[0];
      if (recipe) {
        try { await bot.craft(recipe, 1, table); return; } catch { continue; }
      }
    }
  }
}
