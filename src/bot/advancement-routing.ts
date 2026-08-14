// src/bot/advancement-routing.ts
//
// Which bot should chase which advancement.
//
// Five specialists, 122 advancements, and no overlap between the two
// vocabularies. Rather than dissolve the roles into generalists, each role
// declares the categories it prefers; the frontier is filtered by preference
// and only falls back to "anything" when the preferred buckets are empty --
// a bot with no suitable goal should still have a goal.

import { descendantCount, type AdvancementNode } from "./advancement-tree.js";

/** Category preference per role, best first. Roles are matched on the exact
 *  `role` string from BotRoleConfig. */
const AFFINITY: Record<string, string[]> = {
  "Explorer / Miner": ["adventure", "story", "nether", "end", "husbandry"],
  "Farmer / Crafter": ["husbandry", "story", "adventure", "nether", "end"],
  "Miner / Smelter": ["story", "nether", "end", "adventure", "husbandry"],
  Builder: ["story", "adventure", "husbandry", "nether", "end"],
  "Combat / Guard": ["adventure", "end", "nether", "story", "husbandry"],
};

const DEFAULT_ORDER = ["story", "adventure", "husbandry", "nether", "end"];

/**
 * Gateways first, dead ends last, id as a tiebreak.
 *
 * Sorting by id alone put story/enchant_item (unlocks nothing) ahead of
 * story/lava_bucket (unlocks 5, including the whole nether). The tiebreak keeps
 * the result deterministic: a goal that flickers between decisions is a goal
 * that never completes.
 */
function byUnlockValue(a: AdvancementNode, b: AdvancementNode): number {
  return descendantCount(b.id) - descendantCount(a.id) || a.id.localeCompare(b.id);
}

export function assignFor(role: string, frontier: AdvancementNode[]): AdvancementNode | null {
  if (frontier.length === 0) return null;
  const order = AFFINITY[role] ?? DEFAULT_ORDER;
  for (const category of order) {
    const matches = frontier.filter((a) => a.category === category).sort(byUnlockValue);
    if (matches.length > 0) return matches[0];
  }
  return [...frontier].sort(byUnlockValue)[0];
}
