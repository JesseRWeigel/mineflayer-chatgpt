import type { Bot } from "mineflayer";
import type { Skill, SkillProgress, SkillResult } from "./types.js";
import { gatherMaterials } from "./materials.js";
import { updateOverlay } from "../stream/overlay.js";
import { recordSkillAttempt } from "../bot/memory.js";
let activeSkill: {
  skill: Skill;
  abortController: AbortController;
  promise: Promise<SkillResult>;
  startTime: number;
} | null = null;

export function isSkillRunning(): boolean {
  return activeSkill !== null;
}

export function getActiveSkillName(): string | null {
  return activeSkill?.skill.name ?? null;
}

export function abortActiveSkill(): void {
  if (activeSkill) {
    console.log(`[Skill] Aborting skill "${activeSkill.skill.name}"`);
    activeSkill.abortController.abort();
  }
}

/**
 * Run a skill to completion: gather materials → execute → return result string.
 * Called from executeAction() when the LLM picks a skill action.
 */
export async function runSkill(
  bot: Bot,
  skill: Skill,
  params: Record<string, any>,
): Promise<string> {
  if (activeSkill) {
    return `Already running skill "${activeSkill.skill.name}". Wait for it to finish.`;
  }

  const abortController = new AbortController();
  const { signal } = abortController;
  const startTime = Date.now();

  console.log(`[Skill] Starting "${skill.name}"`);

  const progress = (p: SkillProgress) => {
    updateOverlay({ skillProgress: p });
    if (p.message) {
      console.log(`[Skill] ${skill.name}: ${p.phase} — ${p.message} (${Math.round(p.progress * 100)}%)`);
    }
  };

  // Phase 1: Gather materials
  progress({
    skillName: skill.name,
    phase: "Checking materials",
    progress: 0,
    message: "Scanning inventory...",
    active: true,
  });

  const materialsNeeded = skill.estimateMaterials(bot, params);
  const materialsList = Object.entries(materialsNeeded);

  if (materialsList.length > 0) {
    const summary = materialsList.map(([k, v]) => `${v}x ${k}`).join(", ");
    console.log(`[Skill] Materials needed: ${summary}`);

    try {
      const gatherResult = await gatherMaterials(
        bot,
        materialsNeeded,
        signal,
        (msg, pct) => {
          progress({
            skillName: skill.name,
            phase: "Gathering materials",
            progress: pct * 0.3,
            message: msg,
            active: true,
          });
        },
      );

      if (!gatherResult.success) {
        progress({ skillName: skill.name, phase: "Failed", progress: 0, message: gatherResult.message, active: false });
        return `Skill ${skill.name} failed: ${gatherResult.message}`;
      }
    } catch (err: any) {
      progress({ skillName: skill.name, phase: "Failed", progress: 0, message: err.message, active: false });
      return `Skill ${skill.name} crashed during gathering: ${err.message}`;
    }
  }

  if (signal.aborted) {
    progress({ skillName: skill.name, phase: "Aborted", progress: 0, message: "Interrupted!", active: false });
    return `Skill ${skill.name} was interrupted.`;
  }

  // Phase 2: Execute the skill
  const skillPromise = skill.execute(bot, params, signal, (p) => {
    progress({
      ...p,
      progress: 0.3 + p.progress * 0.7, // Remap: gathering = 0-30%, execution = 30-100%
    });
  });

  activeSkill = { skill, abortController, promise: skillPromise, startTime };

  try {
    const result = await skillPromise;
    const durationSeconds = (Date.now() - startTime) / 1000;

    // Record skill attempt in memory
    recordSkillAttempt(skill.name, result.success, durationSeconds, result.message);

    progress({
      skillName: skill.name,
      phase: result.success ? "Complete!" : "Failed",
      progress: result.success ? 1.0 : 0,
      message: result.message,
      active: false,
    });

    console.log(`[Skill] "${skill.name}" finished: ${result.message}`);
    return result.message;
  } catch (err: any) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    recordSkillAttempt(skill.name, false, durationSeconds, `Crashed: ${err.message}`);

    progress({ skillName: skill.name, phase: "Crashed", progress: 0, message: err.message, active: false });
    return `Skill ${skill.name} crashed: ${err.message}`;
  } finally {
    activeSkill = null;
  }
}
