import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";
import { baseMoves } from "../bot/navigation.js";

const FISH_ATTEMPTS = 5;
const BITE_TIMEOUT_MS = 35000;

export const goFishingSkill: Skill = {
  name: "go_fishing",
  description:
    "Fish at nearby water for food and loot. Crafts a fishing rod if possible (needs 3 sticks + 2 string). Catches ~3-5 items.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    // --- Step 1: Get or craft a fishing rod ---
    onProgress({
      skillName: "go_fishing",
      phase: "Preparing",
      progress: 0,
      message: "Looking for fishing rod...",
      active: true,
    });

    let rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
    if (!rod) {
      // Self-supply the rod: withdraw a spare or its string from the stash,
      // then kill a loaded spider for string, before crafting. Without this
      // the skill dead-ended on "need string" every time and never fished.
      const held = (n: string) =>
        bot.inventory
          .items()
          .filter((i) => i.name === n)
          .reduce((s, i) => s + i.count, 0);
      try {
        const { withdrawStash } = await import("./stash.js");
        const { STASH_POS } = await import("../bot/role.js");
        if (Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z) < 60) {
          await Promise.race([
            withdrawStash(bot, STASH_POS, "fishing_rod", 1),
            new Promise((r) => setTimeout(r, 30_000)),
          ]).catch(() => {});
          if (!bot.inventory.items().some((i) => i.name === "fishing_rod") && held("string") < 2) {
            await Promise.race([
              withdrawStash(bot, STASH_POS, "string", 2),
              new Promise((r) => setTimeout(r, 30_000)),
            ]).catch(() => {});
          }
        }
      } catch {
        /* stash unavailable */
      }
      rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
      // Hunt a loaded spider for string when we still lack it.
      if (!rod && held("string") < 2) {
        const spider = bot.nearestEntity((e) => e.name === "spider" || e.name === "cave_spider");
        if (spider && spider.position.distanceTo(bot.entity.position) < 24) {
          onProgress({
            skillName: "go_fishing",
            phase: "Preparing",
            progress: 0.02,
            message: "Hunting a spider for string...",
            active: true,
          });
          try {
            const { baseMoves } = await import("../bot/navigation.js");
            bot.pathfinder.setMovements(baseMoves(bot));
            await bot.pathfinder.goto(new goals.GoalNear(spider.position.x, spider.position.y, spider.position.z, 2));
            const sword = bot.inventory.items().find((i) => i.name.endsWith("_sword"));
            if (sword) await bot.equip(sword, "hand").catch(() => {});
            for (let s = 0; s < 10 && spider.isValid; s++) {
              await bot.attack(spider);
              await new Promise((r) => setTimeout(r, 600));
            }
            const { collectNearbyDrops } = await import("../bot/navigation.js");
            await collectNearbyDrops(bot, 5, 3000);
          } catch {
            /* best effort */
          }
        }
      }
      if (!rod) {
        await craftFishingRod(bot, signal);
        rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
      }
      if (!rod) {
        return {
          success: false,
          message:
            "Can't fish yet — need a fishing rod (3 sticks + 2 string). No string; kill a spider or find cobwebs, then invoke_skill go_fishing again.",
        };
      }
    }

    // --- Step 2: Find water ---
    onProgress({
      skillName: "go_fishing",
      phase: "Finding water",
      progress: 0.05,
      message: "Heading to water...",
      active: true,
    });

    const water = bot.findBlock({
      matching: (b) => b.name === "water",
      maxDistance: 48,
    });
    if (!water) {
      return { success: false, message: "No water nearby! Explore to find a lake or river." };
    }

    // Navigate to water's edge (stand on the bank, not in the water)
    setMovements(bot);
    try {
      await bot.pathfinder.goto(new goals.GoalNear(water.position.x, water.position.y + 1, water.position.z, 3));
    } catch {
      /* try anyway */
    }

    // --- Step 3: Fish! ---
    let caught = 0;
    const catches: string[] = [];

    for (let attempt = 0; attempt < FISH_ATTEMPTS && !signal.aborted; attempt++) {
      onProgress({
        skillName: "go_fishing",
        phase: "Fishing",
        progress: 0.1 + (attempt / FISH_ATTEMPTS) * 0.85,
        message: `Cast ${attempt + 1}/${FISH_ATTEMPTS} | Caught: ${caught}`,
        active: true,
      });

      rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
      if (!rod) break;

      try {
        await bot.equip(rod, "hand");
        await bot.lookAt(water.position.offset(0.5, 1, 0.5));

        // Cast the line
        bot.activateItem();
        await bot.waitForTicks(20);

        // Wait for a bite (bobber dip detection)
        const gotBite = await waitForBite(bot, signal, BITE_TIMEOUT_MS);

        // Reel in
        bot.activateItem();
        await bot.waitForTicks(10);

        if (gotBite) {
          caught++;
          catches.push("catch");
          console.log(`[Skill] Fish caught! (#${caught})`);
        }
      } catch {
        // Clean up - make sure rod is deactivated
        try {
          bot.deactivateItem();
        } catch {
          /* ok */
        }
        continue;
      }
    }

    if (caught === 0) {
      return { success: false, message: "Didn't catch anything! The fish outsmarted me. Try again near deeper water." };
    }

    return {
      success: true,
      message: `Fishing trip done! Caught ${caught} items in ${FISH_ATTEMPTS} casts. Fresh fish dinner!`,
      stats: { fishCaught: caught },
    };
  },
};

/** Wait for the fishing bobber to dip, indicating a bite. */
async function waitForBite(bot: Bot, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let resolved = false;

    const cleanup = () => {
      resolved = true;
      clearTimeout(timeout);
      clearInterval(check);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(() => {
      if (!resolved) {
        cleanup();
        resolve(false);
      }
    }, timeoutMs);

    let bobber: any = null;
    let lastY = 0;
    let stableCount = 0;

    const check = setInterval(() => {
      if (resolved) return;

      // Find bobber entity
      if (!bobber) {
        for (const entity of Object.values(bot.entities)) {
          const name = entity.name || (entity as any).objectType || "";
          if (
            (name === "fishing_bobber" || name === "fishing_float") &&
            entity.position.distanceTo(bot.entity.position) < 40
          ) {
            bobber = entity;
            lastY = entity.position.y;
            stableCount = 0;
            break;
          }
        }
        return;
      }

      // Check if bobber is gone (someone else reeled in, or entity despawned)
      if (!bobber.isValid) {
        cleanup();
        resolve(false);
        return;
      }

      const currentY = bobber.position.y;
      const dy = currentY - lastY;

      // Wait for bobber to settle on water (~5 ticks of stability)
      if (Math.abs(dy) < 0.05) {
        stableCount++;
      } else if (stableCount < 5) {
        // Still landing/bouncing
        stableCount = 0;
      }

      // Once stable, watch for the dip (Y decreases when fish bites)
      if (stableCount > 5 && dy < -0.1) {
        cleanup();
        resolve(true);
        return;
      }

      lastY = currentY;
    }, 100);
  });
}

function setMovements(bot: Bot) {
  const moves = baseMoves(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = false;
  moves.scafoldingBlocks = [];
  bot.pathfinder.setMovements(moves);
}

async function craftFishingRod(bot: Bot, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const mcData = mcDataLoader(bot.version);

  // Need 3 sticks + 2 string
  const stringCount = bot.inventory
    .items()
    .filter((i) => i.name === "string")
    .reduce((s, i) => s + i.count, 0);
  if (stringCount < 2) return;

  // Ensure sticks
  const stickItem = mcData.itemsByName["stick"];
  if (stickItem) {
    const stickCount = bot.inventory
      .items()
      .filter((i) => i.name === "stick")
      .reduce((s, i) => s + i.count, 0);
    if (stickCount < 3) {
      const recipe = bot.recipesFor(stickItem.id, null, 1, null)[0];
      if (recipe) {
        try {
          await bot.craft(recipe, 1, undefined);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  // Craft fishing rod (needs crafting table)
  const rodItem = mcData.itemsByName["fishing_rod"];
  if (!rodItem) return;

  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  if (table) {
    setMovements(bot);
    try {
      await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
    } catch {
      /* best-effort */
    }
    const recipe = bot.recipesFor(rodItem.id, null, 1, table)[0];
    if (recipe) {
      try {
        await bot.craft(recipe, 1, table);
      } catch {
        /* best-effort */
      }
    }
  }
}
