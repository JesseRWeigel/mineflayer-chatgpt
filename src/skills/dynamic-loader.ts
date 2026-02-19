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

  // Validate syntax at load time — throws SyntaxError for malformed JS before the
  // skill ever reaches the registry.  This replaces the old fragile substring check
  // (which failed for arrow functions and was fooled by comments).
  new vm.Script(code);

  return {
    name,
    description: `Dynamic skill: ${name}`,
    params: {},
    estimateMaterials: () => ({}),

    async execute(bot, _params, signal, onProgress) {
      onProgress({ skillName: name, phase: "Running", progress: 0, message: name, active: true });
      try {
        // NOTE: vm.createContext is NOT a security sandbox — skill files must be trusted.
        // A malicious skill could escape via prototype chain. Only load skills from trusted sources.
        const ctx = vm.createContext({
          bot, Vec3,
          require: safeRequire,
          console, setTimeout, clearTimeout,
          setInterval, clearInterval, Promise, Math, JSON,
        });

        // Run the definition to populate the context (does not invoke the function yet).
        vm.runInContext(code, ctx, { filename: filePath });

        // Runtime inspection: confirm the expected name is actually a callable function.
        // This handles async functions, regular functions, arrow functions assigned to
        // const/let/var, and any other declaration style — none of which a substring
        // check could reliably catch.
        if (typeof (ctx as any)[name] !== "function") {
          return {
            success: false,
            message: `${name}: file must define a function named '${name}' (found: ${typeof (ctx as any)[name]})`,
          };
        }

        // Invoke the already-defined function.
        // vm.runInContext's `timeout` option only covers synchronous code; the async
        // wrapper returns a Promise immediately, so we race against an explicit timer.
        const vmPromise = vm.runInContext(`(async()=>{ await ${name}(bot); })()`, ctx, {
          filename: filePath,
        }) as Promise<void>;

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${name} timed out after 60s`)), 60_000)
        );

        await Promise.race([vmPromise, timeoutPromise]);
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
