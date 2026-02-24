import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  /** Persistent set of skills confirmed broken (5+ failures with 0% success rate). Never cleared by rolling window. */
  brokenSkillNames: string[];
  seasonGoal?: string;
}

const defaultMemory: BotMemory = {
  structures: [],
  deaths: [],
  oreDiscoveries: [],
  skillHistory: [],
  lessons: [],
  lastUpdated: new Date().toISOString(),
  brokenSkillNames: [],
  seasonGoal: undefined,
};

const PRECONDITION_KEYWORDS = [
  "No trees found", "need wood", "Need a pickaxe", "No torches",
  "Couldn't plant", "aborted", "No crafting_table",
  "No furnace", "Need more", "not enough", "missing materials",
  // build_farm environment failures (not skill bugs — just wrong location)
  "No water found", "No tillable dirt", "No seeds from grass", "Can't craft a hoe",
  "chunk may not be loaded",
  // voyager mineBlock: resource not nearby (precondition, not bug)
  "Cannot find",
  // "timed out" removed — combat/mining skills that time out are real failures,
  // not precondition failures. exploreUntil timeouts use "aborted" instead.
];

export class BotMemoryStore {
  private memory: BotMemory;
  private memoryFile: string;

  constructor(memoryFileName = "memory.json") {
    this.memoryFile = path.join(__dirname, "../../", memoryFileName);
    this.memory = { ...defaultMemory };
  }

  load(): BotMemory {
    try {
      if (fs.existsSync(this.memoryFile)) {
        const data = fs.readFileSync(this.memoryFile, "utf-8");
        this.memory = JSON.parse(data);
        if (!this.memory.brokenSkillNames) this.memory.brokenSkillNames = [];
        console.log(`[Memory] Loaded from ${path.basename(this.memoryFile)}: ${this.memory.structures.length} structures, ${this.memory.skillHistory.length} skill attempts, ${this.memory.brokenSkillNames.length} known broken skills`);
      }
    } catch (err) {
      console.error("[Memory] Failed to load:", err);
      this.memory = { ...defaultMemory };
    }
    return this.memory;
  }

  private save() {
    try {
      this.memory.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.memoryFile, JSON.stringify(this.memory, null, 2));
    } catch (err) {
      console.error("[Memory] Failed to save:", err);
    }
  }

  addStructure(type: Structure["type"], x: number, y: number, z: number, notes?: string): boolean {
    const existing = this.memory.structures.find(
      (s) => s.type === type && Math.abs(s.x - x) < 10 && Math.abs(s.z - z) < 10
    );
    if (existing) {
      console.log(`[Memory] Structure already exists nearby at ${existing.x}, ${existing.y}, ${existing.z}`);
      return false;
    }
    this.memory.structures.push({
      type,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      builtAt: new Date().toISOString(),
      notes,
    });
    console.log(`[Memory] Added ${type} at ${x}, ${y}, ${z}. Total: ${this.memory.structures.length}`);
    this.save();
    return true;
  }

  hasStructureNearby(type: Structure["type"], x: number, y: number, z: number, radius = 50): boolean {
    return this.memory.structures.some(
      (s) => s.type === type &&
        Math.abs(s.x - x) <= radius &&
        Math.abs(s.z - z) <= radius
    );
  }

  getNearestStructure(type: Structure["type"], x: number, z: number): Structure | null {
    let nearest: Structure | null = null;
    let minDist = Infinity;
    for (const s of this.memory.structures) {
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

  recordDeath(x: number, y: number, z: number, cause: string): void {
    this.memory.deaths.push({
      location: `${x}, ${y}, ${z}`,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      cause,
      timestamp: new Date().toISOString(),
    });
    if (this.memory.deaths.length > 50) {
      this.memory.deaths = this.memory.deaths.slice(-50);
    }
    console.log(`[Memory] Recorded death at ${x}, ${y}, ${z} (cause: ${cause})`);
    this.save();
  }

  recordOre(oreType: string, x: number, y: number, z: number): void {
    const existing = this.memory.oreDiscoveries.find(
      (o) => o.type === oreType && Math.abs(o.x - x) < 5 && Math.abs(o.z - z) < 5
    );
    if (existing) return;
    this.memory.oreDiscoveries.push({
      type: oreType,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      timestamp: new Date().toISOString(),
    });
    console.log(`[Memory] Discovered ${oreType} at ${x}, ${y}, ${z}`);
    this.save();
  }

  recordSkillAttempt(skill: string, success: boolean, durationSeconds: number, notes: string): void {
    this.memory.skillHistory.push({ skill, success, durationSeconds, notes, timestamp: new Date().toISOString() });
    if (this.memory.skillHistory.length > 100) {
      this.memory.skillHistory = this.memory.skillHistory.slice(-100);
    }

    const skillAttempts = this.memory.skillHistory.filter((s) => s.skill === skill);
    const successCount = skillAttempts.filter((s) => s.success).length;
    const successRate = skillAttempts.length > 0 ? (successCount / skillAttempts.length) * 100 : 0;

    const isPreconditionFail = !success && PRECONDITION_KEYWORDS.some(k => notes.toLowerCase().includes(k.toLowerCase()));
    const realFailures = skillAttempts.filter(a => !a.success && !PRECONDITION_KEYWORDS.some(k => (a.notes || "").toLowerCase().includes(k.toLowerCase())));
    if (!success && !isPreconditionFail && realFailures.length >= 5 && !this.memory.brokenSkillNames.includes(skill)) {
      this.memory.brokenSkillNames.push(skill);
      console.log(`[Memory] ${skill} added to permanent broken skills list`);
    }
    // NOTE: we intentionally do NOT auto-remove from brokenSkillNames on success.
    // brokenSkillNames is permanently managed — a skill that was manually added or flagged
    // as broken (e.g., after deletion) stays broken. Fake successes from a buggy old
    // version of a skill must not inadvertently restore it.

    console.log(`[Memory] ${skill}: ${success ? "SUCCESS" : "FAIL"} (${successRate.toFixed(0)}% success rate over ${skillAttempts.length} attempts)`);
    this.save();
  }

  getSkillSuccessRate(skill: string): { successRate: number; totalAttempts: number; avgDuration: number } {
    const attempts = this.memory.skillHistory.filter((s) => s.skill === skill);
    if (attempts.length === 0) return { successRate: -1, totalAttempts: 0, avgDuration: 0 };
    const successes = attempts.filter((a) => a.success).length;
    const avgDuration = attempts.reduce((sum, a) => sum + a.durationSeconds, 0) / attempts.length;
    return { successRate: (successes / attempts.length) * 100, totalAttempts: attempts.length, avgDuration };
  }

  addLesson(lesson: string): void {
    this.memory.lessons.push(lesson);
    if (this.memory.lessons.length > 20) {
      this.memory.lessons = this.memory.lessons.slice(-20);
    }
    this.save();
  }

  getMemoryContext(): string {
    const parts: string[] = [];

    if (this.memory.structures.length > 0) {
      const houses = this.memory.structures.filter((s) => s.type === "house");
      if (houses.length > 0) {
        parts.push(`HOUSES BUILT: ${houses.length} - at coordinates: ${houses.map((h) => `(${h.x}, ${h.z})`).join(", ")}`);
      }
    }

    if (this.memory.deaths.length > 0) {
      const recentDeaths = this.memory.deaths.slice(-5);
      parts.push(`RECENT DEATHS: ${recentDeaths.map((d) => `${d.cause} at (${d.x}, ${d.y}, ${d.z})`).join("; ")}`);
    }

    if (this.memory.oreDiscoveries.length > 0) {
      const uniqueOres = [...new Set(this.memory.oreDiscoveries.map((o) => o.type))];
      parts.push(`ORES FOUND: ${uniqueOres.join(", ")}`);
    }

    const brokenSet = new Set(this.memory.brokenSkillNames);
    const skills = [...new Set(this.memory.skillHistory.map((s) => s.skill))];
    if (brokenSet.size > 0 || skills.length > 0) {
      const brokenLabel: string[] = [];
      const preconditionLabel: string[] = [];
      const normalStats: string[] = [];
      for (const skill of brokenSet) {
        brokenLabel.push(`${skill} (historically broken)`);
      }
      for (const skill of skills) {
        if (brokenSet.has(skill)) continue;
        const attempts = this.memory.skillHistory.filter((s) => s.skill === skill);
        const successes = attempts.filter((a) => a.success).length;
        const realFailures = attempts.filter(a => !a.success && !PRECONDITION_KEYWORDS.some(k => (a.notes || "").toLowerCase().includes(k.toLowerCase())));
        const preconditionFailures = attempts.filter(a => !a.success && PRECONDITION_KEYWORDS.some(k => (a.notes || "").toLowerCase().includes(k.toLowerCase())));
        if (successes === 0 && realFailures.length >= 2) {
          // No successes, at least 2 genuine failures — truly broken
          brokenLabel.push(`${skill} (failed ${attempts.length}/${attempts.length} times)`);
        } else if (successes === 0 && preconditionFailures.length >= 2 && realFailures.length === 0) {
          // All failures are precondition misses (no trees, no materials, etc.) — skill works, just needs resources
          preconditionLabel.push(`${skill} (needs resources — explore/gather first)`);
        } else {
          const rate = attempts.length > 0 ? ((successes / attempts.length) * 100).toFixed(0) : "0";
          normalStats.push(`${skill}: ${rate}%`);
        }
      }
      if (brokenLabel.length > 0) {
        parts.push(`BROKEN SKILLS — DO NOT USE EVER: ${brokenLabel.join(", ")}. These have NEVER succeeded. Choose completely different skills.`);
      }
      if (preconditionLabel.length > 0) {
        parts.push(`SKILLS WAITING FOR RESOURCES (these work fine — just need prerequisites): ${preconditionLabel.join(", ")}`);
      }
      if (normalStats.length > 0) {
        parts.push(`SKILL PERFORMANCE: ${normalStats.join(", ")}`);
      }
    }

    if (this.memory.lessons.length > 0) {
      const recentLessons = this.memory.lessons.slice(-3);
      parts.push(`LESSONS LEARNED: ${recentLessons.join("; ")}`);
    }

    return parts.length > 0 ? parts.join(". ") : "No memory yet.";
  }

  getBrokenSkills(): Map<string, string> {
    const broken = new Map<string, string>();
    for (const skill of this.memory.brokenSkillNames) {
      const msg = `Historically broken (0% success) — never use this skill`;
      broken.set(skill, msg);
      broken.set(`skill:${skill}`, msg);
    }
    const skills = [...new Set(this.memory.skillHistory.map((s) => s.skill))];
    for (const skill of skills) {
      if (broken.has(skill)) continue;
      const attempts = this.memory.skillHistory.filter((s) => s.skill === skill);
      const successes = attempts.filter((a) => a.success).length;
      const realFailures = attempts.filter(a => !a.success && !PRECONDITION_KEYWORDS.some(k => (a.notes || "").toLowerCase().includes(k.toLowerCase())));
      // Only flag as broken if there are REAL failures (not just precondition misses like "no trees")
      if (successes === 0 && realFailures.length >= 2) {
        const msg = `Failed ${attempts.length} times (0% success rate) — this skill is broken, never use it`;
        broken.set(skill, msg);
        broken.set(`skill:${skill}`, msg);
      }
    }
    return broken;
  }

  /** Returns only the persistent brokenSkillNames list (for execution-layer gating). */
  getPersistentBrokenSkillNames(): Set<string> {
    return new Set(this.memory.brokenSkillNames);
  }

  shouldAvoidLocation(x: number, y: number, z: number, radius = 10): boolean {
    return this.memory.deaths.some(
      (d) => Math.abs(d.x - x) < radius && Math.abs(d.z - z) < radius
    );
  }

  getStats(): { structures: number; deaths: number; ores: number; skills: number } {
    return {
      structures: this.memory.structures.length,
      deaths: this.memory.deaths.length,
      ores: this.memory.oreDiscoveries.length,
      skills: this.memory.skillHistory.length,
    };
  }

  getSeasonGoal(): string | undefined {
    return this.memory.seasonGoal;
  }

  setSeasonGoal(goal: string): void {
    this.memory.seasonGoal = goal.trim();
    this.save();
    console.log(`[Memory] Season goal set: "${this.memory.seasonGoal}"`);
  }

  clearSeasonGoal(): void {
    this.memory.seasonGoal = undefined;
    this.save();
    console.log("[Memory] Season goal cleared.");
  }
}

// ---------------------------------------------------------------------------
// Backward-compat singleton — used by src/llm/index.ts and any code that
// hasn't been migrated to per-bot BotMemoryStore instances yet.
// createBot in src/bot/index.ts creates its own per-bot store separately.
// ---------------------------------------------------------------------------
const _singleton = new BotMemoryStore("memory.json");

export function loadMemory(): BotMemory { return _singleton.load(); }
export function getMemoryContext(): string { return _singleton.getMemoryContext(); }
export function recordDeath(x: number, y: number, z: number, cause: string): void { _singleton.recordDeath(x, y, z, cause); }
export function recordOre(oreType: string, x: number, y: number, z: number): void { _singleton.recordOre(oreType, x, y, z); }
export function recordSkillAttempt(skill: string, success: boolean, durationSeconds: number, notes: string): void { _singleton.recordSkillAttempt(skill, success, durationSeconds, notes); }
export function getSkillSuccessRate(skill: string) { return _singleton.getSkillSuccessRate(skill); }
export function addLesson(lesson: string): void { _singleton.addLesson(lesson); }
export function addStructure(type: Structure["type"], x: number, y: number, z: number, notes?: string): boolean { return _singleton.addStructure(type, x, y, z, notes); }
export function hasStructureNearby(type: Structure["type"], x: number, y: number, z: number, radius?: number): boolean { return _singleton.hasStructureNearby(type, x, y, z, radius); }
export function getNearestStructure(type: Structure["type"], x: number, z: number): Structure | null { return _singleton.getNearestStructure(type, x, z); }
export function getBrokenSkills(): Map<string, string> { return _singleton.getBrokenSkills(); }
export function shouldAvoidLocation(x: number, y: number, z: number, radius?: number): boolean { return _singleton.shouldAvoidLocation(x, y, z, radius); }
export function getStats() { return _singleton.getStats(); }
export function getSeasonGoal(): string | undefined { return _singleton.getSeasonGoal(); }
export function setSeasonGoal(goal: string): void { _singleton.setSeasonGoal(goal); }
export function clearSeasonGoal(): void { _singleton.clearSeasonGoal(); }
