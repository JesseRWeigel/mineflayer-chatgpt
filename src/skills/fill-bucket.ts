/**
 * Fill a bucket from a lava or water source.
 *
 * story/lava_bucket triggers on simply HOLDING minecraft:lava_bucket, and it is
 * the first rung of the only route to the Nether's 24 advancements.
 *
 * fillBucket() already existed in fluid.ts, but the only path to it ran through
 * obsidian.ts -> castInPlace -> build_nether_portal, which refuses to start
 * without flint_and_steel. So after Forge finally crafted a bucket, the chain
 * stopped: the swarm could make a bucket and had no way to fill one.
 *
 * That is the third time a capability has shipped without a registered entry
 * point. A skill the model cannot name is a skill that does not exist.
 */

import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { fillBucket } from "./fluid.js";
import { digDownTo } from "./descend.js";

export type Fluid = "lava" | "water";

export interface BucketPlan {
  /** Holding an empty bucket and able to go fill it. */
  ready: boolean;
  /** Already holding the requested filled bucket. */
  done: boolean;
  message: string;
}

/**
 * What, if anything, is stopping this bot filling a bucket right now.
 *
 * Pure so the precondition is testable without a server. Messages deliberately
 * never begin "<name> failed:" — that prefix marks a thrown skill and always
 * counts against its retirement stats, and a missing bucket is the
 * environment's fault rather than the skill's.
 */
export function bucketPlan(inventoryNames: string[], fluid: Fluid): BucketPlan {
  if (inventoryNames.includes(`${fluid}_bucket`)) {
    return { ready: false, done: true, message: `Already holding a ${fluid}_bucket.` };
  }
  if (inventoryNames.includes("bucket")) {
    return { ready: true, done: false, message: `Ready to fill a bucket with ${fluid}.` };
  }
  return {
    ready: false,
    done: false,
    message: `No empty bucket. invoke_skill {"skill":"craft_bucket"} first (3 iron ingots).`,
  };
}

/**
 * Depth at which lava is genuinely abundant.
 *
 * The 1.18+ deep lava sea starts around y=-54. strip_mine targets y=16, which
 * is iron depth, not lava depth — which is why every fill_bucket run at y=16
 * still found nothing.
 */
export const LAVA_SEA_Y = -52;

export interface DescentPlan {
  shouldDescend: boolean;
  targetY: number;
}

/**
 * Should this bot dig toward the lava sea before giving up?
 *
 * Measured 2026-08-15: strip_mine reached y=16 thirty-two times and every
 * fill_bucket ran at y=70 or y=68. The bot descended, surfaced, and only later
 * chose fill_bucket. Telling the model to "strip_mine first" assumed it would
 * chain two skills across time and hold position between them; it does neither.
 *
 * Depth is a precondition of this skill, so this skill owns getting there.
 */
export function descentPlan(inventoryNames: string[], y: number): DescentPlan {
  const hasEmptyBucket = inventoryNames.includes("bucket");
  const alreadyFull = inventoryNames.includes("lava_bucket");
  return {
    shouldDescend: hasEmptyBucket && !alreadyFull && y > LAVA_SEA_Y + 6,
    targetY: LAVA_SEA_Y,
  };
}

export const fillBucketSkill: Skill = {
  name: "fill_bucket",
  description:
    'Fill an empty bucket from a nearby lava or water source. params: {"fluid":"lava"} or {"fluid":"water"}. Holding a lava_bucket earns the "Hot Stuff" advancement and is the first step toward the Nether.',
  params: {
    fluid: { type: "string", description: '"lava" or "water" — defaults to lava' },
  },

  estimateMaterials() {
    return { bucket: 1 };
  },

  async execute(bot, params): Promise<SkillResult> {
    const fluid: Fluid = params.fluid === "water" ? "water" : "lava";
    const plan = bucketPlan(
      bot.inventory.items().map((i) => i.name),
      fluid,
    );

    if (plan.done) return { success: true, message: plan.message };
    if (!plan.ready) return { success: false, message: plan.message };

    let result = await fillBucket(bot, fluid);
    let filled = bot.inventory.items().some((i) => i.name === `${fluid}_bucket`);

    // No lava in range is usually a depth problem, not an absence problem. Dig
    // toward the lava sea and look again rather than returning advice the bot
    // will act on from a different place ten minutes later.
    if (!filled && fluid === "lava") {
      const plan = descentPlan(
        bot.inventory.items().map((i) => i.name),
        Math.floor(bot.entity.position.y),
      );
      if (plan.shouldDescend) {
        const dug = await digDownTo(bot, plan.targetY, 140);
        result = `${result} ${dug}`;
        const retry = await fillBucket(bot, fluid);
        filled = bot.inventory.items().some((i) => i.name === `${fluid}_bucket`);
        result = `${result} ${retry}`;
      }
    }

    return { success: filled, message: result };
  },
};
