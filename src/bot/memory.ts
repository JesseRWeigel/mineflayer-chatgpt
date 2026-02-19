import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(__dirname, "../../memory.json");

export interface Structure {
  type: "house" | "farm" | "mine" | "furnace" | "other";
  x: number;
  y: number;
  z: number;
  builtAt: string;
  notes?: string;
}

export interface Death {
  location: string;
  x: number;
  y: number;
  z: number;
  cause: string;
  timestamp: string;
}

export interface OreDiscovery {
  type: string;
  x: number;
  y: number;
  z: number;
  timestamp: string;
}

export interface SkillAttempt {
  skill: string;
  success: boolean;
  durationSeconds: number;
  notes: string;
  timestamp: string;
}

export interface BotMemory {
  structures: Structure[];
  deaths: Death[];
  oreDiscoveries: OreDiscovery[];
  skillHistory: SkillAttempt[];
  lessons: string[];
  lastUpdated: string;
}

// Default empty memory
const defaultMemory: BotMemory = {
  structures: [],
  deaths: [],
  oreDiscoveries: [],
  skillHistory: [],
  lessons: [],
  lastUpdated: new Date().toISOString(),
};

let memory: BotMemory = { ...defaultMemory };

// Load memory from file
export function loadMemory(): BotMemory {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const data = fs.readFileSync(MEMORY_FILE, "utf-8");
      memory = JSON.parse(data);
      console.log(`[Memory] Loaded ${memory.structures.length} structures, ${memory.skillHistory.length} skill attempts`);
    }
  } catch (err) {
    console.error("[Memory] Failed to load:", err);
    memory = { ...defaultMemory };
  }
  return memory;
}

// Save memory to file
function saveMemory() {
  try {
    memory.lastUpdated = new Date().toISOString();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (err) {
    console.error("[Memory] Failed to save:", err);
  }
}

// Add a structure to memory
export function addStructure(type: Structure["type"], x: number, y: number, z: number, notes?: string) {
  // Check if structure already exists nearby (within 10 blocks)
  const existing = memory.structures.find(
    (s) => s.type === type && Math.abs(s.x - x) < 10 && Math.abs(s.z - z) < 10
  );

  if (existing) {
    console.log(`[Memory] Structure already exists nearby at ${existing.x}, ${existing.y}, ${existing.z}`);
    return false;
  }

  memory.structures.push({
    type,
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z),
    builtAt: new Date().toISOString(),
    notes,
  });
  console.log(`[Memory] Added ${type} at ${x}, ${y}, ${z}. Total: ${memory.structures.length}`);
  saveMemory();
  return true;
}

// Check if a structure exists nearby
export function hasStructureNearby(type: Structure["type"], x: number, y: number, z: number, radius = 50): boolean {
  return memory.structures.some(
    (s) => s.type === type &&
      Math.abs(s.x - x) <= radius &&
      Math.abs(s.z - z) <= radius
  );
}

// Get nearest structure of a type
export function getNearestStructure(type: Structure["type"], x: number, z: number): Structure | null {
  let nearest: Structure | null = null;
  let minDist = Infinity;

  for (const s of memory.structures) {
    if (s.type === type) {
      const dist = Math.sqrt((s.x - x) ** 2 + (s.z - z) ** 2);
      if (dist < minDist) {
        minDist = dist;
        nearest = s;
      }
    }
  }

  return nearest;
}

// Record a death
export function recordDeath(x: number, y: number, z: number, cause: string) {
  memory.deaths.push({
    location: `${x}, ${y}, ${z}`,
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z),
    cause,
    timestamp: new Date().toISOString(),
  });
  // Keep last 50 deaths
  if (memory.deaths.length > 50) {
    memory.deaths = memory.deaths.slice(-50);
  }
  console.log(`[Memory] Recorded death at ${x}, ${y}, ${z} (cause: ${cause})`);
  saveMemory();
}

// Record ore discovery
export function recordOre(oreType: string, x: number, y: number, z: number) {
  // Check if already discovered nearby
  const existing = memory.oreDiscoveries.find(
    (o) => o.type === oreType && Math.abs(o.x - x) < 5 && Math.abs(o.z - z) < 5
  );
  if (existing) return;

  memory.oreDiscoveries.push({
    type: oreType,
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z),
    timestamp: new Date().toISOString(),
  });
  console.log(`[Memory] Discovered ${oreType} at ${x}, ${y}, ${z}`);
  saveMemory();
}

// Record skill attempt
export function recordSkillAttempt(skill: string, success: boolean, durationSeconds: number, notes: string) {
  memory.skillHistory.push({
    skill,
    success,
    durationSeconds,
    notes,
    timestamp: new Date().toISOString(),
  });
  // Keep last 100 attempts
  if (memory.skillHistory.length > 100) {
    memory.skillHistory = memory.skillHistory.slice(-100);
  }

  // Update success rate tracking
  const skillAttempts = memory.skillHistory.filter((s) => s.skill === skill);
  const successCount = skillAttempts.filter((s) => s.success).length;
  const successRate = skillAttempts.length > 0 ? (successCount / skillAttempts.length) * 100 : 0;

  console.log(`[Memory] ${skill}: ${success ? "SUCCESS" : "FAIL"} (${successRate.toFixed(0)}% success rate over ${skillAttempts.length} attempts)`);
  saveMemory();
}

// Get skill success rate for a skill
export function getSkillSuccessRate(skill: string): { successRate: number; totalAttempts: number; avgDuration: number } {
  const attempts = memory.skillHistory.filter((s) => s.skill === skill);
  if (attempts.length === 0) {
    return { successRate: -1, totalAttempts: 0, avgDuration: 0 };
  }

  const successes = attempts.filter((a) => a.success).length;
  const avgDuration = attempts.reduce((sum, a) => sum + a.durationSeconds, 0) / attempts.length;

  return {
    successRate: (successes / attempts.length) * 100,
    totalAttempts: attempts.length,
    avgDuration,
  };
}

// Add a lesson
export function addLesson(lesson: string) {
  memory.lessons.push(lesson);
  // Keep last 20 lessons
  if (memory.lessons.length > 20) {
    memory.lessons = memory.lessons.slice(-20);
  }
  saveMemory();
}

// Generate memory context for LLM
export function getMemoryContext(): string {
  const parts: string[] = [];

  // Structures
  if (memory.structures.length > 0) {
    const houses = memory.structures.filter((s) => s.type === "house");
    if (houses.length > 0) {
      parts.push(`HOUSES BUILT: ${houses.length} - at coordinates: ${houses.map((h) => `(${h.x}, ${h.z})`).join(", ")}`);
    }
  }

  // Deaths
  if (memory.deaths.length > 0) {
    const recentDeaths = memory.deaths.slice(-5);
    parts.push(`RECENT DEATHS: ${recentDeaths.map((d) => `${d.cause} at (${d.x}, ${d.y}, ${d.z})`).join("; ")}`);
  }

  // Ores
  if (memory.oreDiscoveries.length > 0) {
    const uniqueOres = [...new Set(memory.oreDiscoveries.map((o) => o.type))];
    parts.push(`ORES FOUND: ${uniqueOres.join(", ")}`);
  }

  // Skill performance
  const skills = [...new Set(memory.skillHistory.map((s) => s.skill))];
  if (skills.length > 0) {
    const skillStats = skills
      .map((skill) => {
        const stats = getSkillSuccessRate(skill);
        return `${skill}: ${stats.successRate.toFixed(0)}%`;
      })
      .join(", ");
    parts.push(`SKILL PERFORMANCE: ${skillStats}`);
  }

  // Lessons
  if (memory.lessons.length > 0) {
    const recentLessons = memory.lessons.slice(-3);
    parts.push(`LESSONS LEARNED: ${recentLessons.join("; ")}`);
  }

  return parts.length > 0 ? parts.join(". ") : "No memory yet.";
}

// Check if should avoid a location (based on deaths)
export function shouldAvoidLocation(x: number, y: number, z: number, radius = 10): boolean {
  return memory.deaths.some(
    (d) => Math.abs(d.x - x) < radius && Math.abs(d.z - z) < radius
  );
}

// Get stats summary
export function getStats(): { structures: number; deaths: number; ores: number; skills: number } {
  return {
    structures: memory.structures.length,
    deaths: memory.deaths.length,
    ores: memory.oreDiscoveries.length,
    skills: memory.skillHistory.length,
  };
}
