# Bug Fixes, Neural Combat & Evaluation Framework Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Fix 6 confirmed bugs causing degraded bot performance, enable in-game neural combat, and build a skill evaluation framework to verify changes work in-game.

**Architecture:** Fix bugs in-place in existing files. Eval framework is a new `src/eval/` module that can be triggered via in-game chat command `/eval <skillname>` or run all skills with `/eval all`. Neural combat is enabled by removing the hardcoded peaceful difficulty and improving the LLM prompt.

**Tech Stack:** TypeScript (tsx watch), Node.js vm, mineflayer, Ollama (qwen2.5:32b), Python TCP (neural server)

---

## Bug Inventory (confirmed by code inspection)

### Bug 1 — Zombie generated skills (CRITICAL)
`skills/generated/craftusefulitemsfromcopperingots.js` calls `bot.inventory.items.find(...)` (missing `()`) and `bot.craft(item.name)` (wrong API). This throws immediately and corrupts the skill registry.
`skills/generated/navigatetocoordinatesandenterhouseifneed.js` uses hardcoded coordinates (100,64,100) and digs doors instead of opening them.
**Fix:** Delete both files.

### Bug 2 — `explore` not tracked in failure map
In `src/bot/index.ts`, `isSkillAction` only covers `invoke_skill`, `generate_skill`, `neural_combat`, and the static skill names. The `explore` action is excluded. So when the bot gets stuck in water calling `explore` repeatedly, the failure is never added to `recentFailures` and the LLM has no signal to stop. Result: bot bobs in water for hours.
**Fix:** Add `"explore"` to the `isSkillAction` condition. Also add water detection to the `explore()` implementation in `actions.ts` to enable swimming movements.

### Bug 3 — `hasUrgentChat` checks cleared array
In `src/bot/index.ts`, `pendingChatMessages` is cleared at line 124 (`pendingChatMessages.length = 0`) but `hasUrgentChat` is computed at line 128 after the clear. `hasUrgentChat` is always `false`.
**Fix:** Compute `hasUrgentChat` before clearing the array (before line 119).

### Bug 4 — Generator prompt allows bad inventory API usage
The skill generator prompt does not specify that `bot.inventory.items()` is a function call (not a property). The LLM generates `bot.inventory.items.find(...)` which throws `is not a function`. Also `bot.craft(name)` is not the correct API.
**Fix:** Add inventory API rules and correct craft API to the generator prompt.

### Bug 5 — Neural combat never triggers (peaceful mode)
`src/bot/index.ts` sends `/difficulty peaceful` at startup. No hostile mobs spawn. The LLM system prompt also doesn't prioritize `neural_combat` when hostiles are close. Even if difficulty is changed externally, the LLM won't choose `neural_combat` because `attack` is listed before it.
**Fix:** Remove `/difficulty peaceful` (keep only `/gamerule keepInventory true`). Update LLM system prompt to instruct the bot to use `neural_combat` when hostile mobs are within 8 blocks.

### Bug 6 — `safeMoves` blocks swimming; explore targets water
`safeMoves()` sets `allowFreeMotion = false` which prevents the pathfinder from swimming. When the bot is in or next to water and `explore` targets a position across/in water, pathfinder bobs the bot up and down endlessly without making progress. The stall detection (requires 0.3 block movement) fires, but then the LLM just calls `explore` again (see Bug 2).
**Fix:** In `explore()` specifically, use a separate moves config that allows water traversal (enable `canSwim` / don't restrict free motion for explore).

---

## Tasks

### Task 1: Delete zombie generated skills

**Files:**
- Delete: `skills/generated/craftusefulitemsfromcopperingots.js`
- Delete: `skills/generated/navigatetocoordinatesandenterhouseifneed.js`

**Step 1: Verify files exist and check for others**

```bash
ls -la skills/generated/
```

**Step 2: Delete both zombie skills**

```bash
rm skills/generated/craftusefulitemsfromcopperingots.js
rm skills/generated/navigatetocoordinatesandenterhouseifneed.js
```

**Step 3: Verify registry is clean (bot must be running)**
Watch startup logs — should see `[DynamicSkill] Loaded 57 dynamic skills` (Voyager only, no generated ones).

**Step 4: Commit**

```bash
git add -A
git commit -m "fix: delete zombie generated skills with broken inventory API calls"
```

---

### Task 2: Fix `hasUrgentChat` bug and `explore` failure tracking

**Files:**
- Modify: `src/bot/index.ts`

**Step 1: Read the relevant section of index.ts (lines 109-175)**

Confirm the bug: `hasUrgentChat` is computed AFTER `pendingChatMessages.length = 0`.

**Step 2: Fix `hasUrgentChat` — move before the clear**

In `src/bot/index.ts`, find this block:

```typescript
      // Add pending chat messages
      if (pendingChatMessages.length > 0) {
        const chatStr = pendingChatMessages
          .map((m) => `[${m.source}] ${m.username}: ${m.message}`)
          .join("\n");
        contextStr += `\n\nMESSAGES FROM PLAYERS/VIEWERS:\n${chatStr}`;
        pendingChatMessages.length = 0; // Clear after including
      }

      // Goal persistence: tell the LLM what it was working on
      const hasUrgentChat = pendingChatMessages.some(
        (m) => "tier" in m && (m as any).tier === "paid"
      );
```

Replace with:

```typescript
      // Add pending chat messages
      const hasUrgentChat = pendingChatMessages.some(
        (m) => "tier" in m && (m as any).tier === "paid"
      );
      if (pendingChatMessages.length > 0) {
        const chatStr = pendingChatMessages
          .map((m) => `[${m.source}] ${m.username}: ${m.message}`)
          .join("\n");
        contextStr += `\n\nMESSAGES FROM PLAYERS/VIEWERS:\n${chatStr}`;
        pendingChatMessages.length = 0; // Clear after including
      }
```

**Step 3: Add `explore` to `isSkillAction` check**

Find:
```typescript
      const isSkillAction =
        DIRECT_SKILL_NAMES.has(decision.action) ||
        decision.action === "invoke_skill" ||
        decision.action === "neural_combat" ||
        decision.action === "generate_skill";
```

Replace with:
```typescript
      const isSkillAction =
        DIRECT_SKILL_NAMES.has(decision.action) ||
        decision.action === "invoke_skill" ||
        decision.action === "neural_combat" ||
        decision.action === "generate_skill" ||
        decision.action === "explore";
```

**Step 4: Remove `/difficulty peaceful` from startup**

Find in the `spawn` handler:
```typescript
      bot.chat("/difficulty peaceful");
      bot.chat("/gamerule keepInventory true");
      console.log("[Bot] Sent gamerule commands (peaceful + keepInventory)");
```

Replace with:
```typescript
      bot.chat("/gamerule keepInventory true");
      bot.chat("/gamerule doMobSpawning true");
      console.log("[Bot] Sent gamerule commands (keepInventory + mob spawning)");
```

**Step 5: Commit**

```bash
git add src/bot/index.ts
git commit -m "fix: hasUrgentChat bug, add explore to failure tracking, enable mob spawning"
```

---

### Task 3: Fix explore swimming and water detection

**Files:**
- Modify: `src/bot/actions.ts`

**Step 1: Read `safeMoves()` and `explore()` in actions.ts (lines 11-258)**

**Step 2: Add a `swimMoves()` helper for water traversal**

After the `safeMoves` function, add:

```typescript
/** Movement config for exploring — allows swimming unlike safeMoves */
export function explorerMoves(bot: Bot): InstanceType<typeof Movements> {
  const moves = new Movements(bot);
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowFreeMotion = true;  // allows swimming and free vertical movement
  moves.scafoldingBlocks = [];
  return moves;
}
```

**Step 3: Update `explore()` to use `explorerMoves` and detect being in water**

Find the `explore` function and update it to:
1. Use `explorerMoves(bot)` instead of `safeMoves(bot)` for the main exploration pathfinding
2. If the bot is IN water at the start (check `bot.blockAt(pos)?.name === 'water'`), first try to escape water using GoalY(pos.y + 5)

Replace the `explore` function with:

```typescript
async function explore(bot: Bot, direction: string): Promise<string> {
  const pos = bot.entity.position;

  // Escape water first if bot is currently in it
  const currentBlock = bot.blockAt(pos);
  if (currentBlock?.name === "water") {
    console.log("[Explore] Bot is in water — escaping first");
    bot.pathfinder.setMovements(explorerMoves(bot));
    try {
      await safeGoto(bot, new goals.GoalY(Math.ceil(pos.y) + 3), 10000);
    } catch {
      // If we can't escape water by Y, try to get to nearest land
      try {
        bot.pathfinder.setMovements(explorerMoves(bot));
        await safeGoto(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3), 10000);
      } catch { /* best effort */ }
    }
  }

  // If underground, prioritise getting back to the surface first.
  if (pos.y < 60) {
    bot.pathfinder.setMovements(explorerMoves(bot));
    try {
      await safeGoto(bot, new goals.GoalY(70), 30000);
    } catch { /* best effort */ }
  }

  // Shorter hops (20-40 blocks) — pathfinder can compute these reliably
  const dist = 20 + Math.floor(Math.random() * 20);
  const jitter = () => (Math.random() - 0.5) * 20;
  let target: Vec3;

  switch (direction) {
    case "north": target = pos.offset(jitter(), 0, -dist); break;
    case "south": target = pos.offset(jitter(), 0, dist); break;
    case "east": target = pos.offset(dist, 0, jitter()); break;
    case "west": target = pos.offset(-dist, 0, jitter()); break;
    default: target = pos.offset(dist, 0, jitter());
  }

  bot.pathfinder.setMovements(explorerMoves(bot));
  try {
    await safeGoto(bot, new goals.GoalNear(target.x, target.y, target.z, 5), 20000);
  } catch {
    // Non-fatal — report partial progress
  }

  // Report what we can see now
  const logTypes = ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log"];
  const nearbyTree = bot.findBlock({ matching: (b) => logTypes.includes(b.name), maxDistance: 32 });
  const nearbyOre = bot.findBlock({ matching: (b) => b.name.includes("ore"), maxDistance: 16 });
  const nearbyWater = bot.findBlock({ matching: (b) => b.name === "water", maxDistance: 16 });

  const notes: string[] = [];
  if (nearbyTree) notes.push("Found trees nearby!");
  if (nearbyOre) notes.push(`Spotted ${nearbyOre.name}!`);
  if (nearbyWater) notes.push("Water/lake visible.");
  if (notes.length === 0) notes.push("Barren area — no trees or resources visible.");

  const biome = (bot.blockAt(bot.entity.position) as any)?.biome?.name || "unknown";
  const newPos = bot.entity.position;
  return `Explored ${direction} (~${dist} blocks). Now at ${newPos.x.toFixed(0)}, ${newPos.y.toFixed(0)}, ${newPos.z.toFixed(0)}. Biome: ${biome}. ${notes.join(" ")}`;
}
```

**Step 4: Verify** — hot-reload picks it up. If bot is near water, it should escape rather than bobbing.

**Step 5: Commit**

```bash
git add src/bot/actions.ts
git commit -m "fix: explore escapes water before navigating, uses swimming-capable movements"
```

---

### Task 4: Fix generator prompt to prevent bad inventory API usage

**Files:**
- Modify: `src/skills/generator.ts`

**Step 1: Read the current GENERATION_PROMPT in generator.ts**

**Step 2: Replace the prompt with an expanded version that includes API rules**

Find:
```typescript
const GENERATION_PROMPT = `You are writing a Mineflayer bot skill in JavaScript.

Rules:
- Write ONE async function named exactly SKILL_NAME that takes a single bot parameter
- Use only Mineflayer API: bot.findBlock, bot.dig, bot.equip, bot.craft, bot.pathfinder, bot.pvp, bot.inventory
- For Vec3: const { Vec3 } = require('vec3');
- For navigation ALWAYS use: const { goals } = require('mineflayer-pathfinder'); await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
  NEVER use bot.pathfinder.setGoal or bot.pathfinder.waitForGoal — those do not exist
- DO NOT use try/catch — let errors throw so the caller can detect failures
- Works with no arguments other than bot
- Return nothing (void), under 60 lines

TASK: TASK_DESCRIPTION

Write ONLY the JavaScript function. No markdown, no explanation, no backticks.`;
```

Replace with:

```typescript
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
  bot.inventory.items()   // CORRECT: items() is a FUNCTION, always call with ()
  bot.inventory.items().find(i => i.name === 'wood')   // correct
  bot.inventory.items().filter(i => ...)               // correct
  bot.inventory.items.find(...)   // WRONG — this crashes with "is not a function"

CRAFTING API — CRITICAL:
  // To craft an item:
  const mcData = require('minecraft-data')(bot.version);
  const item = mcData.itemsByName['wooden_pickaxe'];
  const table = bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 16 });
  const recipes = bot.recipesFor(item.id, null, 1, table);
  if (recipes.length) await bot.craft(recipes[0], 1, table);
  // NEVER call bot.craft('item_name') — first arg must be a recipe object, not a string

EQUIP:
  const item = bot.inventory.items().find(i => i.name === 'wooden_pickaxe');
  if (item) await bot.equip(item, 'hand');  // always null-check before equip

AVAILABLE GLOBALS: bot, Vec3, mcData (already loaded with bot.version), require, console, Math, JSON, setTimeout

TASK: TASK_DESCRIPTION

Write ONLY the JavaScript function:`;
```

**Step 3: Verify the prompt replaces correctly (no leftover SKILL_NAME/TASK_DESCRIPTION literals)**

```bash
grep -n "SKILL_NAME\|TASK_DESCRIPTION" src/skills/generator.ts
```

Expected output: 2 lines — the `.replace("SKILL_NAME", skillName)` and `.replace("TASK_DESCRIPTION", trimmedTask)` calls.

**Step 4: Commit**

```bash
git add src/skills/generator.ts
git commit -m "fix: generator prompt adds inventory API and craft API rules to prevent broken skills"
```

---

### Task 5: Update LLM prompt to use neural_combat for close-range combat

**Files:**
- Modify: `src/llm/index.ts`

**Step 1: Read the AVAILABLE ACTIONS section and SURVIVAL PRIORITIES section of the system prompt**

**Step 2: Update the survival priorities to prefer neural_combat**

In the `buildSystemPrompt()` function, find:
```
SURVIVAL PRIORITIES (when chat isn't commanding you):
1. If health < 8 or hostile mob nearby: flee or attack (be dramatic about it)
```

Replace that line with:
```
SURVIVAL PRIORITIES (when chat isn't commanding you):
1. If hostile mob within 8 blocks: use neural_combat (duration: 5) — it's faster and smarter than manual attack
2. If health < 6 and mobs nearby: flee first, then fight
```

**Step 3: Update the neural_combat action description to make it the preferred combat action**

Find:
```
- neural_combat: Reactive combat burst at 20Hz. params: { "duration": number (1-10 seconds) }
```

Replace with:
```
- neural_combat: PREFERRED combat action — 20Hz reactive combat against nearby hostiles. Use this whenever hostiles are within 8 blocks. params: { "duration": number (1-10 seconds, default 5) }
- attack: Basic single attack. Only use if neural_combat is unavailable.
```

**Step 4: Commit**

```bash
git add src/llm/index.ts
git commit -m "fix: LLM prompt prefers neural_combat over manual attack for in-range hostiles"
```

---

### Task 6: Build the skill evaluation framework

**Files:**
- Create: `src/eval/runner.ts`
- Modify: `src/bot/index.ts` (add `/eval` chat command handler)

**Purpose:** Provide a way to run any skill and get a pass/fail verdict in-game, so we can verify fixes without watching logs.

**Step 1: Create the eval runner module**

Create `src/eval/runner.ts`:

```typescript
import type { Bot } from "mineflayer";
import { skillRegistry } from "../skills/registry.js";
import { runSkill } from "../skills/executor.js";
import { getDynamicSkillNames } from "../skills/dynamic-loader.js";

export interface EvalResult {
  skill: string;
  passed: boolean;
  message: string;
  durationMs: number;
}

const SUCCESS_PATTERNS = /complet|harvest|built|planted|smelted|crafted|arriv|gather|mined|caught|lit|bridg|chop|killed|ate|placed|fished|explored/i;
const TIMEOUT_MS = 90_000; // 90s per skill

/**
 * Run a single skill and determine pass/fail.
 * Reports result to bot chat so it's visible in-game.
 */
export async function evalSkill(bot: Bot, skillName: string): Promise<EvalResult> {
  const start = Date.now();
  const skill = skillRegistry.get(skillName);
  if (!skill) {
    const result: EvalResult = { skill: skillName, passed: false, message: "Skill not found in registry", durationMs: 0 };
    bot.chat(`[EVAL] FAIL ${skillName}: not found`);
    return result;
  }

  bot.chat(`[EVAL] Running: ${skillName}...`);
  try {
    const abortController = { signal: { aborted: false } } as any;
    let resultMessage = "";

    const skillPromise = runSkill(bot, skill, {}).then((r) => {
      resultMessage = r;
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
    );

    await Promise.race([skillPromise, timeoutPromise]);

    const passed = SUCCESS_PATTERNS.test(resultMessage);
    const durationMs = Date.now() - start;
    const result: EvalResult = { skill: skillName, passed, message: resultMessage, durationMs };
    bot.chat(`[EVAL] ${passed ? "PASS" : "FAIL"} ${skillName} (${(durationMs / 1000).toFixed(1)}s): ${resultMessage.slice(0, 80)}`);
    return result;
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const result: EvalResult = { skill: skillName, passed: false, message: err.message, durationMs };
    bot.chat(`[EVAL] FAIL ${skillName} (${(durationMs / 1000).toFixed(1)}s): ${err.message.slice(0, 80)}`);
    return result;
  }
}

/**
 * Run all registered skills (or a subset) and report a summary.
 * Use filter to run only matching names, e.g. "craft" runs all craft* skills.
 */
export async function evalAll(bot: Bot, filter?: string): Promise<EvalResult[]> {
  const allNames = [
    // Static TypeScript skills
    "gather_wood", "craft_gear", "build_house", "build_farm",
    "strip_mine", "smelt_ores", "go_fishing", "build_bridge", "light_area",
    // Dynamic skills
    ...getDynamicSkillNames(),
  ];

  const toRun = filter
    ? allNames.filter((n) => n.toLowerCase().includes(filter.toLowerCase()))
    : allNames;

  bot.chat(`[EVAL] Starting ${toRun.length} skill evals${filter ? ` (filter: "${filter}")` : ""}...`);

  const results: EvalResult[] = [];
  for (const name of toRun) {
    const result = await evalSkill(bot, name);
    results.push(result);
    // Pause between skills so the bot can settle
    await new Promise((r) => setTimeout(r, 2000));
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  bot.chat(`[EVAL] Summary: ${passed} passed, ${failed} failed out of ${results.length} skills`);

  if (failed > 0) {
    const failNames = results.filter((r) => !r.passed).map((r) => r.skill).join(", ");
    bot.chat(`[EVAL] Failed: ${failNames}`);
  }

  return results;
}
```

**Step 2: Wire `/eval` command into bot chat handler**

In `src/bot/index.ts`, in the `bot.on("chat", ...)` handler, add eval command handling before `queueChat`:

```typescript
  bot.on("chat", async (username, message) => {
    if (username === bot.username) return;
    console.log(`[MC Chat] ${username}: ${message}`);

    // Eval commands: /eval <skillname> or /eval all [filter]
    if (message.startsWith("/eval")) {
      const parts = message.trim().split(/\s+/);
      const { evalSkill, evalAll } = await import("../eval/runner.js");
      if (parts[1] === "all") {
        evalAll(bot, parts[2]).catch((e) => bot.chat(`[EVAL] Error: ${e.message}`));
      } else if (parts[1]) {
        evalSkill(bot, parts[1]).catch((e) => bot.chat(`[EVAL] Error: ${e.message}`));
      } else {
        bot.chat("[EVAL] Usage: /eval <skillname>  or  /eval all [filter]");
      }
      return; // Don't queue eval commands to LLM
    }

    queueChat({ source: "minecraft", username, message, timestamp: Date.now() });
    addChatMessage(username, message, "free");
  });
```

**Step 3: Test the eval framework manually**

Start the bot and in Minecraft chat type:
```
/eval craftCraftingTable
```
Expected: `[EVAL] PASS craftCraftingTable (8.3s): craftCraftingTable completed.`

Then:
```
/eval all craft
```
Expected: runs all craft* skills, reports summary.

**Step 4: Commit**

```bash
git add src/eval/runner.ts src/bot/index.ts
git commit -m "feat: add /eval chat command and skill evaluation framework"
```

---

### Task 7: In-game verification pass

**Purpose:** After all fixes, manually verify the key behaviors are working. Run these in order from Minecraft chat:

**Step 1: Verify no `inventory.items.find` errors**
```
/eval craftCraftingTable
```
Expected: PASS — no "is not a function" in logs.

**Step 2: Verify explore doesn't get stuck in water**

Teleport the bot to be near/in water:
```
/tp AIBot <x_near_water> 62 <z_near_water>
```
Wait 30 seconds. Bot should escape water and explore. If it stays in water for >30s, the fix didn't work.

**Step 3: Verify neural combat triggers**

Spawn a zombie (server must not be in peaceful):
```
/summon zombie ~ ~ ~
```
Watch bot logs — should see `[Bot] Action: neural_combat` and `[Neural] Combat burst:`.
If the LLM doesn't respond fast enough, manually trigger:
```
/eval neural_combat
```

Actually `neural_combat` is an action not a skill — test it differently:
Check logs after spawning zombie to confirm `neural_combat` is chosen.

**Step 4: Verify skill generation doesn't produce broken skills**

In chat:
```
/generate_skill smelt raw iron into ingots
```
Then:
```
/eval smeltrawironintoi
```
Watch for "is not a function" errors — there should be none.

**Step 5: Run full eval on Voyager craft skills**
```
/eval all craft
```
Expected: >70% pass rate. Document any new failures.

**Step 6: Commit verification notes**

After verification, add a note to `docs/VERIFICATION.md` with results.

---

## Success Criteria

| Check | Expected |
|-------|----------|
| No `inventory.items.find` errors | 0 occurrences in logs |
| Bot escapes water within 30s | Confirmed in-game |
| `neural_combat` triggers when zombie nearby | Seen in logs |
| `/eval craftCraftingTable` | PASS |
| `/eval all craft` | >70% pass rate |
| Generator creates valid skills | No syntax errors on load |
| `hasUrgentChat` responds to paid chat | Tested manually |

## Files Modified

- `skills/generated/craftusefulitemsfromcopperingots.js` — DELETED
- `skills/generated/navigatetocoordinatesandenterhouseifneed.js` — DELETED
- `src/bot/index.ts` — hasUrgentChat fix, explore in isSkillAction, /eval command, difficulty change
- `src/bot/actions.ts` — explorerMoves(), water escape in explore()
- `src/skills/generator.ts` — expanded prompt with inventory/craft API rules
- `src/llm/index.ts` — neural_combat preferred for close combat
- `src/eval/runner.ts` — NEW: eval framework
