// src/skills/stash.ts
// Shared stash management — deposit/withdraw from categorised chests.

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { snapshotChest } from "./stash-ledger.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { safeGoto } from "../bot/actions.js";
import { baseMoves, safeMoves } from "../bot/navigation.js";

/** bot.openContainer with a hard timeout — a chest GUI that never opens (block
 *  not truly reachable/loaded) otherwise blocks forever, hanging the calling
 *  skill to the 240s watchdog. Fail fast (10s) so the skill recovers. */
async function openContainerTimed(bot: Bot, block: Parameters<Bot["openContainer"]>[0]) {
  return (await Promise.race([
    bot.openContainer(block),
    new Promise((_, rej) => setTimeout(() => rej(new Error("openContainer timeout")), 10000)),
  ])) as Awaited<ReturnType<Bot["openContainer"]>>;
}

/** Stash row categories and their item patterns. Order matches physical chest rows. */
const STASH_ROWS: { category: string; patterns: string[] }[] = [
  {
    category: "building",
    patterns: [
      "log",
      "planks",
      "cobblestone",
      "stone",
      "deepslate",
      "glass",
      "sand",
      "sandstone",
      "brick",
      "terracotta",
      "concrete",
      "gravel",
      "dirt",
    ],
  },
  {
    category: "metals",
    patterns: [
      "raw_iron",
      "iron_ingot",
      "iron_nugget",
      "raw_copper",
      "copper_ingot",
      "raw_gold",
      "gold_ingot",
      "gold_nugget",
      "coal",
      "diamond",
      "emerald",
      "lapis",
      "redstone",
      "quartz",
      "netherite",
      "amethyst",
    ],
  },
  {
    category: "food",
    patterns: [
      "wheat",
      "seed",
      "bread",
      "carrot",
      "potato",
      "beetroot",
      "melon",
      "pumpkin",
      "apple",
      "porkchop",
      "beef",
      "chicken",
      "mutton",
      "cod",
      "salmon",
      "rabbit",
      "stew",
      "cookie",
      "cake",
      "pie",
      "sugar",
      "egg",
      "cocoa",
      "mushroom",
      "kelp",
      "sweet_berries",
    ],
  },
  {
    category: "tools",
    patterns: [
      "sword",
      "pickaxe",
      "axe",
      "shovel",
      "hoe",
      "bow",
      "crossbow",
      "arrow",
      "shield",
      "helmet",
      "chestplate",
      "leggings",
      "boots",
      "fishing_rod",
      "shears",
      "flint_and_steel",
      "compass",
      "clock",
      "spyglass",
      "trident",
    ],
  },
];

/** Determine which stash category an item belongs to. Returns "overflow" if no match. */
export function categorizeItem(itemName: string): string {
  for (const row of STASH_ROWS) {
    if (row.patterns.some((p) => itemName.includes(p))) {
      return row.category;
    }
  }
  return "overflow";
}

/** Get the chest offset for a category (row index along X axis, 2 blocks per row for double chests). */
export function getRowOffset(category: string): number {
  const idx = STASH_ROWS.findIndex((r) => r.category === category);
  return idx >= 0 ? idx * 2 : STASH_ROWS.length * 2; // overflow goes after last row
}

/** Check if an item should be kept based on the bot's keepItems config. */
export function shouldKeep(
  itemName: string,
  keepItems: { name: string; minCount: number }[],
  currentCounts: Map<string, number>,
): boolean {
  // ALWAYS keep valuable gear. Bots crafted iron tools (12 in one run) then
  // deposited them as "surplus" and re-ground iron forever, never advancing.
  // A bot should never give up its iron/diamond/netherite tools or armor.
  const GEAR = ["_pickaxe", "_axe", "_sword", "_shovel", "_hoe", "_helmet", "_chestplate", "_leggings", "_boots"];
  if (
    (itemName.startsWith("iron_") || itemName.startsWith("diamond_") || itemName.startsWith("netherite_")) &&
    GEAR.some((g) => itemName.includes(g))
  ) {
    return true;
  }
  if (itemName === "shield") return true;

  // Never deposit your ONLY tools. shouldKeep protected iron+ gear only, so
  // wooden/stone pickaxes were dumped as junk on every stash trip — craft_gear
  // made wooden_pickaxe repeatedly (4 successes in run 127) and every one
  // vanished into the stash, so nobody could ever mine iron. Keep ONE pickaxe
  // and ONE axe of ANY tier.
  if (itemName.endsWith("_pickaxe")) {
    const kept = currentCounts.get("__pickaxe") ?? 0;
    if (kept < 1) {
      currentCounts.set("__pickaxe", 1);
      return true;
    }
  }
  if (itemName.endsWith("_axe") && !itemName.endsWith("_pickaxe")) {
    const kept = currentCounts.get("__axe") ?? 0;
    if (kept < 1) {
      currentCounts.set("__axe", 1);
      return true;
    }
  }

  // Keep precious crafting materials in inventory. Bots deposited every iron
  // ingot the instant they smelted it (314 deposits/run, empty inventories), so
  // they never accumulated the 3+ ingots needed in-hand to craft an iron tool.
  // Hold onto these so the smelter can actually craft — surplus is fine, the
  // bots' inventories are nearly empty anyway.
  const KEEP_MATERIALS = ["raw_iron", "iron_ingot", "raw_gold", "gold_ingot", "diamond"];
  if (KEEP_MATERIALS.includes(itemName)) return true;

  // Seeds: always keep (needed to replant).
  if (itemName === "wheat_seeds") return true;
  // Wheat: keep only a tiny reserve, DEPOSIT the surplus so it POOLS in the
  // stash. Keeping all wheat (prior fix) backfired — harvests stayed scattered
  // across bots in sub-3 amounts, so no baker ever reached 3 and bread never
  // baked (81 wheat/run -> 4 bread, team starved). Pooling + build_farm's
  // stash-withdraw bake step turns the team's wheat into real bread batches.
  if (itemName === "wheat") {
    const kept = currentCounts.get("__wheat") ?? 0;
    if (kept < 2) {
      currentCounts.set("__wheat", kept + 1);
      return true;
    }
    return false;
  }

  // Keep a PERSONAL FOOD BUFFER. Bots deposited every scrap of food the instant
  // they got it (314 deposits/run) and then starved between production cycles —
  // a starving worker (esp. the miner) burns all its turns failing to eat
  // instead of working. Hold up to KEEP_FOOD food stacks; surplus still goes to
  // the stash for the team.
  const FOOD = new Set([
    "bread",
    "cooked_beef",
    "cooked_porkchop",
    "cooked_mutton",
    "cooked_chicken",
    "cooked_cod",
    "cooked_salmon",
    "cooked_rabbit",
    "baked_potato",
    "apple",
    "golden_apple",
    "carrot",
    "melon_slice",
    "mushroom_stew",
    "rabbit_stew",
    "beetroot_soup",
    // Raw meats — real Minecraft ids have NO raw_ prefix (that's only ores).
    // The old raw_beef/raw_mutton/... names matched nothing, so raw meat never
    // counted toward the food buffer and bots deposited ALL their meat.
    "beef",
    "porkchop",
    "mutton",
    "chicken",
    "cod",
    "salmon",
    "rabbit",
  ]);
  if (FOOD.has(itemName)) {
    const KEEP_FOOD = 6;
    const kept = currentCounts.get("__food") ?? 0;
    if (kept < KEEP_FOOD) {
      currentCounts.set("__food", kept + 1);
      return true;
    }
    return false;
  }

  for (const keep of keepItems) {
    if (itemName.includes(keep.name)) {
      const kept = currentCounts.get(keep.name) ?? 0;
      if (kept < keep.minCount) {
        currentCounts.set(keep.name, kept + 1);
        return true;
      }
    }
  }
  return false;
}

export { STASH_ROWS };

/**
 * Walk to stash, find the correct category chest for each item, deposit.
 * Keeps items on the bot's keepItems list.
 */
export async function depositStash(
  bot: Bot,
  stashPos: { x: number; y: number; z: number },
  keepItems: { name: string; minCount: number }[],
): Promise<string> {
  // Walk to stash area
  const startPos = bot.entity.position.clone();
  await safeGoto(bot, new goals.GoalNear(stashPos.x, stashPos.y, stashPos.z, 3), 30000);
  const movedDist = bot.entity.position.distanceTo(startPos);

  // Fail fast if we never actually reached the stash (underground / blocked /
  // being chased). safeGoto returns after its 30s timeout WITHOUT throwing, so
  // otherwise every downstream op — per-chest gotos + the 6-type food top-up
  // loop, each a fresh withdrawStash with its own 30s goto — retries the same
  // unreachable spot and their timeouts sum past the 150s action watchdog. This
  // caused 16 deposit_stash hangs in 9 min when the team was stuck underground.
  let distToStash = bot.entity.position.distanceTo(new Vec3(stashPos.x, stashPos.y, stashPos.z));

  // The stash sits underground at y=70 while bots work the surface at y=90-100,
  // so the recurring "21 blocks away" was the vertical gap: they stand directly
  // above their own stash with no route down. safeMoves sets canDig=false, so
  // the pathfinder refuses to tunnel and the deposit bounces. 33 of 46 deposit
  // failures in one session were this exact case, at this exact distance.
  //
  // Give them the capability to dig down to their own stash, the same way the
  // pit-escape helper does. baseMoves keeps the fall cap, so descending stays
  // safe.
  //
  // The original guard was "only if already overhead" (horizontal gap under 12),
  // on the reasoning that a distant bot should walk rather than tunnel sideways.
  // That used position as a proxy for the real question. Once bots started
  // strip-mining they stranded themselves in tunnels safeMoves cannot path out
  // of, and the failure came back as 46 bounces at exactly 45 blocks — the same
  // constant every time, meaning the bot never moved at all.
  //
  // Progress is the honest discriminator. A bot that walked most of the way and
  // stopped short is navigating fine and should not tunnel. A bot that did not
  // move is stuck, and digging is its only way out regardless of distance.
  const horizontalGap = Math.hypot(bot.entity.position.x - stashPos.x, bot.entity.position.z - stashPos.z);
  const madeNoProgress = movedDist < 3;
  if (distToStash > 6 && (horizontalGap < 12 || madeNoProgress)) {
    const digMoves = baseMoves(bot);
    digMoves.canDig = true;
    digMoves.allow1by1towers = true;
    bot.pathfinder.setMovements(digMoves);
    try {
      await safeGoto(bot, new goals.GoalNear(stashPos.x, stashPos.y, stashPos.z, 3), 25000);
    } catch {
      /* best effort — the distance check below decides */
    } finally {
      bot.pathfinder.setMovements(safeMoves(bot));
    }
    distToStash = bot.entity.position.distanceTo(new Vec3(stashPos.x, stashPos.y, stashPos.z));
    if (distToStash > 6) {
      console.log(
        `[Stash] dig-retry did not reach: still ${distToStash.toFixed(0)} blocks, ` +
          `moved ${movedDist.toFixed(0)} on first goto, horizGap ${horizontalGap.toFixed(0)}`,
      );
    }
  }

  if (distToStash > 6) {
    return `Can't reach the stash — ${distToStash.toFixed(0)} blocks away (blocked or underground). Get to the surface near ${stashPos.x},${stashPos.y},${stashPos.z} first.`;
  }

  const itemsToDeposit = bot.inventory.items();
  if (itemsToDeposit.length === 0) return "Nothing to deposit — inventory is empty.";

  // Track kept items to respect minCount
  const keptCounts = new Map<string, number>();
  let deposited = 0;
  let noChest = 0;

  // Group items by category
  const byCategory = new Map<string, typeof itemsToDeposit>();
  for (const item of itemsToDeposit) {
    if (shouldKeep(item.name, keepItems, keptCounts)) continue;
    const cat = categorizeItem(item.name);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(item);
  }

  // For each category, find nearest chest at the right row offset and deposit
  for (const [category, items] of byCategory) {
    const rowOffset = getRowOffset(category);
    const chestPos = new Vec3(stashPos.x + rowOffset, stashPos.y, stashPos.z);

    // Find the nearest chest block near the expected position
    const chest = bot.findBlock({
      matching: (b) => b.name === "chest" || b.name === "trapped_chest",
      maxDistance: 6,
      point: chestPos,
    });

    if (!chest) {
      // No chest at this row — try any nearby chest as fallback
      const fallback = bot.findBlock({
        matching: (b) => b.name === "chest" || b.name === "trapped_chest",
        maxDistance: 8,
      });
      if (!fallback) {
        noChest += items.length;
        continue;
      }
      // Use fallback chest
      try {
        const container = await openContainerTimed(bot, fallback);
        for (const item of items) {
          try {
            await container.deposit(item.type, null, item.count);
            deposited += item.count;
          } catch {
            // Chest might be full
          }
        }
        snapshotChest(fallback.position, container.containerItems(), container.inventoryStart);
        container.close();
      } catch {
        noChest += items.length;
      }
      continue;
    }

    try {
      await safeGoto(bot, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 10000);
      const container = await openContainerTimed(bot, chest);
      for (const item of items) {
        try {
          await container.deposit(item.type, null, item.count);
          deposited += item.count;
        } catch {
          // Chest full — this will trigger expansion request
        }
      }
      snapshotChest(chest.position, container.containerItems(), container.inventoryStart);
      container.close();
    } catch {
      noChest += items.length;
    }
  }

  // AUTO-EXPANSION: the stash filled up with weeks of accumulated blocks and
  // every deposit bounced ("needs expansion" x days). The prompt-level cue
  // (Mason: place chests) produced chest WITHDRAWALS but no successful
  // placement in 24h — so give the deposit routine the capability directly:
  // if items bounced and this bot is CARRYING a chest (crafted by the team —
  // no free items), place it past the stash rows and deposit into it.
  if (noChest > 0) {
    let chestItem = bot.inventory.items().find((i) => i.name === "chest");

    // Records which gate stopped the expansion. Every bail-out below used to be
    // a silent catch or a falsy check, so three rounds of fixes were guesswork:
    // the stash bounced 51-66 times per session and nobody could see whether it
    // lacked logs, planks, a crafting table, or a recipe. Report the reason once
    // per bounce so the next fix targets the gate that is actually closed.
    let expandBail = "";
    // No chest carried? CRAFT one on the spot from carried planks (8) — the
    // "craft a chest and carry it" mission produced talk but no carried
    // chests across a full day (crafted ones get spent/deposited before the
    // next bounce). All materials are still bot-earned; this only removes
    // the multi-step timing coordination the LLM can't hold.
    if (!chestItem) {
      const countPlanks = () =>
        bot.inventory
          .items()
          .filter((i) => i.name.endsWith("_planks"))
          .reduce((sum, i) => sum + i.count, 0);

      let planks = countPlanks();

      // Bots arrive at the stash carrying LOGS, not planks: they gather wood
      // and deposit it raw. Requiring 8 planks meant a bot standing at a full
      // stash holding 4 oak_log (16 planks' worth) counted as zero and reported
      // "need more chests" instead of expanding. Measured: 66 bounces and zero
      // successful expansions in a 5h session, while the LLM narrated the
      // problem it could not act on ("Forge's chest dream still stuck").
      // Convert first — logs to planks is a 2x2 recipe, so no table is needed.
      if (planks < 8) {
        try {
          const mcData = (await import("minecraft-data")).default(bot.version);
          const log = bot.inventory.items().find((i) => i.name.endsWith("_log"));
          if (!log) {
            expandBail = `carrying ${planks} planks and no logs`;
          } else {
            const plankDef = mcData.itemsByName[log.name.replace("_log", "_planks")];
            const recipe = plankDef && bot.recipesFor(plankDef.id, null, 1, null)[0];
            if (!recipe) {
              expandBail = `no plank recipe for ${log.name}`;
            } else {
              const logsNeeded = Math.ceil((8 - planks) / 4); // 1 log = 4 planks
              await bot.craft(recipe, Math.min(logsNeeded, log.count), undefined);
              planks = countPlanks();
              console.log(`[Stash] Converted logs to planks for expansion (${planks} planks)`);
            }
          }
        } catch (err) {
          expandBail = `plank craft threw: ${(err as Error).message}`;
        }
      }

      if (planks >= 8) {
        try {
          const mcData = (await import("minecraft-data")).default(bot.version);
          const chestDef = mcData.itemsByName["chest"];
          const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 24 });
          if (!chestDef) {
            expandBail = "no chest item definition";
          } else if (!table) {
            // A chest is a 3x3 recipe, so it needs a table. If the stash has no
            // table within reach, expansion can never complete no matter how
            // many planks the bot carries.
            expandBail = `${planks} planks but no crafting_table within 24 blocks of the stash`;
          } else {
            await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 15000);
            const recipe = bot.recipesFor(chestDef.id, null, 1, table)[0];
            if (!recipe) {
              expandBail = `${planks} planks, table found, but no chest recipe offered`;
            } else {
              await Promise.race([
                bot.craft(recipe, 1, table),
                new Promise<void>((_, rej) => setTimeout(() => rej(new Error("craft timeout")), 15000)),
              ]);
              chestItem = bot.inventory.items().find((i) => i.name === "chest");
              if (chestItem) console.log("[Stash] Crafted a chest for expansion");
              else expandBail = "chest craft completed but produced no chest";
            }
          }
        } catch (err) {
          expandBail = `chest craft threw: ${(err as Error).message}`;
        }
      } else if (!expandBail) {
        expandBail = `only ${planks} planks after conversion`;
      }
    }
    if (chestItem) {
      try {
        const placed = await placeChestNearStash(bot, stashPos);
        if (placed) {
          // A freshly placed chest is not immediately openable: the bot may be
          // up to 2 blocks away from where it placed, and the block state needs
          // a moment to register. The first successful expansion placed a chest
          // and then died on "openContainer timeout", losing the deposit it had
          // just made room for. Step adjacent, let the block settle, and retry
          // once before giving up.
          const container = await openNewChest(bot, placed);
          for (const item of bot.inventory.items()) {
            if (item.name === "chest") continue; // keep spare chests for next expansion
            if (shouldKeep(item.name, keepItems, keptCounts)) continue;
            try {
              await container.deposit(item.type, null, item.count);
              deposited += item.count;
            } catch {
              break; // new chest full too
            }
          }
          snapshotChest(placed.position, container.containerItems(), container.inventoryStart);
          container.close();
          noChest = 0;
        } else {
          expandBail = "carried a chest but found nowhere to place it near the stash";
        }
      } catch (err) {
        expandBail = `chest placement threw: ${(err as Error).message}`;
      }
    }

    if (noChest > 0 && expandBail) {
      console.log(`[Stash] Expansion blocked: ${expandBail}`);
    }
  }

  // Top up food while we're already at the stash (non-disruptive distribution).
  // Remote workers (miner, explorer) starve away from the farm; topping up on
  // each stash visit spreads the team's surplus bread to whoever comes to
  // deposit — the stash as a shared pantry, no extra trips.
  const foodHeld = bot.inventory
    .items()
    .filter((i) => i.name === "bread" || i.name.startsWith("cooked_"))
    .reduce((s, i) => s + i.count, 0);
  if (foodHeld < 4) {
    // Aggregate budget (LESSON 2): even though each withdrawStash is individually
    // bounded, looping all 6 food types re-runs the travel each time — cap the
    // whole top-up so it can't stall deposit_stash if the stash chest churns.
    const topupStart = Date.now();
    for (const f of ["bread", "cooked_beef", "cooked_porkchop", "cooked_mutton", "cooked_chicken", "cooked_cod"]) {
      if (Date.now() - topupStart > 20000) break;
      try {
        await withdrawStash(bot, stashPos, f, 4 - foodHeld);
      } catch {
        /* none of this food in stash — try next */
      }
      if (bot.inventory.items().some((i) => i.name === f)) break;
    }
  }

  if (noChest > 0 && deposited === 0) {
    return "All stash chests are full! Need more chests.";
  }
  if (noChest > 0) {
    return `Deposited ${deposited} items. ${noChest} items couldn't fit — stash needs expansion.`;
  }
  return `Deposited ${deposited} items at the stash.`;
}

/**
 * Walk to stash, find item in categorized chests, withdraw specified count.
 */
export async function withdrawStash(
  bot: Bot,
  stashPos: { x: number; y: number; z: number },
  itemName: string,
  count: number,
): Promise<string> {
  await safeGoto(bot, new goals.GoalNear(stashPos.x, stashPos.y, stashPos.z, 3), 30000);

  const category = categorizeItem(itemName);

  // Wood-family fuzzy matching: bots request "oak_log" while the stash holds
  // birch/spruce (exact-name miss — the raw_beef lesson again: 58 failed
  // withdrawals in one night while wood sat in the chests). Any wood variant
  // or generic term matches the whole family via substring.
  let matchName = itemName;
  if (/^([a-z]+_)?logs?$|^wood$/.test(itemName) || itemName.endsWith("_log")) matchName = "_log";
  else if (/^([a-z]+_)?planks?$/.test(itemName) || itemName.endsWith("_planks")) matchName = "_planks";
  const rowOffset = getRowOffset(category);
  const chestPos = new Vec3(stashPos.x + rowOffset, stashPos.y, stashPos.z);

  // Try category chest first, then scan all nearby chests
  const chestsToTry: any[] = [];

  const categoryChest = bot.findBlock({
    matching: (b) => b.name === "chest" || b.name === "trapped_chest",
    maxDistance: 6,
    point: chestPos,
  });
  if (categoryChest) chestsToTry.push(categoryChest);

  // Also check all nearby chests in case the item was overflow-deposited
  const allChests = bot.findBlocks({
    matching: (b) => b.name === "chest" || b.name === "trapped_chest",
    maxDistance: 10,
    count: 10,
  });
  for (const pos of allChests) {
    const block = bot.blockAt(pos);
    if (block && !chestsToTry.includes(block)) chestsToTry.push(block);
  }

  // Count what we actually have BEFORE, so we can report the real delta —
  // container.withdraw can resolve without delivering (Flora "withdrew" 48
  // planks across 6 calls and ended with 0), which made her loop forever.
  const countItem = () =>
    bot.inventory
      .items()
      .filter((i) => i.name.includes(matchName))
      .reduce((s, i) => s + i.count, 0);
  const before = countItem();

  let withdrawn = 0;
  const needed = count;

  for (const chest of chestsToTry) {
    if (withdrawn >= needed) break;
    try {
      await safeGoto(bot, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 10000);
      const container = await openContainerTimed(bot, chest);

      for (const slot of container.containerItems()) {
        if (withdrawn >= needed) break;
        if (slot.name.includes(matchName)) {
          const take = Math.min(slot.count, needed - withdrawn);
          try {
            await container.withdraw(slot.type, null, take);
            withdrawn += take;
          } catch {
            /* slot empty or race */
          }
        }
      }
      snapshotChest(chest.position, container.containerItems(), container.inventoryStart);
      container.close();
    } catch {
      /* can't open chest */
    }
  }

  // Report the VERIFIED delta, not what container.withdraw claimed.
  const gained = countItem() - before;
  if (gained <= 0 && withdrawn > 0) {
    return `Tried to withdraw ${itemName} but it never reached your inventory (stash transfer failed) — the stash may be empty of it. Gather it yourself or check a different item.`;
  }
  if (gained === 0) return `No ${itemName} in the stash. Gather it yourself instead.`;
  if (gained < needed) return `Withdrew ${gained}x ${itemName} from stash (wanted ${needed} — that's all there was).`;
  return `Withdrew ${gained}x ${itemName} from stash.`;
}

/** Find open ground just past the stash rows and place a chest from inventory.
 *  Part of auto-expansion: the bot supplies its own chest; this only handles
 *  the placement mechanics (goto, equip, place) that the LLM kept fumbling. */
/**
 * Open a chest the bot just placed.
 *
 * Placement finishes from up to 2 blocks away and the new block takes a moment
 * to register, so an immediate openContainer hits the 10s timeout. That cost
 * the very first successful expansion its deposit. Close the distance, let the
 * block settle, and retry once.
 */
async function openNewChest(bot: Bot, placed: NonNullable<ReturnType<Bot["blockAt"]>>) {
  const p = placed.position;

  for (let attempt = 0; attempt < 2; attempt++) {
    let approach = "ok";
    try {
      await safeGoto(bot, new goals.GoalNear(p.x, p.y, p.z, 1), 10000);
    } catch (err) {
      // Swallowed so we still attempt the open, but record it: if the approach
      // fails the bot may be well outside interaction range, and openContainer
      // would then time out for a reason that has nothing to do with the chest.
      approach = `failed (${(err as Error).message})`;
    }
    await new Promise((r) => setTimeout(r, attempt === 0 ? 400 : 1200));
    try {
      return await openContainerTimed(bot, placed);
    } catch (err) {
      // Distance is the discriminator: in-range means a protocol or block-state
      // problem, out-of-range means the approach is the real failure.
      const dist = bot.entity.position.distanceTo(p).toFixed(1);
      const stillThere = bot.blockAt(p)?.name ?? "unknown";
      console.log(
        `[Stash] openNewChest attempt ${attempt + 1} failed: dist=${dist} block=${stillThere} approach=${approach}`,
      );
      if (attempt === 1) throw err;
    }
  }

  throw new Error("openNewChest exhausted retries");
}

/** Leave breathing room around the stash rows before placing anything. */
export const CHEST_MIN_RING = 3;
export const CHEST_MAX_RING = 16;

/**
 * Candidate [dx, dy, dz] offsets for a new stash chest, nearest ring first.
 *
 * Must cover every horizontal direction. The original scan walked dx 10..16
 * with dz -2..2, a strip on the +X side only, so once that strip filled up
 * expansion was impossible regardless of how many chests a bot carried.
 */
export function chestPlacementOffsets(): Array<[number, number, number]> {
  const offsets: Array<[number, number, number]> = [];

  for (let r = CHEST_MIN_RING; r <= CHEST_MAX_RING; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring perimeter only
        // Slight vertical tolerance for uneven ground around the base.
        for (const dy of [0, 1, -1]) offsets.push([dx, dy, dz]);
      }
    }
  }

  return offsets;
}

async function placeChestNearStash(
  bot: Bot,
  stashPos: { x: number; y: number; z: number },
): Promise<ReturnType<Bot["blockAt"]>> {
  const chestItem = bot.inventory.items().find((i) => i.name === "chest");
  if (!chestItem) return null;

  // The old scan covered dx 10..16 with dz -2..2: a 7x5 strip in the +X
  // direction only, 35 spots all on one side of the stash. After weeks of base
  // building that strip is occupied, so bots arrived holding a chest and had
  // nowhere to put it. Measured: 41 of 55 expansion attempts failed this way
  // with a chest already in hand, which surfaced as "stash full, need more
  // chests" and sent four rounds of fixes chasing chest supply instead.
  //
  // Search rings outward in every direction. Block-state checks are free, so
  // gather candidates first and only spend walk time on the nearest few.
  const spots: InstanceType<typeof Vec3>[] = [];

  for (const [dx, dy, dz] of chestPlacementOffsets()) {
    const base = new Vec3(stashPos.x + dx, stashPos.y + dy, stashPos.z + dz);
    const ground = bot.blockAt(base.offset(0, -1, 0));
    const target = bot.blockAt(base);
    const above = bot.blockAt(base.offset(0, 1, 0));
    if (!ground || ground.boundingBox !== "block") continue;
    if (!target || target.name !== "air") continue;
    if (!above || above.name !== "air") continue;
    spots.push(base);
  }

  if (spots.length === 0) {
    console.log(`[Stash] No open placement spot within ${CHEST_MAX_RING} blocks of the stash`);
    return null;
  }

  // Nearest first — every attempt costs a walk, so try the cheap ones first.
  const from = bot.entity.position;
  spots.sort((a, b) => a.distanceTo(from) - b.distanceTo(from));

  // ...but do not spend every attempt in one pocket. Trying the 8 nearest spots
  // meant 8 ADJACENT spots, which fail for the same reason, so expansion died
  // with "Found 342 open spots but every placement attempt failed" while 340
  // untried alternatives sat there. Nearest-first is right for cost and wrong
  // for diversity when failures are spatially correlated.
  //
  // Take a handful of close spots, then sample across the rest so later
  // attempts land in genuinely different areas.
  const attemptSpots = spots.slice(0, 5);
  const remainder = spots.slice(5);
  const stride = Math.max(1, Math.floor(remainder.length / 12));
  for (let i = 0; i < remainder.length && attemptSpots.length < 17; i += stride) {
    attemptSpots.push(remainder[i]);
  }

  // Bounded overall: more chances, but the pair of gotos must stay inside the
  // action watchdog, so the per-attempt timeout drops as the count rises.
  const attemptStart = Date.now();
  let attempts = 0;
  let budgetHit = false;
  // Kept separate from the budget break: "time budget exhausted" used to
  // overwrite the real per-attempt reason, so 52 of 54 failures reported the
  // cap and hid why the individual placements failed.
  let lastErr = "no attempts made";

  for (const base of attemptSpots) {
    if (Date.now() - attemptStart > 45000) {
      budgetHit = true;
      break;
    }
    attempts++;
    try {
      // 5s, not 8s. At 8s the 45s cap allowed only ~5 attempts, so expansion
      // failed 54 times against 30 successes with 342 spots available and the
      // budget as the dominant limiter. A spot needing more than 5s of walking
      // is not the cheap one we sorted for anyway.
      await safeGoto(bot, new goals.GoalNear(base.x, base.y, base.z, 2), 5000);
      await bot.equip(chestItem, "hand");

      // A bot standing IN the target cannot place a block at its own feet, and
      // the doomed placeBlock burns the whole 5s timeout. GoalNear(base, 2)
      // permits arriving at distance 0, and the spot was validated as air
      // BEFORE walking there: the bot is what fills it. 35 of 61 placement
      // failures were "place timeout", and skipping a doomed attempt reclaims
      // enough budget for roughly one extra real one.
      const feet = bot.entity.position.floored();
      if (feet.x === base.x && feet.z === base.z && Math.abs(feet.y - base.y) <= 1) {
        lastErr = "bot ended up standing in the target spot";
        continue;
      }

      const ground = bot.blockAt(base.offset(0, -1, 0));
      if (!ground) {
        lastErr = "ground block vanished before placing";
        continue;
      }
      // Re-verify the spot is still empty: another bot may have filled it while
      // this one walked over.
      const target = bot.blockAt(base);
      if (target && target.name !== "air") {
        lastErr = `spot taken by ${target.name} before placing`;
        continue;
      }
      await Promise.race([
        bot.placeBlock(ground, new Vec3(0, 1, 0)),
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error("place timeout")), 5000)),
      ]);
      const placed = bot.findBlock({ matching: (b) => b.name === "chest", maxDistance: 4 });
      if (placed) {
        console.log(`[Stash] Expanded: placed a new chest at ${placed.position} (attempt ${attempts})`);
        return placed;
      }
      lastErr = "placeBlock resolved but no chest appeared";
    } catch (err) {
      // Capture the reason: the old silent catch is why "every placement
      // attempt failed" could not be acted on without another round of guessing.
      lastErr = (err as Error).message;
      continue;
    }
  }

  console.log(
    `[Stash] ${spots.length} open spots, ${attempts} attempts across the ring, all failed. ` +
      `Last attempt error: ${lastErr}${budgetHit ? " (stopped on 45s budget)" : ""}`,
  );
  return null;
}
