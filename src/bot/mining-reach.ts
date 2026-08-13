/**
 * What can this bot actually mine right now?
 *
 * tool-tier.ts has always known the harvest rules, but it only consults them
 * when mine_block is already running -- the brain finds out by failing. Five
 * different models all chose iron_ore while holding a wooden pickaxe, because
 * the context told them iron_ore was nearby and never told them it was out of
 * reach. This module moves that knowledge in front of the decision.
 *
 * Pure on purpose, like skill-menu.ts: the caller passes the nearby block list
 * and the best pickaxe held, so the tests need no mineflayer bot.
 */

import { canHarvest, requiredTier, pickaxeTier } from "./tool-tier.js";

/**
 * The best pickaxe among the given item names, or null for none.
 *
 * actions.ts has its own bestPickaxe() with a hand-written ranks array. Deriving
 * it from pickaxeTier keeps tool-tier.ts as the single authority on which
 * pickaxe outranks which -- a second ranking that disagreed would show the bot a
 * reach line computed from one tool while it dug with another.
 */
export function bestPickaxeName(itemNames: string[]): string | null {
  let best: string | null = null;
  let bestTier = -1;
  for (const name of itemNames) {
    const tier = pickaxeTier(name);
    if (tier !== null && tier > bestTier) {
      bestTier = tier;
      best = name;
    }
  }
  return best;
}

/** Cheapest pickaxe material that clears a given tier. */
const TIER_MATERIAL = ["wooden", "stone", "iron", "diamond", "netherite"];

/** The pickaxe name that would unlock this block. */
function unlockFor(block: string): string {
  return `${TIER_MATERIAL[requiredTier(block)] ?? "stone"}_pickaxe`;
}

/**
 * Split nearby blocks by whether the held pickaxe can actually harvest them.
 * Exported for the renderer below and for tests that want the raw split.
 */
export function splitByReach(
  nearby: string[],
  pickaxe: string | null | undefined,
): { reachable: string[]; blocked: Map<string, string> } {
  const reachable: string[] = [];
  const blocked = new Map<string, string>();
  for (const b of nearby) {
    if (canHarvest(b, pickaxe)) reachable.push(b);
    else blocked.set(b, pickaxe == null && requiredTier(b) === 0 ? "wooden_pickaxe" : unlockFor(b));
  }
  return { reachable, blocked };
}

/** Keeps a block-rich cave from crowding out the rest of the context. */
const MAX_PER_GROUP = 6;

function list(names: string[]): string {
  const shown = names.slice(0, MAX_PER_GROUP);
  const extra = names.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} (+${extra})` : shown.join(", ");
}

/**
 * One line for the strategic context, in the style of getTechTreeLine.
 *
 * Blocked blocks are named TOGETHER WITH the pickaxe that unlocks them, so the
 * line reads as a recipe rather than an opportunity. Hiding them entirely was
 * the tempting alternative -- it removes the distraction -- but Forge's whole
 * job is the iron path, and a miner who cannot see the iron has no reason to
 * build the pickaxe. Naming the unlock in the same breath is what turns
 * "iron_ore is here" from a lure into a next step.
 *
 * Grouped by unlocking pickaxe rather than listed per block: eleven notable
 * blocks render in ~220 chars this way and ~280 the other, and the grouping
 * also states the tier rule implicitly.
 *
 * @param nearby  notable block names in perception range
 * @param pickaxe the best pickaxe in inventory, or null if the bot has none
 * @returns a single context line, or "" when there is nothing notable nearby
 */
export function miningReachLine(nearby: string[], pickaxe: string | null | undefined): string {
  if (nearby.length === 0) return "";
  const { reachable, blocked } = splitByReach(nearby, pickaxe);

  const head =
    reachable.length > 0
      ? `can mine now — ${list(reachable)}.`
      : `nothing in reach is mineable with ${pickaxe ?? "bare hands"}.`;

  // Group by unlock so three ores needing the same pickaxe read as one step.
  const byUnlock = new Map<string, string[]>();
  for (const [block, unlock] of blocked) {
    const group = byUnlock.get(unlock) ?? [];
    group.push(block);
    byUnlock.set(unlock, group);
  }

  const needs = [...byUnlock.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([unlock, blocks]) => ` NEEDS ${unlock}: ${list(blocks)}.`)
    .join("");

  return `MINING REACH: ${head}${needs}`;
}
