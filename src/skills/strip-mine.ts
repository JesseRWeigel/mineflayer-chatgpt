import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import { baseMoves, collectNearbyDrops } from "../bot/navigation.js";
import { digDownTo } from "./descend.js";
import { getSeasonGoal } from "../bot/memory.js";

const TUNNEL_LENGTH = 40;
const TORCH_INTERVAL = 6;
// Y=16 is IRON's peak in 1.18+ (and the classic iron-mining level). At Y=-16
// (a prior diamond-chasing setting) tunnels yielded gold/redstone but ZERO
// iron — the deepslate zone is iron-poor — which starved the whole
// iron->tools->armor chain (0 iron smelted for runs). Diamonds are shelved
// (volume-limited, not worth the deep lava), so there's no reason to be that
// deep. Y=16 restores iron supply, still yields coal/copper, and is well above
// the lava lakes (~-50) so it stays lava-safe.
const TARGET_Y = 16;

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

    // Depth follows the mission AND the tools: the portal doorway is plugged
    // with obsidian only a diamond pickaxe clears, and diamonds live far
    // below the iron band this skill was tuned for. A diamond mission digs
    // to the prime band — but only with an iron-or-better pick aboard, since
    // a stone-pick bot can harvest nothing down there and should be mining
    // IRON at y=16 to tier up first. The steering text flips the depth back
    // when the mission moves on.
    const hasIronPick = bot.inventory.items().some((i) => (PICK_TIER[i.name] ?? 0) >= 2);
    const targetY = hasIronPick && /diamond/i.test(getSeasonGoal() ?? "") ? -53 : TARGET_Y;

    // Snap to nearest cardinal direction
    const forward = getCardinalDirection(bot.entity.yaw);
    console.log(`[Skill] Strip mine direction: ${dirName(forward)}, starting Y=${bot.entity.position.y.toFixed(0)}`);

    // --- Phase 1: Descend to targetY (iron/diamond depth) ---
    // The old manual staircase dug blocks but moveToPosition often failed to
    // follow it down, so the bot stayed at the surface (Y~64-90) and tunneled
    // where iron is rare — 12 runs found only coal, 0 iron. Use the pathfinder
    // with digging enabled to ACTUALLY reach depth: it handles the descent and
    // avoids lava/dangerous falls itself.
    const currentY = Math.floor(bot.entity.position.y);
    if (currentY > targetY + 5) {
      onProgress({
        skillName: "strip_mine",
        phase: "Digging down",
        progress: 0.05,
        message: `Digging down to Y=${targetY} (iron depth)...`,
        active: true,
      });
      const digMoves = baseMoves(bot);
      digMoves.canDig = true;
      digMoves.allow1by1towers = true;
      bot.pathfinder.setMovements(digMoves);
      try {
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalY(targetY)),
          new Promise<void>((_, rej) =>
            setTimeout(() => {
              bot.pathfinder.stop();
              rej(new Error("descend timeout"));
            }, 60000),
          ),
        ]);
      } catch {
        // The pathfinder could not route a dig path out of this terrain. That
        // is the common case, not the rare one: 12 of 14 runs stalled within a
        // few blocks of the surface while the 2 that worked reached y=16 and
        // y=-33 comfortably. Raising the budget would only re-create the
        // watchdog stall noted below, so fall back to digging straight down,
        // which is what a player does and what safeToDigDown makes survivable.
        const fallback = await digDownTo(bot, targetY);
        console.log(`[Skill] strip_mine pathfinder descent failed; ${fallback}`);
      }
      // Collect anything the descent dropped (ore dug on the way down).
      await collectNearbyDrops(bot, 4, 3000);
      console.log(`[Skill] strip_mine descended to Y=${bot.entity.position.y.toFixed(0)}`);
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
      const targets = [pos.offset(forward.x, 0, forward.z), pos.offset(forward.x, 1, forward.z)];

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
        if (b.name === "lava" || b.name === "water") {
          // Skipping the wet cell used to leave the walk-forward step to
          // wade straight into it — Forge ended the night swimming in his
          // own flooded tunnel one block from iron ore. A breached fluid
          // ends the tunnel with whatever it earned.
          return {
            success: mined > 0,
            message: `Tunnel hit ${b.name} at step ${step} — stopped before wading in. Mined ${mined} blocks. ${formatOres(oresFound)}`,
            stats: { blocksMined: mined, oresFound: oresFound.length },
          };
        }
        if (!canHarvest(bot, b.name)) {
          console.log(`[Skill] strip_mine tunnel skipping ${b.name} — no iron-tier pickaxe to harvest it`);
          continue;
        }

        await equipBestPickaxe(bot);
        try {
          await digSafe(bot, b);
          mined++;
          if (b.name.includes("ore")) oresFound.push(b.name);
        } catch {
          /* skip */
        }
      }

      // Mine any ore exposed in the surrounding walls/floor/ceiling. The old
      // tunnel only checked the 2 blocks dead ahead, so it walked straight past
      // veins in the walls — which is why nights of mining found "0 ores".
      const exposed = await mineExposedOre(bot, pos);
      mined += exposed.mined;
      oresFound.push(...exposed.ores);

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

    // Sweep the tunnel to pick up the ore we dug — without this, strip_mine
    // reported "Found 8x iron_ore" but left the drops on the ground, so the
    // bot never actually had iron to smelt. Walk back over the tunnel.
    await collectNearbyDrops(bot, 16, 8000);

    // Report the depth actually reached, not the one intended. Nine runs
    // returned "Strip mine complete!" while Forge stayed at y=68: the 60s
    // descent timeout fired, the catch swallowed it, and the skill mined a
    // tunnel at the surface and called it a success. Anything downstream that
    // needs depth -- fill_bucket looking for lava -- was then told to strip_mine
    // again, from the same place, forever.
    const endY = Math.floor(bot.entity.position.y);
    const reachedDepth = endY <= targetY + 5;
    const depthNote = reachedDepth
      ? ` Now at y=${endY}.`
      : ` NOTE: still at y=${endY}, never reached ore depth (y=${targetY}) — the descent was blocked or timed out. Try from an open area or a cave entrance.`;

    return {
      success: true,
      message: `Strip mine complete! Dug ${TUNNEL_LENGTH}-block tunnel, mined ${mined} blocks total.${depthNote} ${formatOres(oresFound)}`,
      stats: { blocksMined: mined, oresFound: oresFound.length },
    };
  },
};

// --- Helpers ---

const PICK_TIER: Record<string, number> = {
  wooden_pickaxe: 0,
  stone_pickaxe: 1,
  golden_pickaxe: 1,
  iron_pickaxe: 2,
  diamond_pickaxe: 3,
  netherite_pickaxe: 4,
};

async function equipBestPickaxe(bot: Bot): Promise<void> {
  // BEST means best: the old find() grabbed the first pickaxe in the pack,
  // so a bot carrying stone and iron could mine with stone.
  const picks = bot.inventory.items().filter((i) => i.name.endsWith("_pickaxe"));
  const pick = picks.sort((a, b) => (PICK_TIER[b.name] ?? 0) - (PICK_TIER[a.name] ?? 0))[0];
  if (pick) await bot.equip(pick, "hand");
}

// Diamond ore mined below iron tier drops NOTHING — the ore is destroyed
// forever. Gold, emerald and redstone share the rule. Refuse those digs
// unless an iron-or-better pickaxe is in the pack; the vein stays in the
// wall for the properly equipped trip.
const IRON_TIER_ORES = /(diamond|emerald|gold|redstone)_ore$/;
function canHarvest(bot: Bot, name: string): boolean {
  if (!IRON_TIER_ORES.test(name)) return true;
  return bot.inventory.items().some((i) => (PICK_TIER[i.name] ?? 0) >= 2);
}

/**
 * bot.dig with a hard timeout. A bare bot.dig can hang indefinitely if the
 * block can't be reached/broken — this (plus an over-long descent timeout) made
 * strip_mine run to the 240s skill watchdog repeatedly, stalling the miner.
 * Fail fast (12s) and move on instead.
 */
async function digSafe(bot: Bot, b: import("prismarine-block").Block): Promise<void> {
  await Promise.race([
    bot.dig(b),
    new Promise<void>((_, rej) =>
      setTimeout(() => {
        try {
          bot.stopDigging();
        } catch {
          /* not digging */
        }
        rej(new Error("dig timeout"));
      }, 12000),
    ),
  ]);
}

/**
 * Mine any ore block exposed in the 3x3x3 shell around `pos` (the bot's cell),
 * then follow each vein a few blocks. This is what turns a blind tunnel into an
 * actually-productive one — ores in the walls used to be ignored entirely.
 */
async function mineExposedOre(bot: Bot, pos: Vec3): Promise<{ mined: number; ores: string[] }> {
  let mined = 0;
  const ores: string[] = [];
  const toCheck: Vec3[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue; // skip the cleared path itself
        toCheck.push(pos.offset(dx, dy, dz));
      }
    }
  }
  for (const t of toCheck) {
    const b = bot.blockAt(t);
    if (!b || !b.name.endsWith("_ore")) continue;
    if (!canHarvest(bot, b.name)) {
      console.log(`[Skill] strip_mine leaving ${b.name} in the wall — no iron-tier pickaxe to harvest it`);
      continue;
    }
    try {
      await equipBestPickaxe(bot);
      await digSafe(bot, b);
      mined++;
      ores.push(b.name);
      // Follow the vein a little so we don't leave most of it in the wall.
      mined += await followVein(bot, t, b.name, ores);
    } catch {
      /* out of reach or interrupted — skip */
    }
  }
  return { mined, ores };
}

async function followVein(bot: Bot, start: Vec3, oreName: string, ores: string[], cap = 8): Promise<number> {
  const seen = new Set<string>([start.toString()]);
  const queue: Vec3[] = [start];
  let extra = 0;
  while (queue.length && extra < cap) {
    const cur = queue.shift()!;
    for (const d of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const) {
      const p = cur.offset(d[0], d[1], d[2]);
      if (seen.has(p.toString())) continue;
      seen.add(p.toString());
      const b = bot.blockAt(p);
      if (!b || b.name !== oreName) continue;
      if (bot.entity.position.distanceTo(p) > 4.3) continue; // only what we can reach without re-pathing
      try {
        await equipBestPickaxe(bot);
        await digSafe(bot, b);
        extra++;
        ores.push(b.name);
        queue.push(p);
      } catch {
        /* skip */
      }
    }
  }
  return extra;
}

async function moveToPosition(bot: Bot, targetPos: Vec3): Promise<void> {
  try {
    const moves = baseMoves(bot);
    moves.canDig = false;
    bot.pathfinder.setMovements(moves);
    // Bounded: an unreachable GoalBlock here hung strip_mine (and the whole
    // bot) for ~13h. Race against a timeout that stops the pathfinder.
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalBlock(targetPos.x, targetPos.y, targetPos.z)),
      new Promise<void>((_, rej) =>
        setTimeout(() => {
          bot.pathfinder.stop();
          rej(new Error("moveToPosition timeout"));
        }, 8000),
      ),
    ]);
  } catch {
    // Fallback: manual walk
    try {
      await bot.lookAt(targetPos.offset(0.5, 1, 0.5));
      bot.setControlState("forward", true);
      await bot.waitForTicks(8);
      bot.setControlState("forward", false);
    } catch {
      /* ok */
    }
  }
}

async function placeTorchOnWall(bot: Bot, forward: Vec3): Promise<void> {
  const torch = bot.inventory.items().find((i) => i.name === "torch");
  if (!torch) return;

  // Left wall = 90 degrees from forward
  const wallDir = new Vec3(-forward.z, 0, forward.x);
  const wallBlock = bot.blockAt(bot.entity.position.floored().offset(wallDir.x, 1, wallDir.z));
  if (wallBlock && wallBlock.name !== "air" && wallBlock.name !== "water") {
    try {
      await bot.equip(torch, "hand");
      await bot.placeBlock(wallBlock, new Vec3(-wallDir.x, 0, -wallDir.z));
    } catch {
      /* ok */
    }
  }
}

function formatOres(ores: string[]): string {
  if (ores.length === 0) return "No ores this time — try a different direction!";
  const counts: Record<string, number> = {};
  for (const o of ores) counts[o] = (counts[o] || 0) + 1;
  return (
    "Found: " +
    Object.entries(counts)
      .map(([k, v]) => `${v}x ${k}`)
      .join(", ") +
    "!"
  );
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
