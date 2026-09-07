import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto, collectNearbyDrops } from "../bot/navigation.js";

/**
 * hunt_leather — opportunistic leather harvest for the Enchanter chain.
 *
 * The book needs 1 leather, and Forge's own hunt is one pair of eyes sweeping
 * from the stash. Herds spawn wherever they like; the bot most likely to be
 * standing next to one is whichever bot happens to be out there. This skill
 * fires ONLY when a leather-bearing animal is already visible — the brain
 * reflex that invokes it checks first — kills it, sweeps the drops, and hands
 * back. The leather then reaches Forge through the routing reflex or the
 * stash ledger, both of which already know the way.
 */

const LEATHER_DROPPERS = new Set(["cow", "mooshroom", "horse", "donkey", "mule", "llama", "trader_llama"]);

function countLeather(bot: Bot): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === "leather")
    .reduce((s, i) => s + i.count, 0);
}

export function nearestLeatherDropper(bot: Bot) {
  return bot.nearestEntity((e) => LEATHER_DROPPERS.has(e.name ?? ""));
}

export const huntLeatherSkill: Skill = {
  name: "hunt_leather",
  description:
    "Kill a visible leather-bearing animal (cow, horse, donkey, mule, llama) and collect the leather for the enchanting book. Only works when one is already in sight.",
  params: {},

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "hunt_leather", phase: "Hunt", progress, message, active: true });

    const target = nearestLeatherDropper(bot);
    if (!target) {
      return { success: false, message: "No leather-bearing animal in sight." };
    }

    const species = target.name ?? "animal";
    const startDist = bot.entity.position.distanceTo(target.position);
    step(`Hunting a ${species} (${startDist.toFixed(0)} blocks away)...`, 0.2);

    // A full pocket can't pick the drop up — the likely story behind a night
    // of confirmed kills with zero leather banked. Shed mining junk first.
    if (bot.inventory.emptySlotCount() < 2) {
      const JUNK = new Set([
        "cobblestone",
        "cobbled_deepslate",
        "dirt",
        "gravel",
        "andesite",
        "diorite",
        "granite",
        "tuff",
        "netherrack",
      ]);
      for (const it of bot.inventory.items()) {
        if (bot.inventory.emptySlotCount() >= 2) break;
        if (JUNK.has(it.name)) await bot.toss(it.type, null, it.count).catch(() => {});
      }
    }

    const before = countLeather(bot);
    const weapon =
      bot.inventory.items().find((i) => i.name.endsWith("_sword")) ??
      bot.inventory.items().find((i) => i.name.endsWith("_axe")) ??
      bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
    if (weapon) await bot.equip(weapon, "hand").catch(() => {});

    bot.pathfinder.setMovements(baseMoves(bot));
    const fightUntil = Date.now() + 40_000;
    let swings = 0;
    try {
      while (target.isValid && Date.now() < fightUntil && !signal.aborted) {
        if (bot.entity.position.distanceTo(target.position) > 2.5) {
          await safeGoto(bot, new goals.GoalFollow(target, 1.5), 8_000).catch(() => {});
        }
        if (!target.isValid) break;
        await bot.attack(target);
        swings++;
        // Full attack-cooldown charge between swings: 600ms spam looked
        // faster but 1.21 scales damage by charge, and two of the first
        // three fights TIMED OUT with the animal alive on chip damage.
        await new Promise((r) => setTimeout(r, 1150));
      }
      step("Sweeping the drops...", 0.8);
      await collectNearbyDrops(bot, 8, 7000);
    } catch {
      /* best effort — the delta below is the honest verdict */
    }

    const gained = countLeather(bot) - before;
    console.log(
      `[HuntDebug] ${bot.username} vs ${species}: start=${startDist.toFixed(1)} swings=${swings} ` +
        `targetDead=${!target.isValid} leather ${before}->${before + gained}`,
    );
    if (gained > 0) {
      return { success: true, message: `Got ${gained} leather from a ${species}!`, stats: { leather: gained } };
    }
    if (!target.isValid) {
      return { success: false, message: `Killed the ${species} but it dropped no leather — hunt continues.` };
    }
    return { success: false, message: `The ${species} got away.` };
  },
};
