// src/skills/smelt-advice.ts
// Why smelt_ores came up empty, and what the bot should do about it.
//
// The skill returned one unconditional sentence — "Nothing to smelt! Mine some
// ore first" — and its own instrumentation says that is often false:
//
//   [Smelt] Atlas withdraw raw_iron threw: Navigation timed out — goal may be unreachable
//   [Smelt] Atlas withdraw raw_iron: Withdrew 4x raw_iron from stash
//
// The ore existed; the walk to the stash failed. Telling the bot to mine more
// sends it to produce ore it will bank into the same unreachable stash. That is
// why 0 ingots were smelted while ore was being mined, no armour was crafted,
// and Forge died 6 times in one hour wearing only boots.

/** What one withdraw attempt actually established. */
export type WithdrawOutcome = "withdrew" | "empty" | "unreachable";

/**
 * withdrawStash RETURNS its "no such item" messages and THROWS its navigation
 * failures. Only the returned half was ever inspected, so every unreachable
 * stash looked identical to an empty one.
 */
export function classifyWithdraw(result: string, threw: boolean): WithdrawOutcome {
  // An unrecognised throw is still a failure to GET there. Treating it as an
  // empty stash is the mistake this module exists to stop.
  if (threw) return "unreachable";
  if (/^Withdrew /i.test(result)) return "withdrew";
  return "empty";
}

/**
 * One unreachable outcome proves the walk is failing. One empty outcome proves
 * only that a single item was absent, so "unreachable" wins any mix.
 */
export function nothingToSmeltMessage(outcomes: WithdrawOutcome[]): string {
  if (outcomes.includes("unreachable")) {
    return (
      "Nothing to smelt, but the stash could not be reached — the ore may already be pooled there. " +
      "Don't mine more to bank into it. Clear a path to the stash chests, or smelt ore you are carrying."
    );
  }
  return "Nothing to smelt! Mine some ore first (strip_mine for iron, gold, copper).";
}
