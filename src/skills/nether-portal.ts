// src/skills/nether-portal.ts
//
// Build the frame, light it, step through, and be able to come home.
//
// The return trip is not decoration. The Nether is 8:1, so a bot that walks
// away from its arrival portal cannot navigate back by overworld coordinates,
// and it is carrying the iron the whole plan was spent acquiring.

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import type { Skill, SkillResult } from "./types.js";
import { framePositions, interiorPositions, ignitionTarget } from "./portal-geometry.js";
import { acquireObsidian } from "./obsidian.js";
import type { Vec3Like } from "./fluid.js";
import { baseMoves, safeGoto } from "../bot/navigation.js";

const REQUIRED = ["bucket", "flint_and_steel"] as const;

export function readinessOf(names: string[]): { ready: boolean; missing: string[] } {
  const has = (want: string) =>
    want === "bucket"
      ? names.some((n) => n === "bucket" || n === "water_bucket" || n === "lava_bucket")
      : names.includes(want);
  const missing = REQUIRED.filter((r) => !has(r));
  return { ready: missing.length === 0, missing: [...missing] };
}

/** Where each bot's portal is, so it can find its way back. */
const portals = new Map<string, { origin: Vec3Like; axis: "x" | "z" }>();

export function recordPortal(bot: Bot, origin: Vec3Like, axis: "x" | "z"): void {
  portals.set(bot.username, { origin, axis });
}

export function lastPortal(botName: string): { origin: Vec3Like; axis: "x" | "z" } | undefined {
  return portals.get(botName);
}

/**
 * Place the frame against existing solid blocks. bot.placeBlock needs a
 * REFERENCE block and a face vector to build off, not a target coordinate
 * (src/skills/build-bridge.ts:95), so a position with nothing below it yet
 * cannot be placed on the first pass. Floor first, then jambs bottom-up, then
 * the lintel -- each row gives the next something solid to build against.
 * Run the whole loop twice: the second pass catches whatever the first left
 * behind once earlier rows filled in the missing support.
 */
async function placeFrame(bot: Bot, origin: Vec3Like, axis: "x" | "z"): Promise<void> {
  const frame = framePositions(origin, axis);
  const floor = frame.filter((p) => p.y === origin.y - 1);
  const jambs = frame
    .filter((p) => p.y >= origin.y && p.y < origin.y + 3)
    .sort((a, b) => a.y - b.y);
  const lintel = frame.filter((p) => p.y === origin.y + 3);
  const ordered = [...floor, ...jambs, ...lintel];

  for (let pass = 0; pass < 2; pass++) {
    for (const pos of ordered) {
      const target = new Vec3(pos.x, pos.y, pos.z);
      if (bot.blockAt(target)?.name === "obsidian") continue;

      const held = bot.inventory.items().find((i) => i.name === "obsidian");
      if (!held) return; // out of obsidian; nothing left to place with

      const below = bot.blockAt(target.offset(0, -1, 0));
      if (!below || below.name === "air") continue; // nothing to build off yet, catch it next pass

      await bot.equip(held, "hand");
      await bot.placeBlock(below, new Vec3(0, 1, 0)).catch(() => {});
    }
  }
}

export async function buildNetherPortal(bot: Bot): Promise<string> {
  const names = bot.inventory.items().map((i) => i.name);
  const { ready, missing } = readinessOf(names);
  if (!ready) return `Not ready for a portal: missing ${missing.join(", ")}. Craft those first.`;

  const p = bot.entity.position;
  // Build one block clear of the bot so it never entombs itself in the frame.
  const origin: Vec3Like = { x: Math.floor(p.x) + 2, y: Math.floor(p.y), z: Math.floor(p.z) };
  const axis: "x" | "z" = "x";

  const frame = framePositions(origin, axis);
  const got = await acquireObsidian(bot, frame);
  if (!got.startsWith("Cast") && !got.startsWith("Mined") && !got.startsWith("Already")) {
    return `Portal stalled getting obsidian: ${got}`;
  }

  // Placed-block route: if obsidian ended up in inventory (the mine route, or
  // any leftover from casting), set the frame by hand. Casting already writes
  // obsidian directly into the world at each position, so this is a no-op
  // there beyond the already-obsidian check inside placeFrame.
  if (bot.inventory.items().some((i) => i.name === "obsidian")) {
    await placeFrame(bot, origin, axis);
  }

  const frameComplete = frame.every((pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "obsidian");
  if (!frameComplete) return "Portal stalled: frame is not complete after acquiring and placing obsidian.";

  // Clear the interior so the portal has room to form.
  for (const pos of interiorPositions(origin, axis)) {
    const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (b && b.name !== "air" && b.name !== "nether_portal") await bot.dig(b).catch(() => {});
  }

  const igniter = bot.inventory.items().find((i) => i.name === "flint_and_steel");
  if (!igniter) return "Frame built but no flint_and_steel to light it.";
  await bot.equip(igniter, "hand");

  const t = ignitionTarget(origin, axis);
  const below = bot.blockAt(new Vec3(t.x, t.y - 1, t.z));
  if (below) await bot.activateBlock(below).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));

  const lit = interiorPositions(origin, axis).some(
    (pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "nether_portal",
  );
  if (!lit) return "Frame built but the portal did not light. Check the frame is complete.";

  recordPortal(bot, origin, axis);
  return `Portal built and lit at ${origin.x},${origin.y},${origin.z}.`;
}

// Read behind a function call so tsc does not narrow bot.game.dimension to a
// single literal across the awaits below — the whole point of re-checking it
// after walking and waiting is that it CAN change out from under us.
function dimensionOf(bot: Bot): string {
  return bot.game.dimension;
}

export async function returnThroughPortal(bot: Bot): Promise<string> {
  // mineflayer's Dimension type is never "minecraft:"-prefixed (index.d.ts:482:
  // 'the_nether' | 'overworld' | 'the_end'), so checking for a prefixed variant
  // here was dead code masking an impossible comparison.
  if (dimensionOf(bot) !== "the_nether") {
    return "Not in the Nether — nothing to return from.";
  }
  const portal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 64 });
  if (!portal) return "Cannot find a nether_portal within 64 blocks.";

  bot.pathfinder.setMovements(baseMoves(bot));
  try {
    await safeGoto(bot, new goals.GoalBlock(portal.position.x, portal.position.y, portal.position.z), 20000);
  } catch {
    // Best effort — still worth standing near the portal and waiting for the
    // dimension change even if pathfinder gave up short of the exact block.
  }

  // Standing in the portal is what triggers the transition; give it time.
  await new Promise((r) => setTimeout(r, 6000));
  const home = dimensionOf(bot) === "overworld";
  return home ? "Returned to the overworld." : "Stood in the portal but did not transition.";
}

export const buildNetherPortalSkill: Skill = {
  name: "build_nether_portal",
  description:
    "Build and light a Nether portal near your current position using obsidian (cast or mined) and flint_and_steel. Requires a bucket and flint_and_steel first. Records the portal location so return_from_nether can find its way home.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, _signal, _onProgress): Promise<SkillResult> {
    const message = await buildNetherPortal(bot);
    const success = message.startsWith("Portal built and lit");
    return { success, message };
  },
};

export const returnFromNetherSkill: Skill = {
  name: "return_from_nether",
  description:
    "Walk to the nearest nether_portal and step through to return to the overworld. Use after build_nether_portal has taken you to the Nether.",
  params: {},

  estimateMaterials(_bot, _params) {
    return {};
  },

  async execute(bot, _params, _signal, _onProgress): Promise<SkillResult> {
    const message = await returnThroughPortal(bot);
    const success = message === "Returned to the overworld.";
    return { success, message };
  },
};
