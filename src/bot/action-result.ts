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

/**
 * WHAT THE FIRST VERSION OF THIS FILE GOT WRONG.
 *
 * Anchoring at ^ fixed "Can't harvest stone" but broke almost everything else,
 * because the codebase's success strings mostly lead with the noun:
 *
 *   "collectBamboo completed."       — every one of 131 dynamic skills
 *   "Gear crafted!"  "HOUSE BUILT!"  "Farm planted!"  "Bridge built!"
 *   "All materials gathered!"  "Strip mine complete!"  "Smelting done!"
 *   "Defeated zombie using advanced combat!"
 *
 * Measured against 16 real success strings: the anchored version rejected 13.
 * The unanchored regex it replaced rejected 3 — and only passed the rest by
 * accident, matching "ate" inside Gener-ate-d and Defe-ate-d.
 *
 * That was not merely a bad metric. brain.ts feeds this to trackFailure, where
 * a skill result classed as non-success increments failureCounts, so TWO
 * successful runs of a working skill blacklisted it — with escalating TTLs and
 * no path back, since the clear-history branch only runs on success.
 *
 * The real fix is upstream: skills now report a genuine boolean through
 * takeSkillOutcome() in src/skills/executor.ts, so this function is only
 * consulted for built-in actions that return nothing but a sentence.
 */

/** Explicit failure markers. Checked first — a refusal anywhere wins. */
const FAILURE =
  /\b(can'?t|cannot|couldn'?t|failed|unable|error|aborted|timed? ?out|crashed|retired|nothing to|no path|not enough|needs? an? )/i;

/** Past-tense verb opening the sentence: "Deposited 12 items at the stash." */
const ACHIEVEMENT =
  /^\s*(deposited|withdrew|mined|crafted|smelted|built|planted|gathered|harvested|arrived|explored|placed|chopped|killed|caught|fished|lit|bridged|completed|ate|slept|defeated|generated|gave|collected|obtained|equipped|reached|stored)/i;

/**
 * Past-tense verb CLOSING the sentence: "Gear crafted!", "HOUSE BUILT!".
 *
 * Terminal by construction — the trailing punctuation and end-anchor are what
 * keep "Farm planted!" apart from "Couldn't get the farm planted because...".
 * The leading \b stops "uncompleted" and similar from matching.
 */
const TERMINAL_SUCCESS =
  /\b(crafted|built|planted|gathered|harvested|smelted|complete|completed|done|bootstrapped|placed|stored|equipped|lit|generated)\s*[!.]?\s*$/i;

/**
 * Decide whether an action result reports an achievement.
 *
 * @param result the one-sentence outcome string returned by an action
 * @returns true if the bot accomplished something, false if it refused or failed
 *
 * Unrecognised phrasing still counts as failure, as specified. An unknown
 * result is not evidence of success. But "unrecognised" now means genuinely
 * novel wording rather than the ordinary house style of half the codebase.
 */
export function classifyResult(result: string): boolean {
  // A sentence that OPENS with an achievement verb is a success even when it
  // goes on to admit a shortfall: "Deposited 8 items. 4 items couldn't fit
  // (chest full)." did deposit 8 items. Checking failure markers first would
  // throw away every partial success in the codebase.
  if (ACHIEVEMENT.test(result)) return true;
  if (FAILURE.test(result)) return false;
  return TERMINAL_SUCCESS.test(result);
}
