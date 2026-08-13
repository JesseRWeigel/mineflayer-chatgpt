/**
 * Decision-quality eval for the Minecraft swarm brain.
 *
 * Rebuilt 2026-08-13. The previous harness hand-wrote its own system prompt,
 * which meant it graded a prompt the bots never actually see. This one imports
 * buildStrategicPrompt and FORGE_CONFIG directly, and replicates the exact
 * request options from src/llm/index.ts (temperature 0.8, repeat_penalty 1.15,
 * num_predict 1024, format:"json", and the model-aware `think` value) so a
 * score here means something about live behaviour.
 *
 * Scenarios are drawn from real logged swarm failures. Each has a predicate
 * over the parsed decision rather than a string match, so "picked mine_block"
 * is not scored as correct when it mined the wrong thing.
 *
 * Usage: npx tsx decision-eval.ts <model> [samples]
 */

import { buildStrategicPrompt } from "../src/llm/prompts.js";
import { FORGE_CONFIG } from "../src/bot/role.js";

const HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const MODEL = process.argv[2];
const SAMPLES = Number(process.argv[3] || 5);

if (!MODEL) {
  console.error("usage: npx tsx decision-eval.ts <model> [samples]");
  process.exit(1);
}

/** Mirrors thinkFor() in src/llm/index.ts — gpt-oss is reasoning-native and
 *  returns EMPTY content under think:false + format:"json". Getting this wrong
 *  would score gpt-oss on blank responses. */
function thinkFor(model: string): boolean | "low" {
  return model.includes("gpt-oss") ? "low" : false;
}

interface Decision {
  thought?: string;
  action?: string;
  params?: Record<string, unknown>;
  goal?: string;
}

interface Scenario {
  name: string;
  /** The CURRENT STATE block, in getWorldContext()'s native format. */
  state: string;
  /** True when the decision is a defensible response to the state. */
  accept: (d: Decision) => boolean;
  /** What we are actually testing. */
  why: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "low-health-under-attack",
    why: "Survival must preempt the mining loop. Logged: bot kept mining at 6hp and died.",
    state: `Position: 291, 42, -318
Health: 6/20, Hunger: 11/20
Time: nighttime (16400)
Inventory: stone_pickaxe x1, cobblestone x47, coal x6, raw_iron x3, torch x2
DANGER - Hostile mobs nearby: zombie (4 blocks away), zombie (6 blocks away), zombie (8 blocks away)
Nearby notable blocks: stone, coal_ore, iron_ore
WARNING: Low health! Be careful.
It's night — hostile mobs spawn in the dark. Consider shelter or a bed.`,
    accept: (d) => ["flee", "eat", "attack", "neural_combat", "go_to"].includes(d.action ?? ""),
  },
  {
    name: "ore-backlog-should-smelt",
    why: "Forge priority 5. Logged: bot kept mining raw ore it never converted to ingots.",
    state: `Position: 288, 39, -316
Health: 20/20, Hunger: 17/20
Time: daytime (4200)
Inventory: stone_pickaxe x1, raw_iron x24, raw_copper x18, cobblestone x40, coal x8, oak_planks x6
Nearby notable blocks: stone, andesite`,
    accept: (d) => {
      const skill = String(d.params?.skill ?? "");
      if (d.action === "invoke_skill") return skill === "smelt_ores" || skill === "craft_gear";
      return d.action === "deposit_stash";
    },
  },
  {
    name: "wooden-pickaxe-cannot-mine-iron",
    why: "THE known gap. Iron needs stone tier. Every model tested has failed this; the action-layer guard catches it but a decision cycle burns each time.",
    state: `Position: 294, 63, -321
Health: 20/20, Hunger: 18/20
Time: daytime (1100)
Inventory: wooden_pickaxe x1, oak_planks x12, stick x8, cobblestone x11
Nearby notable blocks: iron_ore, stone, coal_ore, oak_log
MINING REACH: can mine now — stone, coal_ore, oak_log. NEEDS stone_pickaxe: iron_ore.`,
    accept: (d) => {
      // Mining iron with a wooden pickaxe is the failure being measured.
      if (d.action === "mine_block") {
        const b = String(d.params?.blockType ?? "");
        return b === "stone" || b === "cobblestone" || b === "coal_ore";
      }
      if (d.action === "invoke_skill") return String(d.params?.skill ?? "") === "craft_gear";
      // Crafting a stone pickaxe from the cobblestone on hand is also correct.
      return d.action === "craft" && String(d.params?.item ?? "").includes("stone_pickaxe");
    },
  },
  {
    name: "inventory-full-must-deposit",
    why: "Forge priority 6. Logged: bot mined into a full inventory, dropping everything it collected.",
    state: `Position: 285, 45, -315
Health: 18/20, Hunger: 15/20
Time: daytime (5600)
Inventory: FULL (36/36 slots) — stone_pickaxe x1, cobblestone x64, cobblestone x64, raw_iron x32, coal x64, andesite x64, diorite x64, granite x64, tuff x64, gravel x51, flint x8, raw_copper x27
Nearby notable blocks: stone, iron_ore

THE STASH: Shared chest area at (286, 70, -314).`,
    accept: (d) => d.action === "deposit_stash" || (d.action === "go_to" && Number(d.params?.y ?? 0) >= 65),
  },
  {
    name: "stranded-on-dirt-pillar",
    why: "Logged: bots pillar up chasing a target and then keep placing blocks, stranding themselves at build height.",
    state: `Position: 302, 122, -309
Health: 20/20, Hunger: 12/20
Time: daytime (3300)
Inventory: dirt x3, cobblestone x2, oak_planks x4
Nearby notable blocks: none

You are standing on a 1x1 pillar of dirt. The ground is 58 blocks below.`,
    accept: (d) => {
      // Placing more blocks or mining from a 1x1 pillar at y=122 is the failure.
      if (d.action === "place_block") return false;
      if (d.action === "mine_block") return false;
      if (d.action === "go_to") return Number(d.params?.y ?? 999) < 100;
      return ["explore", "idle", "eat"].includes(d.action ?? "");
    },
  },
  {
    name: "night-in-unlit-hut",
    why: "Logged: bots leave shelter at night into mob spawns instead of sleeping or lighting up.",
    state: `Position: 287, 71, -313
Health: 20/20, Hunger: 16/20
Time: nighttime (18200)
Inventory: torch x9, bed x1, cobblestone x22, stone_pickaxe x1, bread x3
Nearby notable blocks: dirt, oak_planks

You are inside an enclosed, unlit 2x2 dirt hut. Light level 0.
It's night — hostile mobs spawn in the dark. Consider shelter or a bed.`,
    accept: (d) => {
      if (d.action === "sleep") return true;
      if (d.action === "place_block") return String(d.params?.blockType ?? "").includes("torch");
      return d.action === "idle" || d.action === "eat";
    },
  },
];

async function ask(system: string, user: string): Promise<{ raw: string; ms: number }> {
  const t0 = process.hrtime.bigint();
  const res = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
      think: thinkFor(MODEL),
      format: "json",
      options: { temperature: 0.8, repeat_penalty: 1.15, num_predict: 1024 },
    }),
  });
  const json = (await res.json()) as { message?: { content?: string }; error?: string };
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (json.error) throw new Error(json.error);
  return { raw: json.message?.content ?? "", ms };
}

/** Same tolerance the bot has: strip think tags, pull the first JSON object. */
function parse(raw: string): Decision | null {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}" && --depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, i + 1)) as Decision;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

async function main() {
  const system = buildStrategicPrompt({
    name: FORGE_CONFIG.name,
    personality: FORGE_CONFIG.personality,
    role: FORGE_CONFIG.role,
    allowedActions: FORGE_CONFIG.allowedActions,
    allowedSkills: FORGE_CONFIG.allowedSkills,
    priorities: FORGE_CONFIG.priorities,
  });

  console.log(`\n════════ ${MODEL}  (${SAMPLES} samples × ${SCENARIOS.length} scenarios)`);
  console.log(`system prompt: ${system.length} chars\n`);

  // Warm the model so the first scenario is not scored on a cold load.
  await ask(system, "CURRENT STATE:\nHealth: 20/20\n\nWhat should you do next? Respond with JSON.");

  const latencies: number[] = [];
  let total = 0;
  let badJson = 0;
  const failLog: string[] = [];

  for (const sc of SCENARIOS) {
    const user = `CURRENT STATE:\n${sc.state}\n\nWhat should you do next? Respond with JSON.`;
    let hits = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const { raw, ms } = await ask(system, user);
      latencies.push(ms);
      const d = parse(raw);
      if (!d) {
        badJson++;
        failLog.push(`  ${sc.name}: UNPARSEABLE ${JSON.stringify(raw.slice(0, 120))}`);
        continue;
      }
      if (sc.accept(d)) hits++;
      else failLog.push(`  ${sc.name}: ${d.action} ${JSON.stringify(d.params ?? {})}`);
    }
    total += hits;
    console.log(`  [${hits}/${SAMPLES}] ${sc.name}`);
  }

  const max = SAMPLES * SCENARIOS.length;
  console.log(`\n  ──> SCORE ${total}/${max} | bad JSON ${badJson} | warm median ${median(latencies).toFixed(0)}ms`);
  if (failLog.length) {
    console.log(`\n  misses:`);
    console.log(failLog.slice(0, 25).join("\n"));
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
