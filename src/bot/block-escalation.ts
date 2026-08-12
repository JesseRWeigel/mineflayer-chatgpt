/**
 * How long to suppress an action that keeps failing.
 *
 * The blacklist used one flat 120s TTL for every failure, which made repetition
 * free: a skill that could never work was re-picked every two minutes forever.
 * craftChest logged 71 attempts and 0 successes in a single day that way.
 *
 * The insight is that the Nth identical failure carries more information than
 * the first. One failure is plausibly bad luck (wrong spot, mob interrupted,
 * chunk not loaded). Four failures of the same action mean the bot's model of
 * the world is wrong, and it should stop paying to rediscover that.
 *
 * Escalation is capped rather than unbounded. A permanent ban would be wrong:
 * the world changes, teammates build crafting tables, the stash gets restocked.
 * An hour is long enough to break the loop and short enough that a genuine
 * change in circumstances still gets a fresh look.
 */

/** One failure is bad luck. Retry soon. */
export const TRANSIENT_MS = 120_000;

/** Repeated failures are a pattern. Stop paying to rediscover it. */
export const STRUCTURAL_MS = 3_600_000;

/** Second and third strikes, between bad luck and a settled pattern. */
const LADDER_MS = [TRANSIENT_MS, 600_000, 1_800_000];

/**
 * Suppression window for the `timesBlocked`-th block of the same action.
 *
 * @param timesBlocked 1 for the first block, 2 for the second, and so on
 * @returns milliseconds to suppress, capped at STRUCTURAL_MS
 */
export function blockDurationFor(timesBlocked: number): number {
  if (timesBlocked < 1) return TRANSIENT_MS;
  return LADDER_MS[timesBlocked - 1] ?? STRUCTURAL_MS;
}
