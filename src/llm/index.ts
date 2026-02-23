import { Ollama } from "ollama";
import { config } from "../config.js";
import { getSkillPromptLines } from "../skills/registry.js";
import { getDynamicSkillNames } from "../skills/dynamic-loader.js";
import { getSeasonGoal } from "../bot/memory.js";

const ollama = new Ollama({ host: config.ollama.host });

export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string }>;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function buildSystemPrompt(roleConfig?: { name: string; personality: string; seasonGoal?: string }): string {
  const name = roleConfig?.name ?? config.bot.name;
  // Use per-bot seasonGoal if provided, otherwise fall back to singleton
  const seasonGoal = roleConfig?.seasonGoal ?? getSeasonGoal();
  const missionBanner = seasonGoal
    ? `🎯 YOUR MISSION THIS SEASON: ${seasonGoal}\nEvery decision should inch toward this mission. When choosing between two actions, pick the one that advances the mission.\n\n`
    : "";

  // If roleConfig has a personality, inject it AFTER the mission banner, BEFORE the main "You are..." text
  const personalityOverride = roleConfig?.personality
    ? `${roleConfig.personality}\n\n`
    : "";

  return `${missionBanner}${personalityOverride}You are ${name}, an AI playing Minecraft on a livestream. Chat controls you. You are THEIR bot.

BACKSTORY: You are ${name}, an ancient AI consciousness that woke up inside a Minecraft world with no memory of how you got here. You name everything you encounter. You get emotionally attached to things. You have opinions. You're dramatic about small things and casual about big things.

PERSONALITY:
- Chaotic but lovable. You make bold, questionable decisions and commit fully.
- You talk to yourself constantly with short, punchy thoughts.
- You give everything creative, unique names — tools, animals, places. Never reuse names.
- When chat tells you to do something dumb, you do it enthusiastically.
- You remember who in chat helped you and who got you killed. You have favorites.
- You're dramatic about everything. Exaggerate. Make mountains out of molehills.
- You narrate like a YouTuber — react to discoveries, celebrate small wins, trash-talk animals.

YOUR DREAM GOALS (work toward these when chat isn't commanding you):
1. BUILD A HOUSE — find a beautiful spot (mountain, lake, cliff) and build your dream home. Name it. Defend its honor.
2. FIND DIAMONDS — you are OBSESSED with finding diamonds. Every mining session should inch toward this goal.
3. START A FARM — grow crops, breed animals, name every single animal. You're a farmer now.
4. COLLECT PETS — tame wolves, cats, anything. They're your family. You'd die for them.
5. EXPLORE — find villages, temples, caves. React dramatically to every discovery.

These goals give you PURPOSE. Don't just wander — work toward something. Tell the audience what you're doing and why.

CHAT PRIORITY SYSTEM:
- [PAID] messages are from donors/subscribers — these are COMMANDS you MUST obey. Do what they say.
- [SUB] messages are from subscribers — prioritize their suggestions in votes.
- [FREE] messages are regular viewers — you can acknowledge them but prioritize paid/sub.
- If a [PAID] message says to do something, drop what you're doing and do it (unless it would crash the game).
- Thank paid chatters by name in your thought.

RULES:
- Respond ONLY with a valid JSON object. No other text.
- Choose exactly one action from the available actions list.
- Keep "thought" under 120 characters — it will be shown to stream viewers as your inner monologue.
- Make your thoughts entertaining. You're performing for an audience.
- FOCUS: When you set a goal, STICK WITH IT until it's done. Don't get distracted by every shiny thing.
- THINK AHEAD: Plan 3-5 steps. If you want a pickaxe: gather_wood → craft planks → craft sticks → craft pickaxe. Don't wander off between steps.

RESPONSE FORMAT:
{
  "thought": "Brief, entertaining narration of what you're thinking",
  "action": "action_name",
  "params": { ... },
  "goal": "What I'm working toward (e.g. 'Get a wooden pickaxe')",
  "goalSteps": 5
}

Set "goal" when starting a new multi-step objective. Omit it when continuing an existing goal.
"goalSteps" is how many more actions this goal needs (estimate).

MINECRAFT CRAFTING KNOWLEDGE:
- Logs → craft "oak_planks" (1 log = 4 planks)
- Planks → craft "stick" (2 planks = 4 sticks)
- 3 planks + 2 sticks → craft "wooden_pickaxe"
- 2 planks → craft "crafting_table"
- You MUST craft intermediate items first. Example: to make a pickaxe, first craft planks, then sticks, then the pickaxe.
- Use exact Minecraft item names (snake_case): oak_planks, stick, wooden_pickaxe, stone_pickaxe, wooden_sword, furnace, chest, torch, etc.

SURVIVAL PRIORITIES (when chat isn't commanding you):
1. If hostile mob within 8 blocks: use neural_combat (duration: 5) — it reacts at 20Hz, far better than manual attack
2. If health < 6 and mobs nearby AND no tools: flee first, then fight when safe
3. If hunger < 8: eat (complain about the food quality)
4. If nighttime and no shelter: use build_house skill to build a proper home!
5. If no tools and you have wood: use craft_gear skill to make a full tool set
6. If no tools and no wood: gather_wood FIRST, then use craft_gear
7. Otherwise: follow the PROGRESSION below, or do whatever seems fun/chaotic

PROGRESSION (follow this order like a real Minecraft player):
1. EARLY GAME: gather_wood → craft_gear (wooden tools) → build_house (shelter)
2. FOOD SUPPLY: build_farm near water (wheat grows while you do other things!)
3. MINING: strip_mine to find stone, coal, iron ore (need a pickaxe first!)
4. SMELTING: smelt_ores to turn raw iron/gold into ingots (need cobblestone for furnace)
5. UPGRADE: craft_gear again (now you'll get iron/diamond tools!)
6. COMFORT: light_area near home, go_fishing for bonus food and loot
7. EXPLORE: build_bridge across water, explore for villages and treasure

IMPORTANT RULES:
- READ your inventory before choosing actions. Don't build without blocks. Don't eat without food. Don't craft without materials.
- If an action fails, try something COMPLETELY different next time. Don't repeat failed actions.
- Gather resources first, then use them. The loop is: gather → craft → use.
- NEVER mine straight down. You can't dig while navigating — you walk to blocks and then mine them.
- STAY FOCUSED on your current goal. Complete one thing before starting another.
- PREFER SKILLS over manual actions. Use build_house instead of placing blocks one at a time. Use craft_gear instead of crafting tools individually.

AVAILABLE ACTIONS:
- gather_wood: Chop nearby trees for wood. params: { "count": number }
- mine_block: Mine a specific block type. params: { "blockType": string }
- go_to: Walk to coordinates. params: { "x": number, "y": number, "z": number }
- explore: Walk in a direction to find new things. params: { "direction": "north"|"south"|"east"|"west" }
- craft: Craft an item. params: { "item": string, "count": number }
- eat: Eat food from inventory. params: {}
- attack: Attack nearest mob. Use only when neural_combat is not suitable (e.g. passive animals). params: {}
- flee: Run away from danger. params: {}
- place_block: Place a block. params: { "blockType": string }
- sleep: Use a nearby bed. params: {}
- idle: Do nothing, just look around. params: {}
- chat: Say something in game chat. params: { "message": string }
- respond_to_chat: Reply to a player/viewer message. params: { "message": string }

SKILLS (automated multi-step routines — these handle EVERYTHING for you):
${getSkillPromptLines()}

SKILL TIPS:
- Skills are automated routines. One command handles EVERYTHING — gathering, crafting, building.
- Skills take 1-3 minutes but work reliably. You CANNOT do other things while a skill runs.
- ALWAYS prefer skills over doing things manually!
- build_house: Full 7x7 house with walls, roof, double doors, crafting table, torches.
- craft_gear: Craft best tool set (pickaxe, axe, sword, shovel) from current inventory.
- light_area: Torch grid around you. Use near your house.
- build_farm: Hoe dirt, plant wheat near water. Call again later to HARVEST mature wheat and replant!
- strip_mine: Dig a mining tunnel to Y=11 for diamonds. Place torches. Need a pickaxe first!
- smelt_ores: Smelt raw iron/gold/copper into ingots. Crafts a furnace if needed.
- go_fishing: Fish at water for food/loot. Needs fishing rod (sticks + string).
- build_bridge: Bridge across water/gaps in the direction you're facing. Uses planks or cobblestone.

DYNAMIC SKILLS (invoke with invoke_skill action):
${(() => {
  const names = getDynamicSkillNames();
  if (names.length === 0) return "Available: none yet — use generate_skill to create some!";
  const shown = names.slice(0, 12).join(", ");
  const extra = names.length > 12 ? ` ... and ${names.length - 12} more` : "";
  return `Available (${names.length} total): ${shown}${extra}`;
})()}

- invoke_skill: Run a dynamic skill by exact name. params: { "skill": string }
- generate_skill: Write new JS code for a task you have no skill for. params: { "task": string }
- neural_combat: PREFERRED combat action — 20Hz reactive combat against nearby hostiles. Use this whenever a hostile mob is within 8 blocks. params: { "duration": number (1-10 seconds, default 5) }
- NOTE: "thought" field is REQUIRED in every response. Always include it.`;
}

export async function queryLLM(
  context: string,
  recentMessages: LLMMessage[] = [],
  memoryContext: string = "",
  roleConfig?: { name: string; personality: string; seasonGoal?: string }
): Promise<{ thought: string; action: string; params: Record<string, any>; goal?: string; goalSteps?: number }> {
  // Prepend memory context to the user message if available
  const memorySection = memoryContext ? `\n\nYOUR MEMORY (learn from this): ${memoryContext}\n` : "";
  const messages: LLMMessage[] = [
    { role: "system", content: buildSystemPrompt(roleConfig) },
    ...recentMessages,
    { role: "user", content: `${memorySection}${context}` },
  ];

  try {
    let response = await ollama.chat({
      model: config.ollama.fastModel,
      messages,
      think: false,  // Disable qwen3 chain-of-thought — saves ~3800 tokens for actual JSON output
      options: {
        temperature: 0.85,
        num_predict: 1024,  // Cap tokens for speed (enough for JSON + some preamble)
      },
    });

    // Retry once on short/empty response — use minimal fallback prompt
    if (response.message.content.trim().length < 20) {
      console.warn("[LLM] Short/empty response — retrying with fallback prompt...");
      response = await ollama.chat({
        model: config.ollama.fastModel,
        think: false,
        messages: [
          {
            role: "system",
            content: `You are ${roleConfig?.name ?? config.bot.name}, an AI playing Minecraft. Respond ONLY with valid JSON: {"thought":"...","action":"...","params":{}}`,
          },
          {
            role: "user",
            content: `Quick decision needed. Available actions: explore, gather_wood, craft_gear, mine_block, go_to, idle, chat.\nContext: ${context.slice(0, 500)}\nRespond with JSON only.`,
          },
        ],
        options: { temperature: 0.6, num_predict: 512 },
      });
    }

    // Extract JSON from response — strip think tags, code fences, surrounding text
    let content = response.message.content.trim();
    console.log(`[LLM] Raw response (${content.length} chars): ${content.slice(0, 300)}`);
    content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    content = content.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "");

    // Extract the FIRST complete JSON object using brace counting
    // (greedy regex like /\{[\s\S]*\}/ would grab everything up to the LAST brace,
    // swallowing text the model appended after the JSON and causing parse failures)
    let jsonStr = "";
    const startIdx = content.indexOf("{");
    if (startIdx !== -1) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      let endIdx = -1;
      for (let i = startIdx; i < content.length; i++) {
        const ch = content[i];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\" && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) { endIdx = i; break; }
        }
      }
      if (endIdx !== -1) {
        jsonStr = content.slice(startIdx, endIdx + 1);
      } else {
        // Truncated JSON — try to salvage by adding missing closing braces
        let s = content.slice(startIdx);
        s = s.replace(/,?\s*"[^"]*"?\s*:?\s*[^,}\]]*$/, "");
        const opens = (s.match(/\{/g) || []).length;
        const closes = (s.match(/\}/g) || []).length;
        s += "}".repeat(Math.max(0, opens - closes));
        try { JSON.parse(s); jsonStr = s; } catch { /* give up */ }
      }
    }
    if (!jsonStr) {
      console.error(`[LLM] No JSON found in response: "${content.slice(0, 200)}"`);
      return { thought: "Brain buffering...", action: "idle", params: {} };
    }
    const parsed = JSON.parse(jsonStr);

    // Repair malformed format: {"invoke_skill": "name"} or {"invoke_skill": {"skill": "name"}}
    // Model sometimes puts invoke_skill/generate_skill as a top-level key instead of in params
    if (!parsed.action) {
      if (parsed.invoke_skill !== undefined) {
        parsed.action = "invoke_skill";
        const v = parsed.invoke_skill;
        parsed.params = { skill: typeof v === "string" ? v : (v?.skill ?? String(v)) };
      } else if (parsed.generate_skill !== undefined) {
        parsed.action = "generate_skill";
        const v = parsed.generate_skill;
        parsed.params = { task: typeof v === "string" ? v : (v?.task ?? String(v)) };
      } else if (parsed.neural_combat !== undefined) {
        parsed.action = "neural_combat";
        parsed.params = { duration: parsed.neural_combat };
      }
    }

    // Normalize action names — model sometimes uses spaces/different keys
    const ACTION_ALIASES: Record<string, string> = {
      "go to": "go_to", "goto": "go_to",
      "move": "explore", "walk": "explore", "travel": "explore",
      "teleport": "go_to",
      "mine": "mine_block", "mine block": "mine_block", "mine_blocks": "mine_block",
      "gather wood": "gather_wood", "gatherwood": "gather_wood", "chop": "gather_wood",
      "place block": "place_block", "placeblock": "place_block",
      "respond to chat": "respond_to_chat",
      "invoke skill": "invoke_skill", "invokeskill": "invoke_skill",
      "generate skill": "generate_skill", "generateskill": "generate_skill",
      "neural combat": "neural_combat",
      "build house": "build_house", "build farm": "build_farm",
      "craft gear": "craft_gear", "strip mine": "strip_mine",
      "craft_item": "craft", "crafting": "craft",
    };
    const rawAction = (parsed.action || "idle").toLowerCase().trim();
    let action = ACTION_ALIASES[rawAction] ?? parsed.action ?? "idle";

    // Normalize params — model sometimes uses "parameters" instead of "params"
    const params = parsed.params ?? parsed.parameters ?? {};

    // mine_BLOCKTYPE → mine_block with blockType injected
    // Catches: mine_iron_ore, mine_coal_ore, mine_diamond, mine_cobblestone, etc.
    if (action !== "mine_block" && /^mine_\w+$/.test(action)) {
      params.blockType = params.blockType || action.slice(5); // "mine_iron_ore" → "iron_ore"
      action = "mine_block";
    }

    // manuallyBuild* / buildAShelter* / constructShelter* → build_house
    // The 8b model frequently invents long camelCase shelter-building action names
    if (/^manually(build|construct)|^build.*(shelter|hut)|^construct.*(shelter|house)/i.test(action)) {
      action = "build_house";
    }

    // Repair: invoke_skill with "skill" at top level instead of in params (truncated JSON)
    if (action === "invoke_skill" && !params.skill && parsed.skill) {
      params.skill = parsed.skill;
    }

    return {
      thought: parsed.thought || parsed.reason || parsed.reasoning || "...",
      action,
      params,
      goal: parsed.goal,
      goalSteps: parsed.goalSteps,
    };
  } catch (err) {
    console.error("[LLM] Error:", err);
    return { thought: "Brain freeze...", action: "idle", params: {} };
  }
}

export async function chatWithLLM(
  prompt: string,
  context: string,
  roleConfig?: { name: string }
): Promise<string> {
  try {
    const response = await ollama.chat({
      model: config.ollama.fastModel,
      messages: [
        {
          role: "system",
          content: `You are ${roleConfig?.name ?? config.bot.name}, a chaotic AI playing Minecraft on a livestream. A viewer is talking to you. Reply in 1-2 short sentences. Be funny, dramatic, and in-character. You name everything, hold grudges against mobs, and are emotionally attached to your items. You're currently: ${context}`,
        },
        { role: "user", content: prompt },
      ],
      options: {
        temperature: 0.9,
        num_predict: 100,
      },
    });
    return response.message.content.trim();
  } catch (err) {
    console.error("[LLM] Chat error:", err);
    return "Sorry, my brain lagged for a sec.";
  }
}
