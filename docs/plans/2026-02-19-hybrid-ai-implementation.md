# Hybrid AI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a two-tier dynamic skill system (Voyager JS library + LLM-generated skills) and a Python-backed neural combat burst mode to the existing Minecraft AI streamer bot.

**Architecture:** Hand-crafted TypeScript skills stay in the existing `skillRegistry`. A new dynamic loader wraps Voyager JS files and LLM-generated JS files into the same `Skill` interface using Node's built-in `vm` module — so the existing `executeAction` dispatch finds them automatically. Neural combat runs a Python TCP server that receives structured JSON observations and returns reactive actions at ~20Hz.

**Tech Stack:** Node 24 (`node:vm`, `node:net`, `node:child_process`, `node:test`), TypeScript ESM, Ollama, Python 3.12 (`socket`, `json`, optional `torch`/`minestudio`)

---

## Context: How the codebase works

- `src/skills/registry.ts` — `skillRegistry: Map<string, Skill>`. The default case in `executeAction` calls `skillRegistry.get(action)` so anything registered here is automatically callable.
- `src/skills/types.ts` — `Skill` interface needs `name`, `description`, `params`, `estimateMaterials(bot, params)`, `execute(bot, params, signal, onProgress)`.
- `src/skills/executor.ts` — wraps skill execution with progress reporting and memory recording.
- `src/bot/index.ts` — decision loop: `getWorldContext` → `queryLLM` → `executeAction`. LLM prompt is built in `src/llm/index.ts`.
- `src/bot/memory.ts` — JSON-based persistence (memory.json). Keep as-is.
- `src/bot/perception.ts` — `getWorldContext` and `isHostile` helper.

---

## Phase 1: Dynamic Skill System

### Task 1: Create directory structure

**Files:**
- Create: `skills/voyager/` (root-level) — Voyager JS skill files live here
- Create: `skills/generated/` — LLM-generated JS skills live here

**Step 1: Create directories**

```bash
mkdir -p skills/voyager skills/generated
touch skills/voyager/.gitkeep skills/generated/.gitkeep
```

**Step 2: Add JS files inside these dirs to .gitignore**

Add to `.gitignore`:
```
skills/voyager/*.js
skills/generated/*.js
```

**Step 3: Commit**

```bash
git add skills/ .gitignore
git commit -m "chore: add skill library directories"
```

---

### Task 2: Write a Voyager skill downloader script

Voyager's skill library lives at `https://github.com/MineDojo/Voyager` under `voyager/skill_library/trial1/code/*.js`. The downloader fetches them via GitHub API without cloning the full repo.

**Files:**
- Create: `scripts/download-voyager-skills.mjs`

**Step 1: Write the downloader**

```javascript
// scripts/download-voyager-skills.mjs
// Run: node scripts/download-voyager-skills.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "../skills/voyager");

const API_URL =
  "https://api.github.com/repos/MineDojo/Voyager/contents/voyager/skill_library/trial1/code";

async function download() {
  console.log("Fetching Voyager skill list...");
  const res = await fetch(API_URL, {
    headers: { "User-Agent": "minecraft-ai-streamer" },
  });

  if (!res.ok) {
    console.error(`GitHub API error: ${res.status} ${res.statusText}`);
    console.log("Manual fallback:");
    console.log("  git clone https://github.com/MineDojo/Voyager /tmp/voyager");
    console.log(`  cp /tmp/voyager/voyager/skill_library/trial1/code/*.js ${OUTPUT_DIR}/`);
    process.exit(1);
  }

  const files = await res.json();
  const jsFiles = files.filter((f) => f.name.endsWith(".js"));
  console.log(`Found ${jsFiles.length} skills. Downloading...`);

  for (const file of jsFiles) {
    const codeRes = await fetch(file.download_url);
    const code = await codeRes.text();
    const dest = path.join(OUTPUT_DIR, file.name);
    fs.writeFileSync(dest, code);
    console.log(`  ✓ ${file.name}`);
  }

  console.log(`\nDownloaded ${jsFiles.length} Voyager skills to skills/voyager/`);
}

download().catch(console.error);
```

**Step 2: Add script to package.json**

In `package.json`, add to `"scripts"`:
```json
"download-skills": "node scripts/download-voyager-skills.mjs"
```

**Step 3: Run it**

```bash
npm run download-skills
ls skills/voyager/ | head -20
```

Expected: 40–60 `.js` files like `craftWoodenPickaxe.js`, `mineDiamond.js`.

If GitHub rate-limited, use the manual clone fallback printed by the script.

**Step 4: Commit the script (not the downloaded JS files)**

```bash
git add scripts/download-voyager-skills.mjs package.json
git commit -m "feat: add Voyager skill downloader script"
```

---

### Task 3: Dynamic skill loader (vm sandbox)

The loader scans `skills/voyager/` and `skills/generated/`, wraps each JS file into a `Skill` object, and registers it into `skillRegistry`.

**Files:**
- Create: `src/skills/dynamic-loader.ts`
- Modify: `src/skills/registry.ts` (call `loadDynamicSkills` on startup)

**Step 1: Write a test for the loader**

Create `src/skills/dynamic-loader.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("dynamic-loader: loads a JS skill into the registry", async () => {
  const { loadDynamicSkills } = await import("./dynamic-loader.js");
  const { skillRegistry } = await import("./registry.js");

  const tmpDir = path.join(__dirname, "../../skills/generated");
  fs.mkdirSync(tmpDir, { recursive: true });
  const skillPath = path.join(tmpDir, "testEcho.js");
  fs.writeFileSync(skillPath, `async function testEcho(bot) { bot.__testResult = "echo"; }`);

  loadDynamicSkills();

  assert.ok(skillRegistry.has("testEcho"), "testEcho should be in registry");
  assert.equal(skillRegistry.get("testEcho")!.name, "testEcho");

  fs.unlinkSync(skillPath);
  skillRegistry.delete("testEcho");
});

test("dynamic-loader: skill executes in sandboxed context", async () => {
  const { loadDynamicSkills } = await import("./dynamic-loader.js");
  const { skillRegistry } = await import("./registry.js");

  const tmpDir = path.join(__dirname, "../../skills/generated");
  fs.mkdirSync(tmpDir, { recursive: true });
  const skillPath = path.join(tmpDir, "testMock.js");
  fs.writeFileSync(skillPath, `async function testMock(bot) { bot.__ran = true; }`);

  loadDynamicSkills();

  const skill = skillRegistry.get("testMock")!;
  const mockBot = { __ran: false } as any;
  const result = await skill.execute(mockBot, {}, new AbortController().signal, () => {});

  assert.ok(mockBot.__ran, "skill should have set __ran on bot");
  assert.ok(result.success);

  fs.unlinkSync(skillPath);
  skillRegistry.delete("testMock");
});
```

**Step 2: Run test — expect failure (module not found)**

```bash
npx tsx --test src/skills/dynamic-loader.test.ts 2>&1 | head -10
```

**Step 3: Implement the loader**

Create `src/skills/dynamic-loader.ts`:

```typescript
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
```

**Step 4: Run tests — expect pass**

```bash
npx tsx --test src/skills/dynamic-loader.test.ts
```

Expected:
```
✓ dynamic-loader: loads a JS skill into the registry
✓ dynamic-loader: skill executes in sandboxed context
```

**Step 5: Wire into registry**

In `src/skills/registry.ts`, add at the bottom (after all `register()` calls):

```typescript
import { loadDynamicSkills } from "./dynamic-loader.js";
loadDynamicSkills();
```

**Step 6: TypeScript compile check**

```bash
npx tsc --noEmit
```

**Step 7: Commit**

```bash
git add src/skills/dynamic-loader.ts src/skills/dynamic-loader.test.ts src/skills/registry.ts
git commit -m "feat: dynamic skill loader — vm sandbox for Voyager and generated JS skills"
```

---

### Task 4: LLM skill generator

When the bot encounters a task it has no skill for, it calls `generate_skill`. Ollama writes the JS, it gets saved, and `loadDynamicSkills()` hot-registers it.

**Files:**
- Create: `src/skills/generator.ts`
- Create: `src/skills/generator.test.ts`
- Modify: `src/bot/actions.ts`

**Step 1: Write the test**

Create `src/skills/generator.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("saveGeneratedSkill: writes JS to skills/generated/", async () => {
  const { saveGeneratedSkill } = await import("./generator.js");
  const code = `async function myTestSkill(bot) { bot.__done = true; }`;
  const name = await saveGeneratedSkill("myTestSkill", code);

  assert.equal(name, "myTestSkill");
  const dest = path.join(__dirname, "../../skills/generated/myTestSkill.js");
  assert.ok(fs.existsSync(dest));
  assert.equal(fs.readFileSync(dest, "utf-8"), code);

  fs.unlinkSync(dest);
});
```

**Step 2: Run test — expect failure**

```bash
npx tsx --test src/skills/generator.test.ts 2>&1 | head -5
```

**Step 3: Implement the generator**

Create `src/skills/generator.ts`:

```typescript
import fs from "node:fs";
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
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(path.join(GENERATED_DIR, `${name}.js`), code, "utf-8");
  console.log(`[Generator] Saved skill '${name}'`);
  return name;
}

export async function generateSkill(task: string): Promise<string> {
  const skillName = task
    .toLowerCase().replace(/[^a-z0-9 ]/g, "").trim()
    .split(/\s+/)
    .map((w, i) => i === 0 ? w : w[0].toUpperCase() + w.slice(1))
    .join("").slice(0, 40);

  console.log(`[Generator] Writing '${skillName}' for: ${task}`);

  const prompt = GENERATION_PROMPT
    .replace("SKILL_NAME", skillName)
    .replace("TASK_DESCRIPTION", task);

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
```

**Step 4: Run test — expect pass**

```bash
npx tsx --test src/skills/generator.test.ts
```

**Step 5: Add `generate_skill` to executeAction**

In `src/bot/actions.ts`, add before the `default:` case:

```typescript
      case "generate_skill": {
        if (!params.task) return "generate_skill needs a 'task' param describing what to do.";
        const { generateSkill } = await import("../skills/generator.js");
        const name = await generateSkill(params.task as string);
        return `Generated skill '${name}'! I can now use it with invoke_skill.`;
      }
```

**Step 6: Compile check**

```bash
npx tsc --noEmit
```

**Step 7: Commit**

```bash
git add src/skills/generator.ts src/skills/generator.test.ts src/bot/actions.ts
git commit -m "feat: LLM skill generator — Ollama writes JS on demand"
```

---

### Task 5: Update LLM prompt for dynamic skills

**Files:**
- Modify: `src/llm/index.ts`
- Modify: `src/bot/actions.ts` (add `invoke_skill`)

**Step 1: Convert SYSTEM_PROMPT to a function and add new actions**

In `src/llm/index.ts`:

1. Add import: `import { getDynamicSkillNames } from "../skills/dynamic-loader.js";`

2. Rename `const SYSTEM_PROMPT = \`...\`` to `function buildSystemPrompt(): string { return \`...\`; }`

3. Inside the prompt, replace the closing of `SKILL TIPS:` with:

```
DYNAMIC SKILLS (invoke with invoke_skill action):
Available: ${getDynamicSkillNames().join(", ") || "none yet — use generate_skill to create some!"}

- invoke_skill: Run a Voyager or generated skill by name. params: { "skill": string }
- generate_skill: Write new code for a novel task you have no skill for yet. params: { "task": string }
- neural_combat: Enter high-speed reactive combat mode. params: { "duration": number (1-10 seconds) }
```

4. Replace both uses of `SYSTEM_PROMPT` (in `queryLLM` and `chatWithLLM`) with `buildSystemPrompt()`.

**Step 2: Add `invoke_skill` to executeAction**

In `src/bot/actions.ts`, add to switch (alongside `generate_skill`):

```typescript
      case "invoke_skill": {
        const name = params.skill as string;
        if (!name) return "invoke_skill needs a 'skill' param.";
        const skill = skillRegistry.get(name);
        if (!skill) return `Skill '${name}' not found. Try generate_skill to create it.`;
        return await runSkill(bot, skill, params);
      }
```

**Step 3: Compile check**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/llm/index.ts src/bot/actions.ts
git commit -m "feat: expose dynamic skills in LLM prompt, add invoke_skill action"
```

---

## Phase 2: Neural Combat

### Task 6: Python neural server

**Files:**
- Create: `neural_server.py`
- Create: `requirements-neural.txt`

**Step 1: requirements file**

```
torch>=2.0.0
# Uncomment for MineStudio VPT model support:
# minestudio
```

**Step 2: Write neural_server.py**

```python
#!/usr/bin/env python3
"""
Neural combat server for minecraft-ai-streamer.
Receives JSON obs via TCP, returns action decisions.
Run: python3 neural_server.py [--port 12345] [--model heuristic|vpt]
"""
import socket, json, sys, argparse, logging, math, random

logging.basicConfig(level=logging.INFO, format="[Neural] %(message)s")
log = logging.getLogger(__name__)

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=12345)
    p.add_argument("--model", choices=["heuristic", "vpt"], default="heuristic")
    return p.parse_args()

# Observation schema (from TypeScript bridge):
# { bot_health, bot_food, bot_pos, nearest_hostile, all_entities, has_sword, has_shield, has_bow }
# Response schema:
# { action: "attack"|"strafe_left"|"strafe_right"|"flee"|"use_item"|"idle", confidence: float }

def heuristic_policy(obs: dict) -> dict:
    health = obs.get("bot_health", 20)
    hostile = obs.get("nearest_hostile")
    all_entities = obs.get("all_entities", [])

    if health <= 4:
        return {"action": "flee", "confidence": 0.99}
    if hostile is None:
        return {"action": "idle", "confidence": 0.95}

    dist = hostile["distance"]
    angle = abs(hostile.get("angle", 0))
    nearby_count = sum(1 for e in all_entities if e.get("distance", 99) < 8)

    if nearby_count >= 3 and health < 15:
        return {"action": "flee", "confidence": 0.85}
    if angle > 90:
        return {"action": "strafe_left", "confidence": 0.7}
    if dist > 6:
        return {"action": "attack", "confidence": 0.6}
    if dist <= 3 and angle < 45:
        return {"action": "attack", "confidence": 0.95}
    if dist <= 6:
        return {"action": random.choice(["strafe_left", "strafe_right"]), "confidence": 0.75}
    return {"action": "attack", "confidence": 0.6}

def load_vpt_model():
    try:
        import torch
        from minestudio.models import VPTPolicy
        model = VPTPolicy.from_pretrained(
            "CraftJarvis/MineStudio_VPT.rl_for_shoot_animals_2x"
        ).eval()
        if torch.cuda.is_available():
            model = model.cuda()
        log.info("VPT model loaded")
        return model
    except Exception as e:
        log.warning(f"VPT unavailable ({e}) — using heuristic")
        return None

def handle_connection(conn, policy_fn):
    try:
        data = b""
        while True:
            chunk = conn.recv(4096)
            if not chunk: break
            data += chunk
            if b"\n" in data or len(data) > 8192: break
        if not data: return
        obs = json.loads(data.decode().strip())
        action = policy_fn(obs)
        conn.sendall((json.dumps(action) + "\n").encode())
    except Exception as e:
        log.warning(f"Connection error: {e}")
        conn.sendall(b'{"action":"idle","confidence":0.5}\n')
    finally:
        conn.close()

def main():
    args = parse_args()
    model = load_vpt_model() if args.model == "vpt" else None
    policy = (lambda obs: heuristic_policy(obs)) if not model else (lambda obs: heuristic_policy(obs))  # extend for VPT later

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", args.port))
    server.listen(10)
    log.info(f"Ready on port {args.port} (policy={args.model})")

    try:
        while True:
            conn, _ = server.accept()
            handle_connection(conn, policy)
    except KeyboardInterrupt:
        log.info("Stopped.")
    finally:
        server.close()

if __name__ == "__main__":
    main()
```

**Step 3: Manual test**

Terminal 1: `python3 neural_server.py`

Terminal 2:
```bash
echo '{"bot_health":18,"nearest_hostile":{"type":"zombie","distance":3.5,"angle":10,"health":20},"all_entities":[],"has_sword":true}' | nc 127.0.0.1 12345
```
Expected: `{"action": "attack", "confidence": 0.95}`

```bash
echo '{"bot_health":3,"nearest_hostile":{"type":"zombie","distance":3.5,"angle":10,"health":20},"all_entities":[]}' | nc 127.0.0.1 12345
```
Expected: `{"action": "flee", "confidence": 0.99}`

**Step 4: Commit**

```bash
git add neural_server.py requirements-neural.txt
git commit -m "feat: Python neural combat server with heuristic policy and optional VPT support"
```

---

### Task 7: TypeScript neural bridge

**Files:**
- Create: `src/neural/bridge.ts`
- Create: `src/neural/bridge.test.ts`

**Step 1: Write the test**

Create `src/neural/bridge.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

function startMockServer(port: number, response: string): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      conn.once("data", () => { conn.write(response + "\n"); conn.end(); });
    });
    server.listen(port, () => resolve(server));
  });
}

test("buildObservation: formats bot state into structured obs", async () => {
  const { buildObservation } = await import("./bridge.js");
  const mockBot = {
    health: 18, food: 16,
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 }, yaw: 0 },
    inventory: { items: () => [{ name: "iron_sword" }, { name: "shield" }] },
    entities: {},
  } as any;

  const obs = buildObservation(mockBot);
  assert.equal(obs.bot_health, 18);
  assert.equal(obs.has_sword, true);
  assert.equal(obs.has_shield, true);
  assert.equal(obs.nearest_hostile, null);
});

test("queryNeural: sends obs and parses action response", async () => {
  const TEST_PORT = 19998;
  const server = await startMockServer(TEST_PORT, JSON.stringify({ action: "attack", confidence: 0.95 }));
  try {
    const { queryNeural } = await import("./bridge.js");
    const mockObs = {
      bot_health: 18, bot_food: 16, bot_pos: [0,64,0] as [number,number,number],
      nearest_hostile: null, all_entities: [],
      has_sword: true, has_shield: false, has_bow: false,
    };
    const result = await queryNeural(mockObs, TEST_PORT);
    assert.equal(result.action, "attack");
    assert.equal(result.confidence, 0.95);
  } finally {
    server.close();
  }
});
```

**Step 2: Run test — expect failure**

```bash
npx tsx --test src/neural/bridge.test.ts 2>&1 | head -5
```

**Step 3: Implement bridge**

Create `src/neural/bridge.ts`:

```typescript
import net from "node:net";
import { isHostile } from "../bot/perception.js";
import type { Bot } from "mineflayer";

export interface NeuralObservation {
  bot_health: number;
  bot_food: number;
  bot_pos: [number, number, number];
  nearest_hostile: { type: string; distance: number; angle: number; health: number } | null;
  all_entities: Array<{ type: string; distance: number; angle: number }>;
  has_sword: boolean;
  has_shield: boolean;
  has_bow: boolean;
}

export interface NeuralAction {
  action: "attack" | "strafe_left" | "strafe_right" | "flee" | "use_item" | "idle";
  confidence: number;
}

export function buildObservation(bot: Bot): NeuralObservation {
  const pos = bot.entity.position;
  const items = bot.inventory.items().map((i) => i.name);
  let nearestHostile: NeuralObservation["nearest_hostile"] = null;
  const allEntities: NeuralObservation["all_entities"] = [];

  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity) continue;
    const dist = pos.distanceTo(entity.position);
    if (dist > 16) continue;

    const dx = entity.position.x - pos.x;
    const dz = entity.position.z - pos.z;
    const entityAngleDeg = Math.atan2(dz, dx) * (180 / Math.PI);
    const botYawDeg = (bot.entity.yaw * 180) / Math.PI;
    let relAngle = Math.abs(entityAngleDeg - botYawDeg) % 360;
    if (relAngle > 180) relAngle = 360 - relAngle;

    const type = entity.name || (entity as any).mobType || "unknown";
    allEntities.push({ type, distance: dist, angle: relAngle });

    if (isHostile(entity)) {
      if (!nearestHostile || dist < nearestHostile.distance) {
        nearestHostile = { type, distance: dist, angle: relAngle, health: (entity as any).health ?? 20 };
      }
    }
  }

  return {
    bot_health: bot.health,
    bot_food: bot.food,
    bot_pos: [pos.x, pos.y, pos.z],
    nearest_hostile: nearestHostile,
    all_entities: allEntities,
    has_sword: items.some((n) => n.includes("sword")),
    has_shield: items.includes("shield"),
    has_bow: items.includes("bow"),
  };
}

export function queryNeural(obs: NeuralObservation, port = 12345, host = "127.0.0.1"): Promise<NeuralAction> {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error("Neural server timeout"));
    }, 500);

    client.connect(port, host, () => client.write(JSON.stringify(obs) + "\n"));

    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timeout);
        client.destroy();
        try { resolve(JSON.parse(buf.slice(0, nl))); }
        catch { reject(new Error(`Bad response: ${buf}`)); }
      }
    });

    client.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

export async function isNeuralServerRunning(port = 12345): Promise<boolean> {
  try {
    await queryNeural({
      bot_health: 20, bot_food: 20, bot_pos: [0,64,0],
      nearest_hostile: null, all_entities: [],
      has_sword: false, has_shield: false, has_bow: false,
    }, port);
    return true;
  } catch {
    return false;
  }
}
```

**Step 4: Run tests — expect pass**

```bash
npx tsx --test src/neural/bridge.test.ts
```

**Step 5: Compile check**

```bash
npx tsc --noEmit
```

**Step 6: Commit**

```bash
git add src/neural/bridge.ts src/neural/bridge.test.ts
git commit -m "feat: TypeScript neural bridge — structured obs to Python server via TCP"
```

---

### Task 8: Neural combat loop

**Files:**
- Create: `src/neural/combat.ts`

**Step 1: Implement combat loop**

Create `src/neural/combat.ts`:

```typescript
import type { Bot } from "mineflayer";
import { isHostile } from "../bot/perception.js";
import { buildObservation, queryNeural, isNeuralServerRunning } from "./bridge.js";

const TICK_MS = 50;
const NEURAL_PORT = 12345;

export async function runNeuralCombat(bot: Bot, durationSeconds: number): Promise<string> {
  const duration = Math.min(Math.max(durationSeconds, 1), 30);
  const endTime = Date.now() + duration * 1000;

  const serverUp = await isNeuralServerRunning(NEURAL_PORT);
  if (!serverUp) {
    console.log("[Neural] Server unreachable — PVP fallback");
    return pvpFallback(bot, duration);
  }

  console.log(`[Neural] Combat burst: ${duration}s`);
  let ticks = 0;
  let attacks = 0;

  while (Date.now() < endTime) {
    const tickStart = Date.now();
    try {
      const obs = buildObservation(bot);
      if (!obs.nearest_hostile && ticks > 10) break;

      const act = await queryNeural(obs, NEURAL_PORT);
      await applyAction(bot, act);
      if (act.action === "attack") attacks++;
    } catch (err: any) {
      console.warn(`[Neural] Tick error: ${err.message}`);
      break;
    }
    const wait = Math.max(0, TICK_MS - (Date.now() - tickStart));
    if (wait > 0) await sleep(wait);
    ticks++;
  }

  bot.clearControlStates();
  return `Neural combat: ${ticks} ticks, ${attacks} attacks.`;
}

async function applyAction(bot: Bot, act: { action: string }): Promise<void> {
  bot.clearControlStates();
  switch (act.action) {
    case "attack": {
      const target = bot.nearestEntity(
        (e) => isHostile(e) && e.position.distanceTo(bot.entity.position) < 16
      );
      if (target) {
        await bot.lookAt(target.position.offset(0, (target as any).height ?? 1.6, 0));
        bot.attack(target);
      }
      bot.setControlState("sprint", true);
      break;
    }
    case "strafe_left":
      bot.setControlState("left", true);
      bot.setControlState("sprint", true);
      break;
    case "strafe_right":
      bot.setControlState("right", true);
      bot.setControlState("sprint", true);
      break;
    case "flee": {
      const hostile = bot.nearestEntity(
        (e) => isHostile(e) && e.position.distanceTo(bot.entity.position) < 16
      );
      if (hostile) {
        const away = bot.entity.position.minus(hostile.position).normalize().scaled(10);
        bot.lookAt(bot.entity.position.plus(away));
      }
      bot.setControlState("back", true);
      bot.setControlState("sprint", true);
      break;
    }
    case "use_item":
      bot.activateItem();
      break;
  }
}

function pvpFallback(bot: Bot, duration: number): Promise<string> {
  const target = bot.nearestEntity(
    (e) => isHostile(e) && e.position.distanceTo(bot.entity.position) < 16
  );
  if (!target) return Promise.resolve("No hostiles found.");
  bot.pvp.attack(target);
  return sleep(duration * 1000).then(() => { bot.pvp.stop(); return `PVP fallback: ${duration}s.`; });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
```

**Step 2: Compile check**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/neural/combat.ts
git commit -m "feat: neural combat loop at 20Hz with PVP plugin fallback"
```

---

### Task 9: Wire neural combat into decision loop

**Files:**
- Modify: `src/bot/actions.ts` — add `neural_combat` case
- Modify: `src/bot/index.ts` — auto-spawn Python server on startup

**Step 1: Add to executeAction**

In `src/bot/actions.ts`, add import at top:
```typescript
import { runNeuralCombat } from "../neural/combat.js";
```

Add case to switch:
```typescript
      case "neural_combat": {
        const duration = (params.duration as number) || 5;
        return await runNeuralCombat(bot, duration);
      }
```

**Step 2: Auto-spawn Python server on bot startup**

In `src/bot/index.ts`, add imports at top:
```typescript
import { spawn } from "node:child_process";
import { isNeuralServerRunning } from "../neural/bridge.js";
```

Add function before `createBot`:
```typescript
async function ensureNeuralServer(): Promise<void> {
  if (await isNeuralServerRunning()) {
    console.log("[Bot] Neural server already running.");
    return;
  }
  console.log("[Bot] Starting neural server...");
  const proc = spawn("python3", ["neural_server.py"], { stdio: "pipe" });
  proc.stdout?.on("data", (d) => console.log(`[Neural] ${d.toString().trim()}`));
  proc.stderr?.on("data", (d) => console.log(`[Neural] ${d.toString().trim()}`));
  proc.on("exit", (code) => console.log(`[Neural] Server exited (${code})`));

  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isNeuralServerRunning()) {
      console.log("[Bot] Neural server ready.");
      return;
    }
  }
  console.warn("[Bot] Neural server timed out — combat fallback active.");
}
```

Call at top of `createBot` (before bot creation):
```typescript
  ensureNeuralServer().catch((e) => console.warn("[Bot] Neural spawn error:", e));
```

**Step 3: Compile check**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/bot/actions.ts src/bot/index.ts
git commit -m "feat: wire neural_combat into decision loop, auto-spawn Python server"
```

---

## Phase 3: Polish

### Task 10: Ore tracking in perception

**Files:**
- Modify: `src/bot/perception.ts`

**Step 1: Record ores when detected**

In `src/bot/perception.ts`, add import:
```typescript
import { recordOre } from "./memory.js";
```

In `getNearbyBlockTypes`, after `found.add(block.name)`, insert:
```typescript
          if (block.name.includes("ore")) {
            recordOre(block.name, pos.x + dx, pos.y + dy, pos.z + dz);
          }
```

**Step 2: Compile check**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/bot/perception.ts
git commit -m "feat: record ore discoveries to memory via perception scan"
```

---

### Task 11: End-to-end validation

**Step 1: Run all unit tests**

```bash
npx tsx --test src/skills/dynamic-loader.test.ts src/skills/generator.test.ts src/neural/bridge.test.ts
```

Expected: All pass.

**Step 2: Download Voyager skills**

```bash
npm run download-skills
ls skills/voyager/ | wc -l
```

Expected: 30+ files.

**Step 3: Start bot and verify startup logs**

```bash
npm run dev
```

Watch for all of:
```
[DynamicSkill] Loaded N dynamic skills
[Bot] Starting neural server...
[Neural] Ready on port 12345 (policy=heuristic)
[Bot] Neural server ready.
[Bot] Spawned! Starting decision loop...
```

**Step 4: Verify dynamic skills in LLM prompt**

Add temporary log at top of `queryLLM`: `console.log("[LLM Prompt Preview]", buildSystemPrompt().slice(0, 500))`. Start bot, confirm Voyager skill names appear under DYNAMIC SKILLS. Remove the log.

**Step 5: Test skill generation**

Send a goal via Twitch/MC chat that the bot can't do with existing skills (e.g., "build a lighthouse"). Watch for:
```
[Generator] Writing 'buildLighthouse' for: build a lighthouse
[Generator] Saved skill 'buildLighthouse'
[DynamicSkill] Loaded N+1 dynamic skills
```

**Step 6: Test neural combat**

Spawn a zombie near the bot with `/summon zombie` in Minecraft. Bot should choose `neural_combat`. Watch for:
```
[Neural] Combat burst: 5s
[Neural] Combat: N ticks, M attacks.
```

**Step 7: Final push**

```bash
git push origin main
```

---

## Summary

| Phase | Tasks | New Files |
|---|---|---|
| Dynamic Skills | 1–5 | `dynamic-loader.ts`, `generator.ts`, `download-voyager-skills.mjs` |
| Neural Combat | 6–9 | `neural_server.py`, `bridge.ts`, `combat.ts` |
| Polish | 10–11 | — (perception.ts modified) |
