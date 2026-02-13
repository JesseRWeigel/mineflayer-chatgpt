import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";

const MAX_BRIDGE_LENGTH = 30;

/** Block types usable for bridge building. */
const BRIDGE_BLOCKS = [
  "cobblestone", "stone", "deepslate", "dirt",
  "oak_planks", "spruce_planks", "birch_planks", "jungle_planks",
  "acacia_planks", "dark_oak_planks", "cherry_planks", "mangrove_planks",
];

export const buildBridgeSkill: Skill = {
  name: "build_bridge",
  description:
    "Build a bridge across water or a gap in the direction you're facing. Uses cobblestone or planks from inventory. Max 30 blocks.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const blockCount = bot.inventory.items()
      .filter((i) => BRIDGE_BLOCKS.includes(i.name))
      .reduce((s, i) => s + i.count, 0);

    if (blockCount < 3) {
      return { success: false, message: "Need building blocks for a bridge! Get cobblestone or planks first." };
    }

    // Determine direction from bot's facing
    const forward = getCardinalDirection(bot.entity.yaw);
    const dirStr = dirName(forward);

    onProgress({
      skillName: "build_bridge",
      phase: "Building bridge",
      progress: 0,
      message: `Bridging ${dirStr}...`,
      active: true,
    });

    let placed = 0;

    // Sneak to avoid falling off edges
    bot.setControlState("sneak", true);

    try {
      for (let step = 0; step < MAX_BRIDGE_LENGTH && !signal.aborted; step++) {
        const pos = bot.entity.position.floored();
        const nextPos = pos.offset(forward.x, 0, forward.z);
        const belowNext = nextPos.offset(0, -1, 0);
        const belowCurrent = pos.offset(0, -1, 0);

        // If solid ground ahead and we've bridged some distance, we're done
        const belowNextBlock = bot.blockAt(belowNext);
        if (placed > 2 && belowNextBlock && isSolid(belowNextBlock.name)) {
          break;
        }

        // Check if the next position is blocked by a wall
        const nextBlock = bot.blockAt(nextPos);
        if (nextBlock && isSolid(nextBlock.name)) {
          break;
        }

        // If there's no ground below the next position, place a block
        if (!belowNextBlock || !isSolid(belowNextBlock.name)) {
          const bridgeItem = bot.inventory.items().find((i) => BRIDGE_BLOCKS.includes(i.name));
          if (!bridgeItem) break;

          const currentBelow = bot.blockAt(belowCurrent);
          if (!currentBelow || !isSolid(currentBelow.name)) {
            // Can't place without a reference block under our feet
            break;
          }

          try {
            await bot.equip(bridgeItem, "hand");
            await bot.lookAt(belowNext.offset(0.5, 0.5, 0.5));
            const ok = await Promise.race([
              bot.placeBlock(currentBelow, forward).then(() => true).catch(() => false),
              new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
            ]);
            if (ok) {
              placed++;
            } else {
              break;
            }
          } catch { break; }
        }

        // Walk forward one block
        bot.setControlState("forward", true);
        await bot.waitForTicks(5);
        bot.setControlState("forward", false);
        await bot.waitForTicks(3);

        if (step % 3 === 0) {
          onProgress({
            skillName: "build_bridge",
            phase: "Building bridge",
            progress: step / MAX_BRIDGE_LENGTH,
            message: `${placed} blocks placed heading ${dirStr}`,
            active: true,
          });
        }
      }
    } finally {
      bot.setControlState("sneak", false);
      bot.setControlState("forward", false);
    }

    if (placed === 0) {
      return {
        success: false,
        message: "Couldn't place any bridge blocks. Stand at the edge of water/gap facing across, then try again.",
      };
    }

    return {
      success: true,
      message: `Bridge built! ${placed} blocks heading ${dirStr}. Safe crossing!`,
      stats: { blocksPlaced: placed },
    };
  },
};

function isSolid(name: string): boolean {
  return name !== "air" && name !== "water" && name !== "lava" &&
    name !== "short_grass" && name !== "tall_grass";
}

function getCardinalDirection(yaw: number): Vec3 {
  const n = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (n >= Math.PI * 0.25 && n < Math.PI * 0.75) return new Vec3(-1, 0, 0);
  if (n >= Math.PI * 0.75 && n < Math.PI * 1.25) return new Vec3(0, 0, -1);
  if (n >= Math.PI * 1.25 && n < Math.PI * 1.75) return new Vec3(1, 0, 0);
  return new Vec3(0, 0, 1);
}

function dirName(dir: Vec3): string {
  if (dir.z === -1) return "north";
  if (dir.z === 1) return "south";
  if (dir.x === -1) return "west";
  return "east";
}
