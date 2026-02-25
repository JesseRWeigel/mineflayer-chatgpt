import type { Bot } from "mineflayer";
import { isHostile } from "../bot/perception.js";
import { buildObservation, queryNeural, isNeuralServerRunning } from "./bridge.js";

const TICK_MS = 50;
const NEURAL_PORT = 12345;

export async function runNeuralCombat(bot: Bot, durationSeconds: number): Promise<string> {
  const duration = Math.min(Math.max(durationSeconds, 1), 10);
  const endTime = Date.now() + duration * 1000;

  const serverUp = await isNeuralServerRunning(NEURAL_PORT);
  if (!serverUp) {
    console.log("[Neural] Server unreachable — PVP fallback");
    return pvpFallback(bot, duration);
  }

  console.log(`[Neural] Combat burst: ${duration}s`);
  let ticks = 0;
  let attacks = 0;

  while (Date.now() < endTime) {
    const tickStart = Date.now();
    try {
      const obs = buildObservation(bot);
      if (!obs.nearest_hostile && ticks > 10) break;

      const act = await queryNeural(obs, NEURAL_PORT);
      await applyAction(bot, act);
      if (act.action === "attack") attacks++;
    } catch (err: any) {
      console.warn(`[Neural] Tick error: ${err.message}`);
      break;
    }
    const wait = Math.max(0, TICK_MS - (Date.now() - tickStart));
    if (wait > 0) await sleep(wait);
    ticks++;
  }

  bot.clearControlStates();
  return `Neural combat: ${ticks} ticks, ${attacks} attacks.`;
}

async function applyAction(bot: Bot, act: { action: string }): Promise<void> {
  bot.clearControlStates();
  switch (act.action) {
    case "attack": {
      const target = bot.nearestEntity(
        (e) => isHostile(e) && e.position.distanceTo(bot.entity.position) < 16
      );
      if (target) {
        await bot.lookAt(target.position.offset(0, (target as any).height ?? 1.6, 0));
        bot.attack(target);
      }
      bot.setControlState("sprint", true);
      break;
    }
    case "strafe_left":
      bot.setControlState("left", true);
      bot.setControlState("sprint", true);
      break;
    case "strafe_right":
      bot.setControlState("right", true);
      bot.setControlState("sprint", true);
      break;
    case "flee": {
      const hostile = bot.nearestEntity(
        (e) => isHostile(e) && e.position.distanceTo(bot.entity.position) < 16
      );
      if (hostile) {
        const away = bot.entity.position.minus(hostile.position).normalize().scaled(10);
        bot.lookAt(bot.entity.position.plus(away));
      }
      bot.setControlState("back", true);
      bot.setControlState("sprint", true);
      break;
    }
    case "use_item":
      bot.activateItem();
      break;
  }
}

function pvpFallback(bot: Bot, duration: number): Promise<string> {
  const target = bot.nearestEntity(
    (e) => isHostile(e) && e.position.distanceTo(bot.entity.position) < 16
  );
  if (!target) return Promise.resolve("No hostiles found.");

  // Prefer @nxg-org/mineflayer-custom-pvp for strafing, crit timing, and shield handling
  if ((bot as any).swordpvp) {
    const swordpvp = (bot as any).swordpvp;
    swordpvp.attack(target);
    return sleep(duration * 1000).then(() => {
      swordpvp.stop();
      return `PVP fallback (custom-pvp): ${duration}s.`;
    });
  }

  // Last-resort fallback: raw mineflayer attack loop
  const endTime = Date.now() + duration * 1000;
  const doAttack = async () => {
    while (Date.now() < endTime) {
      if (target.isValid && target.position.distanceTo(bot.entity.position) < 6) {
        await bot.lookAt(target.position.offset(0, (target as any).height ?? 1.6, 0));
        bot.attack(target);
      }
      await sleep(500);
    }
    return `PVP fallback (basic): ${duration}s.`;
  };
  return doAttack();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
