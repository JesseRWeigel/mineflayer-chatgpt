/**
 * Classifying what a bot action actually did.
 *
 * Every action a bot takes returns one human-readable sentence. Three systems
 * read the verdict on that sentence:
 *
 *   recordAction       -> ACTION_SUCCESS_PCT, the swarm health metric
 *   recordSkillResult  -> per-skill scoring, which ranks skills over time
 *   trackFailure       -> the blacklist that stops a bot repeating a dead action
 *
 * The old keyword regex tested for success-ish substrings anywhere in the
 * string, which cannot tell "Harvested 12 wheat" from "Can't harvest wheat".
 * See action-result.test.ts for the four real strings it got wrong.
 *
 * Result sentences follow a dependable grammar:
 *
 *   ACHIEVEMENT  opens with a past-tense verb, then a count or a target
 *                "Deposited 12 items at the stash."
 *                "Mined 14 cobblestone."
 *                "Withdrew 5x iron_ingot from stash."
 *
 *   REFUSAL      opens with a negative, and often explains the remedy
 *                "Can't harvest stone with wooden_pickaxe, it needs a ..."
 *                "Nothing to deposit, inventory is empty."
 *                "No path to the goal!"
 *                "Failed to craft chest: Error: no table"
 *
 * So classify on sentence shape, not substring presence.
 */

/** Past-tense verbs that mean the bot actually accomplished something. */
const ACHIEVEMENT =
  /^\s*(deposited|withdrew|mined|crafted|smelted|built|planted|gathered|harvested|arrived|explored|placed|chopped|killed|caught|fished|lit|bridged|completed|ate|slept)/i;

/**
 * Decide whether an action result reports an achievement.
 *
 * @param result the one-sentence outcome string returned by an action
 * @returns true if the bot accomplished something, false if it refused or failed
 *
 * Unrecognised phrasing counts as failure. That keeps ACTION_SUCCESS_PCT honest
 * and the blacklist aggressive, at the price of a new skill scoring 0% until its
 * verb is added to ACHIEVEMENT above. If a generated skill ever looks stuck at
 * 0%, check its wording here before debugging the skill itself.
 *
 * Anchoring at the start of the sentence is what separates "Harvested 12 wheat"
 * from "Can't harvest wheat". A refusal never opens with a past-tense verb, so
 * no separate refusal pattern is needed; failing to match is the refusal case.
 */
export function classifyResult(result: string): boolean {
  return ACHIEVEMENT.test(result);
}
