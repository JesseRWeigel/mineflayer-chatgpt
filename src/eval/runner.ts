import type { Bot } from "mineflayer";
import { skillRegistry } from "../skills/registry.js";
import { runSkill, abortActiveSkill } from "../skills/executor.js";
import { getDynamicSkillNames } from "../skills/dynamic-loader.js";

const SUCCESS_PATTERNS = /complet|harvest|built|planted|smelted|crafted|arriv|gather|mined|caught|lit|bridg|chop|killed|ate|placed|fished|explored/i;
const EVAL_TIMEOUT_MS = 90_000;

export interface EvalResult {
  skill: string;
  passed: boolean;
  message: string;
  durationMs: number;
}

export async function evalSkill(bot: Bot, skillName: string): Promise<EvalResult> {
  const start = Date.now();
  const skill = skillRegistry.get(skillName);
  if (!skill) {
    bot.chat(`[EVAL] FAIL ${skillName}: not in registry`);
    return { skill: skillName, passed: false, message: "Skill not found in registry", durationMs: 0 };
  }

  bot.chat(`[EVAL] Running: ${skillName}...`);
  try {
    let resultMessage = "no result";
    const skillPromise = runSkill(bot, skill, {}).then((r) => { resultMessage = r; });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${EVAL_TIMEOUT_MS / 1000}s`)), EVAL_TIMEOUT_MS)
    );
    await Promise.race([skillPromise, timeoutPromise]);

    const passed = SUCCESS_PATTERNS.test(resultMessage);
    const durationMs = Date.now() - start;
    bot.chat(`[EVAL] ${passed ? "PASS" : "FAIL"} ${skillName} (${(durationMs / 1000).toFixed(1)}s): ${resultMessage.slice(0, 80)}`);
    return { skill: skillName, passed, message: resultMessage, durationMs };
  } catch (err: any) {
    abortActiveSkill(bot); // ensure executor clears activeSkill so next eval can run
    const durationMs = Date.now() - start;
    bot.chat(`[EVAL] FAIL ${skillName} (${(durationMs / 1000).toFixed(1)}s): ${err.message.slice(0, 80)}`);
    return { skill: skillName, passed: false, message: err.message, durationMs };
  }
}

export async function evalAll(bot: Bot, filter?: string): Promise<EvalResult[]> {
  // Only registered skills (gather_wood is an action, not a registered skill)
  const staticNames = [
    "craft_gear", "build_house", "build_farm",
    "strip_mine", "smelt_ores", "go_fishing", "build_bridge", "light_area",
  ];
  const allNames = [...staticNames, ...getDynamicSkillNames()];
  const toRun = filter
    ? allNames.filter((n) => n.toLowerCase().includes(filter.toLowerCase()))
    : allNames;

  bot.chat(`[EVAL] Starting ${toRun.length} skill evals${filter ? ` (filter: "${filter.slice(0, 40)}")` : ""}...`);

  const results: EvalResult[] = [];
  for (const name of toRun) {
    const result = await evalSkill(bot, name);
    results.push(result);
    await new Promise((r) => setTimeout(r, 2000));
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  bot.chat(`[EVAL] Summary: ${passed} passed, ${failed} failed of ${results.length} total`);
  if (failed > 0) {
    const failNames = results.filter((r) => !r.passed).map((r) => r.skill).join(", ");
    bot.chat(`[EVAL] Failed: ${failNames.slice(0, 164)}`);
  }
  return results;
}
