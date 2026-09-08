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

// Plaza level (y=70), three blocks from the stash where every bot stands —
// RCON-probed clear: grass floor, two air above. The first location (the
// farm shore at y=58) was down the same ridge that defeated cane planting;
// Forge stalled 20 blocks short every trip. A dead drop is only as good as
// its reachability, and the plaza is the one patch the whole team touches
// hourly.
export const FUND_CHEST = { x: 283, y: 70, z: -315 };

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
  // ARRIVAL-VERIFIED MARCH, the lesson the cane campaign paid for: a single
  // goto down the ridge to the shore times out more often than it lands
  // (eight "unreachable" fallbacks on the drop's first night). Keep walking
  // until genuinely close or the clock runs out.
  const gap = () => Math.hypot(bot.entity.position.x - FUND_CHEST.x, bot.entity.position.z - FUND_CHEST.z);
  const marchDeadline = Date.now() + 150_000;
  while (Date.now() < marchDeadline && gap() > 6) {
    await safeGoto(bot, new goals.GoalNear(FUND_CHEST.x, FUND_CHEST.y, FUND_CHEST.z, 2), 45_000, 12_000).catch(
      () => {},
    );
    if (gap() > 6) await new Promise((r) => setTimeout(r, 1500));
  }
  if (gap() > 6) {
    console.log(`[Fund] ${bot.username} unreachable: still ${gap().toFixed(0)} blocks from the drop`);
    return null;
  }

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
