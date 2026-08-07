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

/** Stalls inside STALL_WINDOW_MS before the bot digs itself out.
 *
 *  This was THREE CONSECUTIVE stalls, and consecutive is the wrong shape. Any
 *  interleaved success resets the run, so across one 2h38m session the rescue
 *  fired 23 times against 749 stalls — 3%. Meanwhile one bot, Forge, produced
 *  499 of those stalls, including 56 at a spot walled in stone on all four
 *  sides with only the sky open, which is exactly what digOutIfStuck is for.
 *
 *  A bot that stalls five times in three minutes is stuck whether or not it
 *  managed something else in between. */
export const STALL_RESCUE_THRESHOLD = 5;
export const STALL_WINDOW_MS = 3 * 60 * 1000;

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

/** Keep only the stalls still inside the window, newest last. */
export function pruneStalls(stallTimes: number[], now: number, windowMs: number = STALL_WINDOW_MS): number[] {
  return stallTimes.filter((t) => now - t <= windowMs);
}

/** Enough stalls in a short window to mean the bot cannot reach anything.
 *
 *  Rate, not a run. A bot wedged in a hole still succeeds at eat, idle and chat
 *  between failed navigations, and every one of those used to reset the count. */
export function shouldForceDigOut(recentStalls: number[], now: number): boolean {
  return pruneStalls(recentStalls, now).length >= STALL_RESCUE_THRESHOLD;
}
