/**
 * Can the team survive collecting this advancement yet?
 *
 * advancement-routing.ts ranks the frontier by descendantCount, which measures
 * how much an advancement UNLOCKS. That is the right value signal and a useless
 * safety signal: on the swarm's real state it ranked
 * adventure/minecraft_trials_edition (6 descendants) above story/lava_bucket
 * (5), sending two bots in iron tools into an ominous-trial spawner dungeon at
 * 13 of 122 advancements.
 *
 * The gate is deliberately coarse. Assigning a real difficulty to all 122 would
 * be guesswork; listing the handful that demonstrably kill an under-geared bot
 * is not. Everything unlisted is ungated, so the gate can only ever remove a
 * known hazard, never silently starve the frontier.
 */

export const TIER_ORDER = ["none", "iron", "diamond"] as const;
export type Tier = (typeof TIER_ORDER)[number];

/**
 * Advancements that need real gear to survive, not merely to reach.
 *
 * Kept short on purpose. Each entry is something that put a bot in a fight it
 * could not win, or is an obvious instance of the same (raids, trial chambers,
 * the wither, the dragon, the deep dark).
 */
const DANGEROUS: Record<string, Tier> = {
  "adventure/minecraft_trials_edition": "diamond",
  "adventure/under_lock_and_key": "diamond",
  "adventure/blowback": "diamond",
  "adventure/who_needs_rockets": "diamond",
  "adventure/crafters_crafting_crafters": "iron",
  "adventure/voluntary_exile": "diamond",
  "adventure/hero_of_the_village": "diamond",
  "adventure/adventuring_time": "iron",
  "adventure/sniper_duel": "iron",
  "adventure/totem_of_undying": "diamond",
  "adventure/kill_all_mobs": "diamond",
  "nether/summon_wither": "diamond",
  "nether/create_full_beacon": "diamond",
  "end/kill_dragon": "diamond",
  "end/dragon_egg": "diamond",
  "end/respawn_dragon": "diamond",
  "end/levitate": "diamond",
};

/**
 * The story spine is never gated.
 *
 * A gate that blocked the route to better gear would deadlock the swarm at
 * whatever tier it happened to be standing on: it could not reach diamond
 * without the nether, and could not enter the nether without diamond.
 */
const NEVER_GATED = /^story\//;

/** What the team can currently field, inferred from what it has already earned. */
export function teamTier(earned: Set<string>): Tier {
  // shiny_gear is a full set of diamond armour. mine_diamond is one diamond in a
  // pocket and means nothing about survivability.
  if (earned.has("story/shiny_gear")) return "diamond";
  if (earned.has("story/iron_tools") || earned.has("story/obtain_armor")) return "iron";
  return "none";
}

export function requiredTier(id: string): Tier {
  if (NEVER_GATED.test(id)) return "none";
  return DANGEROUS[id] ?? "none";
}

export function withinReach(id: string, earned: Set<string>): boolean {
  return TIER_ORDER.indexOf(teamTier(earned)) >= TIER_ORDER.indexOf(requiredTier(id));
}
