/**
 * Choosing which skills the bot is allowed to see.
 *
 * The menu is a scarce resource: every skill listed costs prompt tokens, and
 * the model can only invoke what it can name. The old rule took the top 10 of a
 * proven-first ranking, which quietly made the library read-only. With 10+
 * proven skills, no untried skill could ever appear, so it could never earn the
 * stats that would let it appear. 131 skills existed; 18 had ever been tried.
 *
 * The fix is to treat exploration as a reserved budget rather than a leftover.
 * A few slots always belong to untried skills, and they ROTATE, so a library of
 * any size is covered over time instead of the same head being shown forever.
 *
 * Rotation is deliberately a caller-supplied counter rather than randomness:
 * it makes coverage predictable, makes this function pure, and keeps the tests
 * from flaking.
 */

/** Slots for skills with a demonstrated success rate. */
export const PROVEN_SLOTS = 8;

/** Slots reserved for skills the team has never meaningfully tried. */
export const EXPLORE_SLOTS = 4;

/** Take `count` items starting at `offset`, wrapping around the end. */
function window<T>(items: T[], offset: number, count: number): T[] {
  if (items.length === 0 || count <= 0) return [];
  const start = ((offset % items.length) + items.length) % items.length;
  const out: T[] = [];
  for (let i = 0; i < Math.min(count, items.length); i++) {
    out.push(items[(start + i) % items.length]);
  }
  return out;
}

/**
 * Build the skill menu for one prompt render.
 *
 * @param proven     skills with a good success rate, best first
 * @param untried    skills with too few attempts to judge
 * @param struggling skills that work sometimes, worst last
 * @param rotation   a counter that advances each render; rotates the untried window
 * @returns deduped skill names, proven first, then untried, then strugglers
 */
export function pickSkillMenu(
  proven: string[],
  untried: string[],
  struggling: string[],
  rotation: number,
): string[] {
  const explore = window(untried, rotation * EXPLORE_SLOTS, EXPLORE_SLOTS);

  // Unused exploration slots fall back to proven skills rather than going to
  // waste, so a team with nothing new to try still gets a full menu.
  const provenBudget = PROVEN_SLOTS + (EXPLORE_SLOTS - explore.length);
  const head = proven.slice(0, provenBudget);

  // Strugglers are last resort: only shown if the better buckets left room.
  const spare = PROVEN_SLOTS + EXPLORE_SLOTS - head.length - explore.length;
  const tail = spare > 0 ? struggling.slice(0, spare) : [];

  return [...new Set([...head, ...explore, ...tail])];
}
