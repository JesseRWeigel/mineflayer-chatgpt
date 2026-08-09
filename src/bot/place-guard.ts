// src/bot/place-guard.ts
// Refuse to build storage and workstations into the sky.
//
// Two fall records, the first in this investigation to name real footing:
//
//   Mason fell 43.0 blocks from y=116
//   [stood ... at=278,123,-324 in=air on=chest          1154ms before leaving]
//   Mason fell 30.0 blocks from y=119
//   [stood ... at=281,119,-323 in=air on=crafting_table  199ms before leaving]
//
// Chests and crafting tables at y=119 and y=123, about 50 blocks above the base
// at y=70. The same session placed 10 chests and 6 crafting tables and logged 36
// ascents to y=121-126.
//
// It also explains a failure I had been treating as unrelated: deposits bounce
// with chest_unreachable, and a chest at y=123 is unreachable by construction.
// Storage 50 blocks above the stash was never storage.

/**
 * Containers and workstations. Deliberately NOT building blocks: towering and
 * bridging with cobblestone is how the pathfinder gets anywhere, and blocking
 * that would break navigation. The hazard is a perch made of furniture.
 */
const FURNITURE = [
  "chest",
  "barrel",
  "shulker_box",
  "crafting_table",
  "furnace",
  "blast_furnace",
  "smoker",
  "brewing_stand",
  "enchanting_table",
  "anvil",
  "hopper",
  "dispenser",
  "dropper",
  "beacon",
  "lectern",
  "loom",
  "cartography_table",
  "fletching_table",
  "grindstone",
  "smithing_table",
  "stonecutter",
];

/**
 * How far above the base furniture may still be placed. Generous enough for a
 * two-storey build at the stash, far below the y=119-123 the falls came from.
 */
export const FURNITURE_MAX_ABOVE_BASE = 16;

export function isFurniture(blockType: string): boolean {
  return FURNITURE.some((f) => blockType === f || blockType.endsWith(`_${f}`));
}

/**
 * Depth is allowed on purpose. Bots mine to y=-3 and a furnace down there is
 * useful — it gets smelting done where the ore is. The hazard being prevented
 * is a perch ABOVE the base, not distance from it.
 */
export function tooHighForFurniture(blockType: string, y: number, baseY: number | undefined): boolean {
  if (baseY === undefined) return false; // nothing to measure against
  if (!isFurniture(blockType)) return false;
  return y > baseY + FURNITURE_MAX_ABOVE_BASE;
}

/**
 * Say where it should go instead. Four separate bugs today were a correct
 * refusal paired with advice that could not be followed, so the refusal that
 * does not redirect is only half a decision.
 */
export function furnitureRefusal(blockType: string, y: number, baseY: number): string {
  const above = y - baseY;
  return (
    `Won't place a ${blockType} at y=${y} — that is ${above} blocks above the base. ` +
    `Nobody can reach storage up here and standing on it is how bots fall. ` +
    `Go back down to the base and place it at ground level.`
  );
}
