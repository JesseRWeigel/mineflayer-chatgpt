import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import mcDataLoader from "minecraft-data";
import { baseMoves, safeGoto } from "../bot/navigation.js";

/**
 * oh_shiny — distract a piglin with gold (nether/distract_piglin).
 *
 * Twelve gold ingots sit banked with no other job. Piglins ignore anyone in
 * gold armor, so the skill crafts golden boots first (4 ingots), carries a
 * few more through the village portal, finds a piglin, and tosses an ingot
 * at its feet. The pickup is the advancement. Every leg is bounded and the
 * skill walks itself home through the same portal, win or lose — the Nether
 * has eaten enough bots this run.
 */

function count(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}

function inNether(bot: Bot): boolean {
  const d = String(bot.game.dimension);
  return d === "the_nether" || d === "minecraft:the_nether";
}

async function stepThroughPortal(bot: Bot, wantNether: boolean, budgetMs: number): Promise<boolean> {
  if (inNether(bot) === wantNether) return true;
  const portal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 64 });
  if (!portal) return false;
  // Reuse the crossing that actually earned We Need to Go Deeper. My two
  // rewrites both lost to the same pair of details it already handles:
  // clearing the pathfinder goal before manual controls (else the two fight
  // over steering), and STOPPING inside the frame — holding forward walks
  // straight through and out the far side before the ~4s teleport fires.
  const { crossPortal } = await import("./nether-portal.js");
  const wantDim = (dim: string) => {
    const nether = dim.includes("nether");
    return wantNether ? nether : !nether;
  };
  return crossPortal(bot, portal.position, budgetMs, wantDim);
}

export const ohShinySkill: Skill = {
  name: "oh_shiny",
  description:
    "Put on golden boots, carry gold ingots through the nether portal, and toss one to a piglin — earns the Oh Shiny advancement. Returns home afterward.",
  params: {},
  timeoutMs: 420_000,

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "oh_shiny", phase: "Barter", progress, message, active: true });
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"oh_shiny"} again to continue.`;

    const { withdrawStash } = await import("./stash.js");
    const { STASH_POS } = await import("../bot/role.js");
    const mc = mcDataLoader(bot.version);
    bot.pathfinder.setMovements(baseMoves(bot));

    // --- Overworld prep: boots + ingots ---
    if (!inNether(bot)) {
      const hasBoots =
        bot.inventory.items().some((i) => i.name === "golden_boots") ||
        bot.inventory.slots.some((s) => s?.name === "golden_boots");
      const needGold = (hasBoots ? 0 : 4) + 3 - Math.min(3, count(bot, "gold_ingot"));
      if (needGold > 0) {
        step("Withdrawing gold from the stash...", 0.1);
        const wres = await withdrawStash(bot, STASH_POS, "gold_ingot", needGold, 40_000).catch(
          (e: Error) => `threw: ${e.message}`,
        );
        console.log(`[ShinyDebug] gold withdraw (want ${needGold}): ${wres}`);
        // Ingot drought: the stash's remaining gold is RAW. Take it aboard
        // and hand back — the raw-metal-aboard override smelts whatever a
        // bot carries (Blade's role now includes smelt_ores), and the next
        // firing finds real ingots in the pocket.
        if (count(bot, "gold_ingot") < needGold && count(bot, "raw_gold") < 1) {
          const rres = await withdrawStash(bot, STASH_POS, "raw_gold", 6, 40_000).catch(
            (e: Error) => `threw: ${e.message}`,
          );
          console.log(`[ShinyDebug] raw gold withdraw: ${rres}`);
          if (count(bot, "raw_gold") > 0) {
            return {
              success: false,
              message: resumable(
                `Raw gold aboard (${count(bot, "raw_gold")}) — the smelter reflex cooks it into ingots.`,
              ),
            };
          }
        }
      }
      if (!hasBoots) {
        if (count(bot, "gold_ingot") < 5) {
          return {
            success: false,
            message: resumable(`Need 4 gold for boots plus spare to toss (have ${count(bot, "gold_ingot")}).`),
          };
        }
        step("Crafting golden boots — piglins ignore a golden guest...", 0.2);
        const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 48 });
        if (!table) return { success: false, message: resumable("No crafting table for the boots.") };
        await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20_000).catch(
          () => {},
        );
        const recipe = bot.recipesFor(mc.itemsByName.golden_boots.id, null, 1, table)[0];
        if (!recipe) return { success: false, message: resumable("Golden boots recipe unavailable.") };
        try {
          await bot.craft(recipe, 1, table);
        } catch (e) {
          return { success: false, message: resumable(`Boot craft failed: ${(e as Error).message}.`) };
        }
      }
      const boots = bot.inventory.items().find((i) => i.name === "golden_boots");
      if (boots) await bot.equip(boots, "feet").catch(() => {});
      if (count(bot, "gold_ingot") < 1) {
        return { success: false, message: resumable("Boots on but no ingot left to toss — withdraw more gold.") };
      }

      step("Stepping through the portal...", 0.35);
      const crossed = await stepThroughPortal(bot, true, 30_000);
      if (!crossed) {
        return { success: false, message: resumable("Couldn't reach or cross the portal this trip.") };
      }
    }

    // --- Nether: find a piglin, keep the portal at our back ---
    step("In the Nether — looking for a piglin...", 0.5);
    const homePortal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 24 });
    // Adults only: a baby piglin SNATCHES gold from your hand and grants
    // nothing — no admire, no barter, no criteria progress, which matches
    // this trip's evidence exactly (held gold_ingot -> empty at 1.3 blocks,
    // zero advancement). Babies stand about half height.
    const adultPiglin = (e: { name?: string; height?: number }) => e.name === "piglin" && (e.height ?? 2) > 1.2;
    let piglin = bot.nearestEntity(adultPiglin);
    const scoutUntil = Date.now() + 90_000;
    while (!piglin && Date.now() < scoutUntil && !signal.aborted) {
      // Short bounded arcs around the portal — never out of walking-home range.
      const angle = Math.random() * Math.PI * 2;
      const base = homePortal?.position ?? bot.entity.position;
      await safeGoto(
        bot,
        new goals.GoalNearXZ(base.x + Math.cos(angle) * 32, base.z + Math.sin(angle) * 32, 6),
        30_000,
        12_000,
      ).catch(() => {});
      piglin = bot.nearestEntity(adultPiglin);
    }

    let tossed = 0;
    if (piglin) {
      step(`Piglin spotted — offering gold (${count(bot, "gold_ingot")} ingots aboard)...`, 0.7);
      console.log(`[ShinyDebug] target piglin height=${piglin.height?.toFixed(2)} (adult check passed)`);
      // Direct hand-off FIRST: the first expedition's thrown gold bartered
      // beautifully (crying obsidian came back) yet left ZERO criteria
      // progress on distract_piglin — the pickup never credited the thrower.
      // Using the ingot ON the piglin fires distract_piglin_directly, the
      // advancement's other criterion, deterministically.
      const handGold = bot.inventory.items().find((i) => i.name === "gold_ingot");
      if (handGold && piglin.isValid) {
        await bot.equip(handGold, "hand").catch(() => {});
        await safeGoto(bot, new goals.GoalFollow(piglin, 2), 15_000).catch(() => {});
        if (piglin.isValid) {
          // activateEntity is the right-click INTERACT (the packet the
          // player_interacted_with_entity trigger listens for); useOn is the
          // use-item path for saddles and shears. The first direct attempt
          // sent only useOn and the criteria file stayed empty — send the
          // interact, with held-item and range logged so a miss has a name.
          for (let k = 0; k < 3 && piglin.isValid; k++) {
            await bot.lookAt(piglin.position.offset(0, 1.6, 0), true).catch(() => {});
            const held = bot.heldItem?.name ?? "empty";
            const range = bot.entity.position.distanceTo(piglin.position);
            console.log(`[ShinyDebug] direct hand-off ${k + 1}: held=${held} dist=${range.toFixed(1)}`);
            if (held !== "gold_ingot") {
              const g = bot.inventory.items().find((i) => i.name === "gold_ingot");
              if (!g) break;
              await bot.equip(g, "hand").catch(() => {});
            }
            try {
              await (bot as any).activateEntity(piglin);
            } catch (e) {
              console.log(`[ShinyDebug] activateEntity threw: ${(e as Error).message}`);
              try {
                (bot as any).useOn(piglin);
              } catch {
                /* both paths failed this round */
              }
            }
            await new Promise((r) => setTimeout(r, 2_000));
          }
          tossed++;
          await new Promise((r) => setTimeout(r, 7_000));
        }
      }
      while (tossed < 3 && piglin.isValid && count(bot, "gold_ingot") > 0 && !signal.aborted) {
        await safeGoto(bot, new goals.GoalFollow(piglin, 4), 15_000).catch(() => {});
        if (!piglin.isValid) break;
        const gold = bot.inventory.items().find((i) => i.name === "gold_ingot");
        if (!gold) break;
        await bot.lookAt(piglin.position.offset(0, 1, 0), true);
        await bot.toss(gold.type, null, 1).catch(() => {});
        tossed++;
        // The piglin walks over, picks it up, and admires it for six seconds.
        await new Promise((r) => setTimeout(r, 9_000));
      }
    }

    // --- Walk home, always ---
    step("Heading back through the portal...", 0.9);
    if (homePortal) {
      await safeGoto(
        bot,
        new goals.GoalNear(homePortal.position.x, homePortal.position.y, homePortal.position.z, 0),
        60_000,
      ).catch(() => {});
      await stepThroughPortal(bot, false, 30_000);
    }

    console.log(
      `[ShinyDebug] ${bot.username}: piglin=${!!piglin} tossed=${tossed} home=${!inNether(bot)} goldLeft=${count(bot, "gold_ingot")}`,
    );
    if (tossed > 0) {
      return {
        success: true,
        message: `Tossed ${tossed} gold to a piglin — Oh Shiny should be banked (files will confirm).`,
        stats: { tossed },
      };
    }
    if (!piglin) {
      return { success: false, message: resumable("No piglin found within the safe arc this trip.") };
    }
    return { success: false, message: resumable("Found a piglin but the gold never left the pocket.") };
  },
};
