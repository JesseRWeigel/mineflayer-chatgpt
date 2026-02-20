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

Rules:
- Write ONE async function named exactly SKILL_NAME that takes a single bot parameter
- Use only Mineflayer API: bot.findBlock, bot.dig, bot.equip, bot.craft, bot.chat, bot.pathfinder, bot.pvp, bot.inventory
- For Vec3: const { Vec3 } = require('vec3');
- For navigation: const goals = require('mineflayer-pathfinder').goals; bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
- Handle errors with try/catch
- Works with no arguments other than bot
- Return nothing (void), under 80 lines

TASK: TASK_DESCRIPTION

Write ONLY the JavaScript function. No markdown, no explanation, no backticks.`;

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
