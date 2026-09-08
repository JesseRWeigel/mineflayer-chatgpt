import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";

/**
 * The piglin-fund dead drop — one designated chest at fixed coordinates on
 * the farm shore, the one patch of ground repeatedly proven walkable
 * (PlantDebug-verified arrivals all week).
 *
 * Why it exists: every ground-based transfer at the village is a coin flip.
 * The give rail survived five loss mechanisms only to lose a sixth to base
 * clutter — a reclaim sweep recovered 0/4 ingots tossed INSIDE the village.
 * A dead drop has no magnets, no catches, no 60-chest scans, and no
 * clutter: the depositor and the collector both walk to the same known
 * block in the open.
 */

export const FUND_CHEST = { x: 303, y: 58, z: -306 };

function count(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}

/** Walk to the fund spot and return the chest block there, placing one from
 *  inventory if the spot is bare. Returns null when unreachable or unplaceable. */
async function reachFundChest(bot: Bot): Promise<ReturnType<Bot["blockAt"]> | null> {
  bot.pathfinder.setMovements(baseMoves(bot));
  try {
    await safeGoto(bot, new goals.GoalNear(FUND_CHEST.x, FUND_CHEST.y, FUND_CHEST.z, 2), 60_000);
  } catch {
    /* judge by distance below */
  }
  const p = bot.entity.position;
  if (Math.hypot(p.x - FUND_CHEST.x, p.z - FUND_CHEST.z) > 6) return null;

  const existing = bot.findBlock({
    matching: (b) => b.name === "chest",
    maxDistance: 4,
  });
  if (existing) return existing;

  const chestItem = bot.inventory.items().find((i) => i.name === "chest");
  if (!chestItem) return null;
  const ground = bot.blockAt(bot.entity.position.offset(1, -1, 0)) ?? bot.blockAt(bot.entity.position.offset(0, -1, 1));
  if (!ground || ground.name === "air" || ground.name === "water") return null;
  try {
    await bot.equip(chestItem, "hand");
    await bot.placeBlock(ground, { x: 0, y: 1, z: 0 } as never);
  } catch {
    /* fall through to re-scan */
  }
  return bot.findBlock({ matching: (b) => b.name === "chest", maxDistance: 4 });
}

/** Deposit `n` of `itemName` into the fund chest. Returns an honest report. */
export async function fundDeposit(bot: Bot, itemName: string, n: number): Promise<string> {
  const before = count(bot, itemName);
  if (before < 1) return `No ${itemName} to deposit.`;
  const chest = await reachFundChest(bot);
  if (!chest) return "Fund chest unreachable (or no chest to place) — falling back.";
  try {
    const container = await bot.openContainer(chest);
    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (item) await container.deposit(item.type, null, Math.min(n, before));
    container.close();
  } catch (e) {
    return `Fund deposit failed: ${(e as Error).message}`;
  }
  const moved = before - count(bot, itemName);
  return moved > 0
    ? `Banked ${moved}x ${itemName} in the fund chest at ${FUND_CHEST.x},${FUND_CHEST.y},${FUND_CHEST.z}.`
    : `Fund deposit moved nothing (chest full?).`;
}

/** Withdraw up to `n` of `itemName` from the fund chest. Honest report. */
export async function fundWithdraw(bot: Bot, itemName: string, n: number): Promise<string> {
  const before = count(bot, itemName);
  const chest = await reachFundChest(bot);
  if (!chest) return "Fund chest unreachable — falling back.";
  try {
    const container = await bot.openContainer(chest);
    for (const slot of container.containerItems()) {
      if (count(bot, itemName) - before >= n) break;
      if (slot.name === itemName) {
        await container.withdraw(slot.type, null, Math.min(slot.count, n - (count(bot, itemName) - before)));
      }
    }
    container.close();
  } catch (e) {
    return `Fund withdraw failed: ${(e as Error).message}`;
  }
  const got = count(bot, itemName) - before;
  return got > 0 ? `Took ${got}x ${itemName} from the fund chest.` : `Fund chest holds no ${itemName}.`;
}
