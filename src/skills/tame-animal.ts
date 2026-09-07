import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";

/**
 * tame_animal — earn Best Friends Forever by taming a horse the honest way.
 *
 * Horses tame through persistence alone: mount, get bucked off, mount again
 * until the temper meter fills — no items, no food, no tools. The bot mounts
 * the animal repeatedly and reads success from the one signal the server
 * can't fake: staying in the saddle. Donkeys and mules work identically.
 */

const TAMEABLE = new Set(["horse", "donkey", "mule"]);

export function nearestTameable(bot: Bot) {
  return bot.nearestEntity((e) => TAMEABLE.has(e.name ?? ""));
}

export const tameAnimalSkill: Skill = {
  name: "tame_animal",
  description:
    "Tame a visible horse, donkey, or mule by mounting it until it accepts you — earns the Best Friends Forever advancement. Only works when one is already in sight.",
  params: {},

  estimateMaterials(): Record<string, number> {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const step = (message: string, progress: number) =>
      onProgress({ skillName: "tame_animal", phase: "Tame", progress, message, active: true });

    const target = nearestTameable(bot);
    if (!target) {
      return { success: false, message: "No horse, donkey, or mule in sight." };
    }

    const species = target.name ?? "horse";
    step(`Approaching a ${species} (${bot.entity.position.distanceTo(target.position).toFixed(0)} blocks)...`, 0.1);

    // Mount with an EMPTY hand — holding a tool makes the click hit the
    // animal instead of riding it, and a hit horse takes off running.
    await bot.unequip("hand").catch(() => {});
    bot.pathfinder.setMovements(baseMoves(bot));

    const deadline = Date.now() + 180_000;
    let mounts = 0;
    let tamed = false;
    // bot.vehicle alone is a LIAR: mineflayer can miss the eject packet and
    // report the bot mounted forever — both first-night "tames" claimed
    // success after one mount while the server granted nothing. The physical
    // truth is position: a real rider tracks the animal. Require the saddle
    // AND proximity to hold through two checks six seconds apart.
    const riding = () => !!(bot as any).vehicle && bot.entity.position.distanceTo(target.position) < 2.0;
    while (!tamed && target.isValid && Date.now() < deadline && !signal.aborted) {
      if (bot.entity.position.distanceTo(target.position) > 3 && !(bot as any).vehicle) {
        await safeGoto(bot, new goals.GoalFollow(target, 2), 10_000).catch(() => {});
      }
      if (!target.isValid) break;
      try {
        bot.mount(target as Parameters<Bot["mount"]>[0]);
        mounts++;
        step(`Mount attempt ${mounts} on the ${species}...`, Math.min(0.9, 0.2 + mounts * 0.05));
      } catch {
        /* out of range or blocked — reposition and retry */
      }
      await new Promise((r) => setTimeout(r, 6_000));
      if (riding()) {
        await new Promise((r) => setTimeout(r, 6_000));
        if (riding()) tamed = true;
      }
      if (!tamed) {
        try {
          bot.dismount();
        } catch {
          /* already off */
        }
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    if (tamed) {
      await new Promise((r) => setTimeout(r, 1_500));
      try {
        bot.dismount();
      } catch {
        /* already off */
      }
    }

    console.log(`[TameDebug] ${bot.username} vs ${species}: mounts=${mounts} tamed=${tamed} valid=${target.isValid}`);
    if (tamed) {
      return {
        success: true,
        message: `Tamed the ${species} after ${mounts} mounts — Best Friends Forever!`,
        stats: { tamed: 1 },
      };
    }
    if (!target.isValid) {
      return { success: false, message: `The ${species} vanished mid-taming.` };
    }
    return { success: false, message: `The ${species} kept bucking (${mounts} tries) — will try again later.` };
  },
};
