import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;

const TUNNEL_LENGTH = 30;
const TORCH_INTERVAL = 6;
const TARGET_Y = 11; // Classic diamond level, also good for iron/gold/redstone

export const stripMineSkill: Skill = {
  name: "strip_mine",
  description:
    "Dig a mining tunnel for ores. Staircases down to Y=11 if needed, then mines 30 blocks horizontally with torch lighting. Requires a pickaxe.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    // Verify pickaxe
    const pickaxe = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
    if (!pickaxe) {
      return { success: false, message: "Need a pickaxe! Use craft_gear first, then strip_mine." };
    }

    let mined = 0;
    const oresFound: string[] = [];

    // Snap to nearest cardinal direction
    const forward = getCardinalDirection(bot.entity.yaw);
    console.log(`[Skill] Strip mine direction: ${dirName(forward)}, starting Y=${bot.entity.position.y.toFixed(0)}`);

    // --- Phase 1: Staircase down to TARGET_Y if needed ---
    const currentY = Math.floor(bot.entity.position.y);
    if (currentY > TARGET_Y + 5) {
      onProgress({
        skillName: "strip_mine",
        phase: "Digging staircase",
        progress: 0,
        message: `Digging down to Y=${TARGET_Y}...`,
        active: true,
      });

      const stepsDown = currentY - TARGET_Y;
      for (let step = 0; step < stepsDown && !signal.aborted; step++) {
        const pos = bot.entity.position.floored();

        // Dig 3 blocks: head level ahead, foot level ahead, below foot ahead
        const targets = [
          pos.offset(forward.x, 1, forward.z),
          pos.offset(forward.x, 0, forward.z),
          pos.offset(forward.x, -1, forward.z),
        ];

        for (const t of targets) {
          const b = bot.blockAt(t);
          if (!b || b.name === "air" || b.name === "water" || b.name === "bedrock") continue;
          if (b.name === "lava") {
            return {
              success: mined > 0,
              message: `Hit lava! Retreated. Mined ${mined} blocks. ${formatOres(oresFound)}`,
              stats: { blocksMined: mined, oresFound: oresFound.length },
            };
          }

          await equipBestPickaxe(bot);
          try {
            await bot.dig(b);
            mined++;
            if (b.name.includes("ore")) oresFound.push(b.name);
          } catch { break; }
        }

        // Move into the dug space (one step forward, one step down)
        const targetPos = pos.offset(forward.x, -1, forward.z);
        await moveToPosition(bot, targetPos);

        // Place torch on wall every N steps
        if (step > 0 && step % TORCH_INTERVAL === 0) {
          await placeTorchOnWall(bot, forward);
        }

        if (step % 5 === 0) {
          onProgress({
            skillName: "strip_mine",
            phase: "Digging staircase",
            progress: (step / stepsDown) * 0.3,
            message: `Y=${bot.entity.position.y.toFixed(0)} → ${TARGET_Y}`,
            active: true,
          });
        }

        if (bot.entity.position.y <= TARGET_Y + 1) break;
      }
    }

    // --- Phase 2: Horizontal mining tunnel ---
    onProgress({
      skillName: "strip_mine",
      phase: "Mining tunnel",
      progress: 0.3,
      message: "Mining horizontal tunnel...",
      active: true,
    });

    for (let step = 0; step < TUNNEL_LENGTH && !signal.aborted; step++) {
      const pos = bot.entity.position.floored();

      // Dig 2 blocks ahead: foot level and head level
      const targets = [
        pos.offset(forward.x, 0, forward.z),
        pos.offset(forward.x, 1, forward.z),
      ];

      for (const t of targets) {
        const b = bot.blockAt(t);
        if (!b || b.name === "air") continue;
        if (b.name === "bedrock") {
          return {
            success: true,
            message: `Hit bedrock at step ${step}! Mined ${mined} blocks. ${formatOres(oresFound)}`,
            stats: { blocksMined: mined, oresFound: oresFound.length },
          };
        }
        if (b.name === "lava" || b.name === "water") continue;

        await equipBestPickaxe(bot);
        try {
          await bot.dig(b);
          mined++;
          if (b.name.includes("ore")) oresFound.push(b.name);
        } catch { /* skip */ }
      }

      // Walk forward into cleared space
      const targetPos = pos.offset(forward.x, 0, forward.z);
      await moveToPosition(bot, targetPos);

      // Place torch every N blocks
      if (step > 0 && step % TORCH_INTERVAL === 0) {
        await placeTorchOnWall(bot, forward);
      }

      if (step % 5 === 0) {
        onProgress({
          skillName: "strip_mine",
          phase: "Mining tunnel",
          progress: 0.3 + (step / TUNNEL_LENGTH) * 0.7,
          message: `${step}/${TUNNEL_LENGTH} blocks | Mined: ${mined} | Ores: ${oresFound.length}`,
          active: true,
        });
      }
    }

    if (mined === 0) {
      return { success: false, message: "Couldn't mine anything. Pickaxe might have broken." };
    }

    return {
      success: true,
      message: `Strip mine complete! Dug ${TUNNEL_LENGTH}-block tunnel, mined ${mined} blocks total. ${formatOres(oresFound)}`,
      stats: { blocksMined: mined, oresFound: oresFound.length },
    };
  },
};

// --- Helpers ---

async function equipBestPickaxe(bot: Bot): Promise<void> {
  const pick = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
  if (pick) await bot.equip(pick, "hand");
}

async function moveToPosition(bot: Bot, targetPos: Vec3): Promise<void> {
  try {
    const moves = new Movements(bot);
    moves.canDig = false;
    bot.pathfinder.setMovements(moves);
    await bot.pathfinder.goto(new goals.GoalBlock(targetPos.x, targetPos.y, targetPos.z));
  } catch {
    // Fallback: manual walk
    try {
      await bot.lookAt(targetPos.offset(0.5, 1, 0.5));
      bot.setControlState("forward", true);
      await bot.waitForTicks(8);
      bot.setControlState("forward", false);
    } catch { /* ok */ }
  }
}

async function placeTorchOnWall(bot: Bot, forward: Vec3): Promise<void> {
  const torch = bot.inventory.items().find((i) => i.name === "torch");
  if (!torch) return;

  // Left wall = 90 degrees from forward
  const wallDir = new Vec3(-forward.z, 0, forward.x);
  const wallBlock = bot.blockAt(
    bot.entity.position.floored().offset(wallDir.x, 1, wallDir.z),
  );
  if (wallBlock && wallBlock.name !== "air" && wallBlock.name !== "water") {
    try {
      await bot.equip(torch, "hand");
      await bot.placeBlock(wallBlock, new Vec3(-wallDir.x, 0, -wallDir.z));
    } catch { /* ok */ }
  }
}

function formatOres(ores: string[]): string {
  if (ores.length === 0) return "No ores this time — try a different direction!";
  const counts: Record<string, number> = {};
  for (const o of ores) counts[o] = (counts[o] || 0) + 1;
  return "Found: " + Object.entries(counts).map(([k, v]) => `${v}x ${k}`).join(", ") + "!";
}

/** Snap yaw to nearest cardinal direction vector. */
function getCardinalDirection(yaw: number): Vec3 {
  // Mineflayer: 0 = south (+Z), pi/2 = west (-X), pi = north (-Z), 3pi/2 = east (+X)
  const n = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (n >= Math.PI * 0.25 && n < Math.PI * 0.75) return new Vec3(-1, 0, 0); // west
  if (n >= Math.PI * 0.75 && n < Math.PI * 1.25) return new Vec3(0, 0, -1); // north
  if (n >= Math.PI * 1.25 && n < Math.PI * 1.75) return new Vec3(1, 0, 0); // east
  return new Vec3(0, 0, 1); // south
}

function dirName(dir: Vec3): string {
  if (dir.z === -1) return "north";
  if (dir.z === 1) return "south";
  if (dir.x === -1) return "west";
  return "east";
}
