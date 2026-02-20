import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ollama } from "ollama";
import { config } from "../config.js";
import { loadDynamicSkills } from "./dynamic-loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.resolve(__dirname, "../../skills/generated");

const ollama = new Ollama({ host: config.ollama.host });

const GENERATION_PROMPT = `You are writing a Mineflayer bot skill in JavaScript.

RULES:
- Write ONE async function named exactly SKILL_NAME that takes a single bot parameter
- Works with no arguments other than bot. Return nothing (void). Under 60 lines.
- DO NOT use try/catch — let errors throw so the caller can detect failures
- NO markdown, NO backticks, NO explanation — ONLY the JavaScript function

NAVIGATION (REQUIRED):
  const { goals } = require('mineflayer-pathfinder');
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
  NEVER use bot.pathfinder.setGoal or bot.pathfinder.waitForGoal — those APIs do not exist

INVENTORY API — CRITICAL:
  bot.inventory.items()                              // items() is a FUNCTION, always call with ()
  bot.inventory.items().find(i => i.name === 'x')   // correct
  bot.inventory.items().filter(i => ...)             // correct
  bot.inventory.items.find(...)                      // WRONG — crashes with "is not a function"

CRAFTING API — CRITICAL:
  const mcData = require('minecraft-data')(bot.version);
  const item = mcData.itemsByName['wooden_pickaxe'];
  const table = bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 16 });
  const recipes = bot.recipesFor(item.id, null, 1, table);
  if (recipes.length) await bot.craft(recipes[0], 1, table);
  // NEVER call bot.craft('item_name') — first arg must be a recipe object, not a string

EQUIP:
  const item = bot.inventory.items().find(i => i.name === 'wooden_pickaxe');
  if (item) await bot.equip(item, 'hand');  // always null-check before equip

AVAILABLE GLOBALS: bot, Vec3 (from require('vec3')), mcData (pre-loaded with bot.version), require, console, Math, JSON, setTimeout

TASK: TASK_DESCRIPTION

Write ONLY the JavaScript function:`;

export async function saveGeneratedSkill(name: string, code: string): Promise<string> {
  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(path.join(GENERATED_DIR, `${name}.js`), code, "utf-8");
  console.log(`[Generator] Saved skill '${name}'`);
  return name;
}

export async function generateSkill(task: string): Promise<string> {
  const trimmedTask = task.trim();
  if (!trimmedTask) {
    throw new Error("Task description cannot be empty");
  }

  const skillName = trimmedTask
    .toLowerCase().replace(/[^a-z0-9 ]/g, "").trim()
    .split(/\s+/)
    .map((w, i) => i === 0 ? w : w[0].toUpperCase() + w.slice(1))
    .join("").slice(0, 40);

  if (!skillName) {
    throw new Error("Task description produced an empty skill name (try using letters/numbers)");
  }

  console.log(`[Generator] Writing '${skillName}' for: ${trimmedTask}`);

  const prompt = GENERATION_PROMPT
    .replace("SKILL_NAME", skillName)
    .replace("TASK_DESCRIPTION", trimmedTask);

  const response = await ollama.chat({
    model: config.ollama.model,
    messages: [{ role: "user", content: prompt }],
    options: { temperature: 0.3, num_predict: 1024 },
  });

  let code = response.message.content.trim()
    .replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();

  if (!code.includes(`async function ${skillName}`)) {
    code = `async function ${skillName}(bot) {\n  bot.chat("I tried ${skillName} but the code didn't generate cleanly!");\n}`;
  }

  await saveGeneratedSkill(skillName, code);
  loadDynamicSkills();
  return skillName;
}
