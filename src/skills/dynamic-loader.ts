import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Vec3 } from "vec3";
import { skillRegistry } from "./registry.js";
import type { Skill } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../");

const SKILL_DIRS = [
  path.join(PROJECT_ROOT, "skills/voyager"),
  path.join(PROJECT_ROOT, "skills/generated"),
];

const sandboxRequire = createRequire(import.meta.url);
function safeRequire(mod: string) {
  try { return sandboxRequire(mod); }
  catch { return {}; }
}

export function loadDynamicSkills(): void {
  let loaded = 0;
  for (const dir of SKILL_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".js")) continue;
      const skillName = file.replace(".js", "");
      const skillPath = path.join(dir, file);
      try {
        skillRegistry.set(skillName, buildDynamicSkill(skillName, skillPath));
        loaded++;
      } catch (err: any) {
        console.warn(`[DynamicSkill] Skipped ${file}: ${err.message}`);
      }
    }
  }
  if (loaded > 0) console.log(`[DynamicSkill] Loaded ${loaded} dynamic skills`);
}

function buildDynamicSkill(name: string, filePath: string): Skill {
  const code = fs.readFileSync(filePath, "utf-8");

  return {
    name,
    description: `Dynamic skill: ${name}`,
    params: {},
    estimateMaterials: () => ({}),

    async execute(bot, _params, signal, onProgress) {
      onProgress({ skillName: name, phase: "Running", progress: 0, message: name, active: true });
      try {
        const ctx = vm.createContext({
          bot, Vec3,
          require: safeRequire,
          console, setTimeout, clearTimeout,
          setInterval, clearInterval, Promise, Math, JSON,
        });
        // Define the function in the sandbox, then invoke it
        await vm.runInContext(`${code}\n(async()=>{ await ${name}(bot); })()`, ctx, {
          timeout: 60_000,
          filename: filePath,
        });
        onProgress({ skillName: name, phase: "Done", progress: 1, message: `${name} complete`, active: false });
        return { success: true, message: `${name} completed.` };
      } catch (err: any) {
        if (signal.aborted) return { success: false, message: `${name} aborted.` };
        return { success: false, message: `${name} failed: ${err.message}` };
      }
    },
  };
}

const STATIC_SKILL_NAMES = new Set([
  "build_house","craft_gear","light_area","build_farm",
  "strip_mine","smelt_ores","go_fishing","build_bridge",
]);

export function getDynamicSkillNames(): string[] {
  return Array.from(skillRegistry.keys()).filter((k) => !STATIC_SKILL_NAMES.has(k));
}
