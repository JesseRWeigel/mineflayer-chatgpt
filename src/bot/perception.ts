import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { recordOre } from "./memory.js";

export function getWorldContext(bot: Bot): string {
  const pos = bot.entity.position;
  const health = bot.health;
  const food = bot.food;
  const time = bot.time.timeOfDay;
  const isDay = time < 13000 || time > 23000;
  const timeStr = isDay ? "daytime" : "nighttime";

  // Inventory summary
  const items = bot.inventory.items();
  const invSummary =
    items.length > 0
      ? items.map((i) => `${i.name}x${i.count}`).join(", ")
      : "empty";

  // Nearby entities
  const nearbyEntities = getNearbyEntities(bot, 16);
  const hostiles = nearbyEntities.filter((e) => isHostile(e));
  const players = nearbyEntities.filter(
    (e) => e.type === "player" && e.username !== bot.username
  );
  const animals = nearbyEntities.filter((e) => isPassive(e));

  // Nearby blocks (what's around us)
  const nearbyBlocks = getNearbyBlockTypes(bot);

  const parts: string[] = [
    `Position: ${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}`,
    `Health: ${health}/20, Hunger: ${food}/20`,
    `Time: ${timeStr} (${time})`,
    `Inventory: ${invSummary}`,
  ];

  if (hostiles.length > 0) {
    parts.push(
      `DANGER - Hostile mobs nearby: ${hostiles.map((e) => `${e.name || e.mobType} (${distTo(bot, e).toFixed(0)} blocks away)`).join(", ")}`
    );
  }

  if (players.length > 0) {
    parts.push(
      `Players nearby: ${players.map((e) => e.username).join(", ")}`
    );
  }

  if (animals.length > 0) {
    parts.push(
      `Animals nearby: ${animals.map((e) => e.name || e.mobType).join(", ")}`
    );
  }

  if (nearbyBlocks.length > 0) {
    parts.push(`Nearby notable blocks: ${nearbyBlocks.join(", ")}`);
  }

  if (food <= 6) {
    parts.push("WARNING: Very hungry! Should eat soon.");
  }

  if (health <= 8) {
    parts.push("WARNING: Low health! Be careful.");
  }

  if (!isDay) {
    parts.push(
      "It's night — hostile mobs spawn in the dark. Consider shelter or a bed."
    );
  }

  // Water/ocean detection
  const feetBlock = bot.blockAt(pos);
  const headBlock = bot.blockAt(pos.offset(0, 1, 0));
  if (feetBlock?.name === "water" || headBlock?.name === "water") {
    parts.push(
      "ALERT: Bot is IN WATER (ocean/river/lake). Use the 'explore' action to escape to dry land IMMEDIATELY — do NOT craft, build, or idle while underwater."
    );
  }

  return parts.join("\n");
}

function getNearbyEntities(bot: Bot, range: number): Entity[] {
  return Object.values(bot.entities).filter((e) => {
    if (e === bot.entity) return false;
    return distTo(bot, e) <= range;
  });
}

function distTo(bot: Bot, entity: Entity): number {
  return bot.entity.position.distanceTo(entity.position);
}

const HOSTILE_MOBS = new Set([
  "zombie",
  "skeleton",
  "creeper",
  "spider",
  "enderman",
  "witch",
  "phantom",
  "drowned",
  "husk",
  "stray",
  "blaze",
  "ghast",
  "wither_skeleton",
  "piglin_brute",
  "warden",
  "pillager",
  "vindicator",
  "evoker",
  "ravager",
  "slime",
  "magma_cube",
]);

const PASSIVE_MOBS = new Set([
  "cow",
  "pig",
  "sheep",
  "chicken",
  "horse",
  "donkey",
  "rabbit",
  "wolf",
  "cat",
  "fox",
  "mooshroom",
  "parrot",
  "turtle",
  "bee",
  "goat",
  "frog",
  "axolotl",
  "camel",
  "sniffer",
]);

export function isHostile(entity: Entity): boolean {
  const name = (entity.name || entity.mobType || "").toLowerCase();
  return HOSTILE_MOBS.has(name);
}

export function isPassive(entity: Entity): boolean {
  const name = (entity.name || entity.mobType || "").toLowerCase();
  return PASSIVE_MOBS.has(name);
}

const NOTABLE_BLOCKS = new Set([
  "diamond_ore",
  "deepslate_diamond_ore",
  "iron_ore",
  "deepslate_iron_ore",
  "gold_ore",
  "deepslate_gold_ore",
  "coal_ore",
  "deepslate_coal_ore",
  "lapis_ore",
  "redstone_ore",
  "emerald_ore",
  "crafting_table",
  "furnace",
  "chest",
  "bed",
  "enchanting_table",
  "anvil",
  "brewing_stand",
  "spawner",
  "village_bell",
]);

function getNearbyBlockTypes(bot: Bot): string[] {
  const found = new Set<string>();
  const pos = bot.entity.position;

  for (let dx = -8; dx <= 8; dx += 2) {
    for (let dy = -4; dy <= 4; dy += 2) {
      for (let dz = -8; dz <= 8; dz += 2) {
        const block = bot.blockAt(pos.offset(dx, dy, dz));
        if (block && NOTABLE_BLOCKS.has(block.name)) {
          found.add(block.name);
          if (block.name.includes("ore")) {
            recordOre(block.name, pos.x + dx, pos.y + dy, pos.z + dz);
          }
        }
      }
    }
  }

  return Array.from(found);
}
