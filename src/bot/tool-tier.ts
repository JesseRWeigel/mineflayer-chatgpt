// src/bot/tool-tier.ts
// Can the pickaxe in hand actually harvest the block being targeted?
//
// mine_block equipped the best pickaxe the bot owned and dug, without asking.
// A wooden pickaxe on iron ore takes hardness x5 = 15s and drops nothing, and
// digSafe gives up at 12s -- so the attempt cannot succeed no matter how often
// it is repeated, and it was repeated 251 times in one session while the swarm
// banked 1 item an hour.
//
// Failing in 0s with a message beats failing in 12s with "dig timeout": the
// brain can act on the first and learns nothing from the second.

/** Minecraft harvest levels. Gold is tier 0 despite its speed. */
const PICKAXE_TIERS: Record<string, number> = {
  wooden: 0,
  golden: 0,
  stone: 1,
  iron: 2,
  diamond: 3,
  netherite: 4,
};

/** Blocks needing better than a wooden pickaxe. Everything absent needs tier 0. */
const REQUIRED: Record<string, number> = {
  iron_ore: 1,
  copper_ore: 1,
  lapis_ore: 1,
  gold_ore: 2,
  redstone_ore: 2,
  diamond_ore: 2,
  emerald_ore: 2,
  obsidian: 3,
  crying_obsidian: 3,
  ancient_debris: 3,
};

/** Blocks that drop without any tool at all. */
const NO_TOOL_NEEDED = new Set([
  "dirt",
  "grass_block",
  "sand",
  "gravel",
  "clay",
  "oak_log",
  "birch_log",
  "spruce_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
]);

const cheapestFor = (tier: number): string => Object.entries(PICKAXE_TIERS).find(([, t]) => t === tier)?.[0] ?? "stone";

/**
 * What each pickaxe is actually crafted from. A wooden pickaxe is 3 planks and
 * 2 sticks and has never been craftable from cobblestone -- the first version of
 * this advice routed every tier through stone, which was wrong for tier 0 and
 * impossible for a bot holding no pickaxe at all.
 */
const MATERIAL_FOR: Record<string, string> = {
  wooden: "chop wood for oak planks and sticks",
  stone: "mine stone for cobblestone",
  iron: "smelt iron ore into iron ingots",
  diamond: "mine diamond ore for diamonds",
};

/** Tier of a pickaxe item, or null if it is not a pickaxe. */
export function pickaxeTier(itemName: string | null | undefined): number | null {
  if (!itemName || !itemName.endsWith("_pickaxe")) return null;
  const material = itemName.slice(0, -"_pickaxe".length);
  return PICKAXE_TIERS[material] ?? null;
}

/**
 * Pickaxe tier a block needs to DROP anything.
 *
 * Unknown blocks return 0 on purpose. A false negative here would stop the bot
 * mining something it could have mined, which is a worse failure than the 12s
 * timeout this check exists to avoid.
 */
export function requiredTier(blockName: string): number {
  if (REQUIRED[blockName] !== undefined) return REQUIRED[blockName];
  // Below y=0 every ore is the deepslate form. Treating those as unknown would
  // disable the check exactly where the mining actually happens.
  if (blockName.startsWith("deepslate_")) {
    const base = blockName.slice("deepslate_".length);
    if (REQUIRED[base] !== undefined) return REQUIRED[base];
  }
  return 0;
}

export function canHarvest(blockName: string, pickaxeName: string | null | undefined): boolean {
  if (NO_TOOL_NEEDED.has(blockName)) return true;
  const tier = pickaxeTier(pickaxeName);
  // Stone and its family still need *a* pickaxe to drop cobblestone at all.
  if (tier === null) return false;
  return tier >= requiredTier(blockName);
}

/**
 * What to do instead. The brain will re-request the same block next cycle
 * unless the failure tells it what would unblock it.
 */
export function harvestAdvice(blockName: string, pickaxeName: string | null | undefined): string {
  const needed = `${cheapestFor(requiredTier(blockName))}_pickaxe`;
  const held = pickaxeName ?? "nothing";
  const opening = `Can't harvest ${blockName} with ${held} — it needs a ${needed}.`;

  // A bot holding no pickaxe cannot mine ANY stone, so every route through
  // cobblestone is closed to it. Wood is the only material it can still gather
  // by hand, which makes a wooden pickaxe the one and only first step no matter
  // what the target needs. Sending it to stone told it to mine stone in order to
  // be able to mine stone -- 126 of 176 refusals in one session said exactly that.
  if (pickaxeTier(pickaxeName) === null) {
    const then = needed === "wooden_pickaxe" ? "" : ` Then work up to a ${needed} for ${blockName}.`;
    return `${opening} You have no pickaxe at all, so ${MATERIAL_FOR.wooden} and craft a wooden_pickaxe first.${then}`;
  }

  const route = MATERIAL_FOR[cheapestFor(requiredTier(blockName))] ?? MATERIAL_FOR.stone;
  return `${opening} ${capitalise(route)} and craft a ${needed} first, then come back for ${blockName}.`;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
