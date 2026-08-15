/**
 * How to actually pursue an advancement.
 *
 * Mojang's descriptions are written for a human who already knows the game.
 * "Fill a Bucket with lava" does not say a bucket must be crafted first, and it
 * certainly does not name the skill that crafts one.
 *
 * Measured 2026-08-14: three and a half hours after the whole nether chain
 * shipped and was registered in Forge's menu, craft_bucket had been invoked
 * zero times. The bot was told the goal and held the capability, and had no
 * route from one to the other.
 *
 * Same shape as the wooden-pickaxe gap that tool-tier.ts fixed: the knowledge
 * lived in the codebase and never reached the decision. Shipping a skill is not
 * the same as making it reachable.
 *
 * Deliberately sparse. A hint per advancement would be 122 guesses; a hint on
 * the handful where a specific skill is the known route is a fact.
 */

const HINTS: Record<string, string> = {
  "story/lava_bucket":
    'invoke_skill {"skill":"craft_bucket"} (3 iron ingots), then invoke_skill {"skill":"fill_bucket","fluid":"lava"}.',
  "story/form_obsidian":
    'Obsidian comes from water poured on a lava source. invoke_skill {"skill":"build_nether_portal"} does the casting.',
  "story/enter_the_nether":
    'invoke_skill {"skill":"build_nether_portal"} — it casts the frame and lights it. Needs a bucket and flint_and_steel.',
  "nether/root":
    'Get there by portal: invoke_skill {"skill":"build_nether_portal"}.',
  "story/smelt_iron": 'invoke_skill {"skill":"smelt_ores"} turns raw_iron into ingots.',
  "story/iron_tools": 'invoke_skill {"skill":"craft_gear"} makes the best tools your materials allow.',
  "story/shiny_gear": 'invoke_skill {"skill":"craft_gear"} once you have diamonds.',
  "story/mine_diamond": 'invoke_skill {"skill":"strip_mine"} digs to the depth diamonds spawn at.',
};

/** A one-line route from goal to capability, or "" when there is no known one. */
export function hintFor(advancementId: string): string {
  return HINTS[advancementId] ?? "";
}
