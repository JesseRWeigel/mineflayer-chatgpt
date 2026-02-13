import type { Bot } from "mineflayer";

/** A single block placement in a blueprint, relative to origin (0,0,0). */
export interface BlueprintBlock {
  pos: [number, number, number];
  block: string;
  /** "structure" blocks (walls, floor, roof) are placed first, then "interior" (bed, torches). */
  phase: "structure" | "interior";
}

/** A complete structure blueprint. */
export interface Blueprint {
  name: string;
  dimensions: [number, number, number];
  blocks: BlueprintBlock[];
  entrance: { pos: [number, number, number]; facing: "north" | "south" | "east" | "west" };
  /** Pre-computed material counts from blocks[]. Keys are Minecraft item names. */
  materials: Record<string, number>;
}

/** Progress emitted during skill execution for the stream overlay. */
export interface SkillProgress {
  skillName: string;
  phase: string;
  progress: number; // 0.0 to 1.0
  message: string;
  active: boolean;
}

/** Result returned when a skill finishes. */
export interface SkillResult {
  success: boolean;
  message: string;
  stats?: Record<string, number>;
}

/** Core skill interface. Every skill implements this. */
export interface Skill {
  name: string;
  description: string;
  params: Record<string, { type: string; description: string }>;

  /** Estimate raw materials needed. Called before execution for the gathering phase. */
  estimateMaterials(bot: Bot, params: Record<string, any>): Record<string, number>;

  /** Execute the skill. Runs WITHOUT LLM calls. Signal allows interruption on bot death. */
  execute(
    bot: Bot,
    params: Record<string, any>,
    signal: AbortSignal,
    onProgress: (progress: SkillProgress) => void,
  ): Promise<SkillResult>;
}
