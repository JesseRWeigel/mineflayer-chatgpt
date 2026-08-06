// src/bot/stall-rescue.ts
// Deciding when a bot that keeps failing to reach things needs digging out.
//
// The dig-out rescue already existed and the pits already qualified for it. It
// only ever ran when a bot was idle or had not moved in 90 seconds, and a bot
// wedged in a hole is neither: it is processing continuously, and every failed
// path shuffles it enough to reset the movement clock. So the rescue watched
// for stillness while the actual failure was motion without progress.
//
// Measured over one 52 minute session: 204 navigation stalls, 111 of them at a
// single spot four blocks from the stash and three blocks below it, cobblestone
// on three sides. maxDropDown=3 lets a bot walk INTO a drop like that, and
// safeMoves forbids both digging and 1x1 towers, so it cannot climb back out.
// Ore mined that hour: zero.

/** Consecutive stalls before the bot digs itself out. */
export const STALL_RESCUE_THRESHOLD = 3;

/** Does this action result mean the bot failed to get somewhere?
 *
 *  Matches the stall detector and the pathfinder's own give-up messages. A
 *  refusal the bot chose (blocked action, role gate) is NOT a stall: the bot is
 *  fine, the plan was wrong, and digging would be pointless vandalism. */
export function isStallResult(result: string): boolean {
  if (!result) return false;
  if (/^Blocked:|not allowed for/i.test(result)) return false;
  return /Stuck — not making progress|Navigation timed out|No path to the goal|Path was stopped/i.test(result);
}

/** Fire once per run of stalls, not on every one past the threshold. */
export function shouldForceDigOut(consecutiveStalls: number): boolean {
  return consecutiveStalls >= STALL_RESCUE_THRESHOLD;
}
