// src/bot/advancement-tree.ts
//
// The game's own advancement graph, used as the curriculum.
//
// The hand-written TECH_LADDER in curriculum.ts stopped at diamonds, which made
// "you are endgame" the terminal state at 10% completion. The advancement tree
// has 122 rungs, declares its own dependencies, and is maintained by Mojang
// rather than by us.
//
// Pure and data-only on purpose: reading who has earned what is a separate
// concern (advancement-progress.ts) so this stays trivially testable.

import tree from "../data/advancement-tree.json" with { type: "json" };

export interface AdvancementNode {
  id: string;
  parent: string | null;
  title: string;
  description: string;
  category: string;
}

export const ALL_ADVANCEMENTS: AdvancementNode[] = tree as AdvancementNode[];
export const TOTAL_ADVANCEMENTS = ALL_ADVANCEMENTS.length;

const BY_ID = new Map(ALL_ADVANCEMENTS.map((a) => [a.id, a]));

export function getAdvancement(id: string): AdvancementNode | undefined {
  return BY_ID.get(id);
}

/**
 * Roots that are not actually free.
 *
 * All five category roots declare parent:null, but "Nether" and "The End" are
 * awarded for BEING in those dimensions. Treating them as reachable would put
 * "go to the Nether" in front of a team that has never smelted a bucket, which
 * is precisely the kind of unreachable goal the old ladder's endgame message
 * was already causing.
 */
const ROOT_GATES: Record<string, string> = {
  "nether/root": "story/enter_the_nether",
  "end/root": "story/enter_the_end",
};

const CHILDREN = new Map<string, string[]>();
for (const a of ALL_ADVANCEMENTS) {
  if (a.parent === null) continue;
  const list = CHILDREN.get(a.parent) ?? [];
  list.push(a.id);
  CHILDREN.set(a.parent, list);
}

const DESCENDANT_COUNTS = new Map<string, number>();

/**
 * How many advancements this one eventually unlocks.
 *
 * The ordering signal. Alphabetically, story/enchant_item (0 descendants, a
 * dead end) beats story/lava_bucket (5 descendants, and the only route to the
 * nether's 24). Picking by id would have sent the swarm to enchanting while the
 * portal stayed unbuilt.
 */
export function descendantCount(id: string): number {
  const cached = DESCENDANT_COUNTS.get(id);
  if (cached !== undefined) return cached;
  let total = 0;
  for (const child of CHILDREN.get(id) ?? []) total += 1 + descendantCount(child);
  DESCENDANT_COUNTS.set(id, total);
  return total;
}

/**
 * Advancements that are reachable right now: not yet earned, but whose parent
 * has been (and whose dimension gate, if any, has been passed).
 *
 * This is the set worth putting in front of the model. Anything deeper is
 * noise — the bot cannot act on "kill the ender dragon" while it is still
 * looking for a bucket.
 */
export function frontierOf(earned: Set<string>): AdvancementNode[] {
  return ALL_ADVANCEMENTS.filter((a) => {
    if (earned.has(a.id)) return false;
    const gate = ROOT_GATES[a.id];
    if (gate !== undefined) return earned.has(gate);
    return a.parent === null || earned.has(a.parent);
  });
}
