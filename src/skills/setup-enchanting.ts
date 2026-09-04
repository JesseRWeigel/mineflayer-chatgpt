import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import mcDataLoader from "minecraft-data";
import { baseMoves, safeGoto, collectNearbyDrops } from "../bot/navigation.js";

/**
 * setup_enchanting — earn the Enchanter advancement deterministically.
 *
 * The strategic model is told "enchant an item at a table" and wanders off,
 * exactly like it did with the portal until build_nether_portal did every step
 * in order. This skill is that same deterministic chain for enchanting:
 *
 *   obsidian x4 (stash)  +  diamond x2 (held)  +  book x1  ->  enchanting_table
 *   book  =  paper x3 (sugar cane)  +  leather x1 (cow)
 *   place the table  ->  put a spare tool + lapis + spend XP  ->  Enchanter.
 *
 * Every material is stash-first, then a bounded gather, then a resumable
 * hand-back so partial progress banks and the next invocation continues.
 */

const RUN_MS = 420_000;

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
    const near = Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z) < 60;
    if (!near) return;
    await Promise.race([withdrawStash(bot, STASH_POS, name, n), new Promise<void>((r) => setTimeout(r, 45_000))]).catch(
      () => {},
    );
  } catch {
    /* stash unavailable */
  }
}

/** Craft `want` x`n` at a nearby table (or none for 2x2 recipes). Best-effort. */
async function craft(bot: Bot, want: string, n: number, needTable: boolean): Promise<boolean> {
  const mc = mcDataLoader(bot.version);
  const item = mc.itemsByName[want];
  if (!item) return false;
  let table = null;
  if (needTable) {
    table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 48 });
    if (!table) return false;
    try {
      await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20_000);
    } catch {
      /* craft still tries from where we are */
    }
  }
  const recipe = bot.recipesFor(item.id, null, n, table)[0];
  if (!recipe) return false;
  try {
    await bot.craft(recipe, n, table ?? undefined);
    return true;
  } catch {
    return false;
  }
}

export const setupEnchantingSkill: Skill = {
  name: "setup_enchanting",
  description:
    "Build an enchanting table (4 obsidian + 2 diamonds + 1 book) near the stash and enchant a spare tool — earns the Enchanter advancement. Gathers the book (paper from sugar cane, leather from cows) and lapis as needed.",
  params: {},
  timeoutMs: 480_000,

  estimateMaterials() {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const deadline = Date.now() + RUN_MS;
    const timeLeft = () => deadline - Date.now();
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"setup_enchanting"} again to continue from here.`;
    const step = (phase: string, progress: number, message: string) =>
      onProgress({ skillName: "setup_enchanting", phase, progress, message, active: true });

    const { STASH_POS } = await import("../bot/role.js");
    bot.pathfinder.setMovements(baseMoves(bot));

    // If the table already stands, jump straight to enchanting.
    let table = bot.findBlock({ matching: (b) => b.name === "enchanting_table", maxDistance: 24 });

    if (!table) {
      // Walk to the stash first — the banked obsidian, diamonds and book
      // parts all live there, and tryWithdraw only fires within 60 blocks.
      // The override can trigger from anywhere (Forge lands here from the
      // mine 300 blocks out), so the first pass would withdraw nothing.
      const homeGap = () => Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z);
      if (homeGap() > 55) {
        step("Home", 0.02, `Walking to the stash to gather materials (${homeGap().toFixed(0)} away)...`);
        const walkDeadline = Date.now() + 150_000;
        while (Date.now() < walkDeadline && homeGap() > 55) {
          if (timeLeft() < 90_000) break;
          await safeGoto(bot, new goals.GoalXZ(STASH_POS.x, STASH_POS.z), 45_000, 12_000).catch(() => {});
          if (homeGap() > 55) await new Promise((r) => setTimeout(r, 2000));
        }
        if (homeGap() > 55) {
          return {
            success: false,
            message: resumable(`Heading to the stash — still ${homeGap().toFixed(0)} blocks out.`),
          };
        }
      }

      // --- Materials for the table ---
      step("Obsidian", 0.05, "Gathering 4 obsidian for the table...");
      if (count(bot, "obsidian") < 4) await tryWithdraw(bot, "obsidian", 4 - count(bot, "obsidian"));
      if (count(bot, "obsidian") < 4) {
        return {
          success: false,
          message: resumable(`Need 4 obsidian for the enchanting table, have ${count(bot, "obsidian")}.`),
        };
      }

      step("Diamonds", 0.15, "Checking diamonds...");
      if (count(bot, "diamond") < 2) await tryWithdraw(bot, "diamond", 2 - count(bot, "diamond"));
      if (count(bot, "diamond") < 2) {
        return {
          success: false,
          message: resumable(`Need 2 diamonds for the enchanting table, have ${count(bot, "diamond")}.`),
        };
      }

      // --- Book: 3 paper + 1 leather ---
      if (count(bot, "book") < 1) {
        step("Book", 0.25, "Assembling a book (3 paper + 1 leather)...");
        await tryWithdraw(bot, "book", 1);
      }
      if (count(bot, "book") < 1) {
        // Paper from sugar cane.
        if (count(bot, "paper") < 3) {
          await tryWithdraw(bot, "paper", 3 - count(bot, "paper"));
          if (count(bot, "paper") < 3 && count(bot, "sugar_cane") >= 1) {
            await craft(bot, "paper", Math.floor(count(bot, "sugar_cane") / 1), false);
          }
          if (count(bot, "paper") < 3) {
            // Harvest sugar cane if any is in reach.
            if (timeLeft() > 90_000) {
              const cane = bot.findBlock({ matching: (b) => b.name === "sugar_cane", maxDistance: 48 });
              if (cane) {
                step("Book", 0.3, "Harvesting sugar cane for paper...");
                try {
                  await safeGoto(bot, new goals.GoalNear(cane.position.x, cane.position.y, cane.position.z, 1), 30_000);
                  const b = bot.blockAt(cane.position);
                  if (b) await bot.dig(b).catch(() => {});
                  await collectNearbyDrops(bot, 4, 3000);
                } catch {
                  /* best effort */
                }
                if (count(bot, "sugar_cane") >= 3) await craft(bot, "paper", 1, false);
              }
            }
          }
        }
        // Leather from a cow.
        if (count(bot, "paper") >= 3 && count(bot, "leather") < 1) {
          await tryWithdraw(bot, "leather", 1);
          if (count(bot, "leather") < 1 && timeLeft() > 90_000) {
            const cow = bot.nearestEntity((e) => e.name === "cow" || e.name === "mooshroom");
            if (cow) {
              step("Book", 0.35, "Hunting a cow for leather...");
              try {
                await safeGoto(bot, new goals.GoalNear(cow.position.x, cow.position.y, cow.position.z, 2), 30_000);
                for (let s = 0; s < 8 && cow.isValid; s++) {
                  await bot.attack(cow);
                  await new Promise((r) => setTimeout(r, 700));
                }
                await collectNearbyDrops(bot, 5, 3000);
              } catch {
                /* best effort */
              }
            }
          }
        }
        // Craft the book if both parts are in hand.
        if (count(bot, "paper") >= 3 && count(bot, "leather") >= 1) {
          step("Book", 0.4, "Crafting the book...");
          await craft(bot, "book", 1, true);
        }
      }
      if (count(bot, "book") < 1) {
        const need: string[] = [];
        if (count(bot, "paper") < 3) need.push(`paper (${count(bot, "paper")}/3 — from sugar cane)`);
        if (count(bot, "leather") < 1) need.push("leather (from a cow)");
        return { success: false, message: resumable(`Still need for the book: ${need.join(", ") || "assembly"}.`) };
      }

      // --- Craft and place the table ---
      step("Table", 0.55, "Crafting the enchanting table...");
      if (!(await craft(bot, "enchanting_table", 1, true)) || count(bot, "enchanting_table") < 1) {
        return { success: false, message: resumable("Have the materials but couldn't craft the table near a table.") };
      }

      step("Table", 0.65, "Placing the enchanting table by the stash...");
      try {
        await safeGoto(bot, new goals.GoalNear(STASH_POS.x, STASH_POS.y, STASH_POS.z, 3), 45_000);
      } catch {
        /* place where we are */
      }
      const here = bot.entity.position.floored();
      const tableItem = bot.inventory.items().find((i) => i.name === "enchanting_table");
      const spots = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
      for (const d of spots) {
        const target = here.plus(d);
        const below = bot.blockAt(target.offset(0, -1, 0));
        const at = bot.blockAt(target);
        if (tableItem && below && below.name !== "air" && at && (at.name === "air" || at.name === "cave_air")) {
          try {
            await bot.equip(tableItem, "hand");
            await bot.placeBlock(below, new Vec3(0, 1, 0));
            break;
          } catch {
            /* try the next spot */
          }
        }
      }
      table = bot.findBlock({ matching: (b) => b.name === "enchanting_table", maxDistance: 8 });
      if (!table) {
        return {
          success: false,
          message: resumable("Crafted the table but couldn't place it — retry near open ground."),
        };
      }
    }

    // --- Enchant a spare tool ---
    step("Enchant", 0.8, "Enchanting a tool at the table...");

    // Lapis: at least one.
    if (count(bot, "lapis_lazuli") < 1) await tryWithdraw(bot, "lapis_lazuli", 3);
    if (count(bot, "lapis_lazuli") < 1) {
      return {
        success: false,
        message: resumable("Enchanting table is up but I have no lapis lazuli — mine or withdraw some, then continue."),
      };
    }

    // A spare, non-best enchantable tool: prefer a lesser pickaxe/tool so we
    // never enchant away the bot's working gear.
    const RANK: Record<string, number> = { wooden: 0, stone: 1, golden: 1, iron: 2, diamond: 3, netherite: 4 };
    const tools = bot.inventory
      .items()
      .filter((i) => /_pickaxe$|_axe$|_shovel$|_sword$|_hoe$/.test(i.name))
      .sort((a, b) => (RANK[a.name.split("_")[0]] ?? 0) - (RANK[b.name.split("_")[0]] ?? 0));
    const target = tools[0];
    if (!target) {
      return {
        success: false,
        message: resumable("No spare tool to enchant — craft any pickaxe first, then continue."),
      };
    }

    try {
      await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20_000);
    } catch {
      /* openBlock works from close range */
    }

    try {
      const et: any = await (bot as any).openEnchantmentTable(table);
      await et.putTargetItem(target);
      const lapis = bot.inventory.items().find((i) => i.name === "lapis_lazuli");
      if (lapis) await et.putLapis(lapis);
      // Wait for the enchant options to populate, then take the cheapest (0).
      await Promise.race([
        new Promise<void>((resolve) => et.once("ready", resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 8000)),
      ]);
      await et.enchant(0);
      await new Promise((r) => setTimeout(r, 600));
      try {
        await et.takeTargetItem();
      } catch {
        /* item auto-returned on some versions */
      }
      et.close();
      return {
        success: true,
        message: `Enchanted a ${target.name} at the enchanting table — Enchanter earned!`,
        stats: { enchanted: 1 },
      };
    } catch (e) {
      return {
        success: false,
        message: resumable(
          `Table is placed and I have lapis, but the enchant didn't complete (${(e as Error).message}).`,
        ),
      };
    }
  },
};
