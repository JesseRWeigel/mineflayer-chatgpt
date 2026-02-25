// src/skills/stash.ts
// Shared stash management — deposit/withdraw from categorised chests.

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { safeGoto } from "../bot/actions.js";

/** Stash row categories and their item patterns. Order matches physical chest rows. */
const STASH_ROWS: { category: string; patterns: string[] }[] = [
  {
    category: "building",
    patterns: [
      "log", "planks", "cobblestone", "stone", "deepslate", "glass", "sand",
      "sandstone", "brick", "terracotta", "concrete", "gravel", "dirt",
    ],
  },
  {
    category: "metals",
    patterns: [
      "raw_iron", "iron_ingot", "iron_nugget", "raw_copper", "copper_ingot",
      "raw_gold", "gold_ingot", "gold_nugget", "coal", "diamond", "emerald",
      "lapis", "redstone", "quartz", "netherite", "amethyst",
    ],
  },
  {
    category: "food",
    patterns: [
      "wheat", "seed", "bread", "carrot", "potato", "beetroot", "melon",
      "pumpkin", "apple", "porkchop", "beef", "chicken", "mutton", "cod",
      "salmon", "rabbit", "stew", "cookie", "cake", "pie", "sugar",
      "egg", "cocoa", "mushroom", "kelp", "sweet_berries",
    ],
  },
  {
    category: "tools",
    patterns: [
      "sword", "pickaxe", "axe", "shovel", "hoe", "bow", "crossbow",
      "arrow", "shield", "helmet", "chestplate", "leggings", "boots",
      "fishing_rod", "shears", "flint_and_steel", "compass", "clock",
      "spyglass", "trident",
    ],
  },
];

/** Determine which stash category an item belongs to. Returns "overflow" if no match. */
export function categorizeItem(itemName: string): string {
  for (const row of STASH_ROWS) {
    if (row.patterns.some((p) => itemName.includes(p))) {
      return row.category;
    }
  }
  return "overflow";
}

/** Get the chest offset for a category (row index along X axis, 2 blocks per row for double chests). */
export function getRowOffset(category: string): number {
  const idx = STASH_ROWS.findIndex((r) => r.category === category);
  return idx >= 0 ? idx * 2 : STASH_ROWS.length * 2; // overflow goes after last row
}

/** Check if an item should be kept based on the bot's keepItems config. */
export function shouldKeep(
  itemName: string,
  keepItems: { name: string; minCount: number }[],
  currentCounts: Map<string, number>
): boolean {
  for (const keep of keepItems) {
    if (itemName.includes(keep.name)) {
      const kept = currentCounts.get(keep.name) ?? 0;
      if (kept < keep.minCount) {
        currentCounts.set(keep.name, kept + 1);
        return true;
      }
    }
  }
  return false;
}

export { STASH_ROWS };
