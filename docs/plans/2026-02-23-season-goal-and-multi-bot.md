# Season Goal & Multi-Bot Architecture

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the bot a persistent long-term narrative goal that drives autonomous decisions, then extend the system to run multiple specialized bots sharing a home base — each with a leash radius so they don't wander off and get lost.

**Architecture:** Season Goal is a single `seasonGoal` string in `memory.json` injected at the top of every LLM prompt and changeable via in-game `!goal` command. Multi-Bot refactors `createBot` to accept a `BotRoleConfig` (personality, leash, home coords, memory file) and launches multiple instances from `src/index.ts` — Atlas the explorer (leash 500 blocks), Flora the farmer/crafter (leash 100 blocks). Each bot gets its own memory file, viewer port, and role-specific system prompt. The Stash is a known coordinate near spawn where bots deposit excess resources.

**Tech Stack:** Mineflayer, Ollama, TypeScript/tsup, Node.js, Socket.IO, tsx watch

---

## Status

| Task | Status | Notes |
|------|--------|-------|
| 1. Season goal in memory | ✅ | |
| 2. Season goal in LLM prompt | ✅ | |
| 3. `!goal` in-game command | ✅ | |
| 4. Season goal in overlay | ✅ | |
| 5. Build & test season goal | ✅ | |
| 6. BotRoleConfig type | ✅ | |
| 7. Parameterize memory per bot | ✅ | |
| 8. createBot accepts role config | ✅ | |
| 9. Leash / home range enforcement | ✅ | |
| 10. Flora bot role config + prompt | ✅ | |
| 11. Multi-bot launch in index.ts | ✅ | |
| 12. Build & test multi-bot | ✅ | |

---

## Background: Why Season Goals Matter

Without a long-term goal, `qwen3:8b` locally optimizes each decision in isolation. It shears sheep 35 times because "that worked last time." A season goal gives every decision a shared direction: "I'm trying to reach the Nether" means mining iron matters, and shearing sheep for the third time clearly doesn't advance the mission.

The goal is stored in `memory.json` (persists across restarts), changed via `!goal set <text>` in-game, and injected as the first line of the system prompt above everything else.

---

## Task 1: Add `seasonGoal` to Memory Schema

**Files:**
- Modify: `src/bot/memory.ts`

### Step 1: Extend `BotMemory` interface

In `src/bot/memory.ts`, add `seasonGoal` to the interface and default:

```typescript
export interface BotMemory {
  structures: Structure[];
  deaths: Death[];
  oreDiscoveries: OreDiscovery[];
  skillHistory: SkillAttempt[];
  lessons: string[];
  lastUpdated: string;
  brokenSkillNames: string[];
  seasonGoal?: string;  // ← add this
}

const defaultMemory: BotMemory = {
  structures: [],
  deaths: [],
  oreDiscoveries: [],
  skillHistory: [],
  lessons: [],
  lastUpdated: new Date().toISOString(),
  brokenSkillNames: [],
  seasonGoal: undefined,  // ← add this
};
```

### Step 2: Add `getSeasonGoal` and `setSeasonGoal` exports

Add at the bottom of `src/bot/memory.ts`:

```typescript
export function getSeasonGoal(): string | undefined {
  return memory.seasonGoal;
}

export function setSeasonGoal(goal: string) {
  memory.seasonGoal = goal.trim();
  saveMemory();
  console.log(`[Memory] Season goal set: "${memory.seasonGoal}"`);
}

export function clearSeasonGoal() {
  memory.seasonGoal = undefined;
  saveMemory();
  console.log("[Memory] Season goal cleared.");
}
```

### Step 3: Commit

```bash
git add src/bot/memory.ts
git commit -m "feat: add seasonGoal field to BotMemory"
```

---

## Task 2: Inject Season Goal into LLM System Prompt

**Files:**
- Modify: `src/llm/index.ts`

### Step 1: Import `getSeasonGoal`

At the top of `src/llm/index.ts`, add to imports:

```typescript
import { getSeasonGoal } from "../bot/memory.js";
```

### Step 2: Prepend to system prompt

In `buildSystemPrompt()` (line 20), prepend the season goal as the very first line — before the character backstory:

```typescript
function buildSystemPrompt(): string {
  const seasonGoal = getSeasonGoal();
  const missionBanner = seasonGoal
    ? `\n🎯 YOUR MISSION THIS SEASON: ${seasonGoal}\nEvery decision should inch toward this mission. When choosing between two actions, pick the one that advances the mission.\n\n`
    : "";

  return `${missionBanner}You are ${config.bot.name}, an AI playing Minecraft...`;
  // (rest of existing prompt unchanged)
}
```

The season goal must be first — LLMs weight earlier context higher, and we want this to dominate over "shear more sheep" muscle memory.

### Step 3: Commit

```bash
git add src/llm/index.ts
git commit -m "feat: inject season goal at top of LLM system prompt"
```

---

## Task 3: `!goal` Command Handler

**Files:**
- Modify: `src/bot/index.ts` (around line 398, in the `chat` event handler)

### Step 1: Import new memory functions

Add to imports at top of `src/bot/index.ts`:

```typescript
import { loadMemory, getMemoryContext, recordDeath, getSeasonGoal, setSeasonGoal, clearSeasonGoal } from "./memory.js";
```

### Step 2: Add command parsing before `queueChat`

In the `bot.on("chat", ...)` handler (around line 393), add after the `/eval` block:

```typescript
// !goal commands — set/clear the season goal from in-game
if (message.startsWith("!goal")) {
  const parts = message.trim().split(/\s+/);
  const sub = parts[1]?.toLowerCase();
  if (sub === "set" && parts.length > 2) {
    const newGoal = parts.slice(2).join(" ");
    setSeasonGoal(newGoal);
    bot.chat(`Mission accepted: "${newGoal}"`);
  } else if (sub === "clear") {
    clearSeasonGoal();
    bot.chat("Season goal cleared. Going freeform.");
  } else if (sub === "show" || !sub) {
    const current = getSeasonGoal();
    bot.chat(current ? `Current mission: "${current}"` : "No season goal set. Use !goal set <text>");
  } else {
    bot.chat("Usage: !goal set <text> | !goal clear | !goal show");
  }
  return;
}
```

### Step 3: Verify no TypeScript errors

```bash
npm run build 2>&1 | tail -5
```

Expected: `Build success`

### Step 4: Commit

```bash
git add src/bot/index.ts
git commit -m "feat: add !goal in-game command to set/clear/show season goal"
```

---

## Task 4: Show Season Goal in Overlay

**Files:**
- Modify: `src/stream/overlay.ts`
- Modify: `overlay/index.html` (or wherever the overlay HTML lives)

### Step 1: Add `seasonGoal` to `OverlayState`

In `src/stream/overlay.ts`:

```typescript
export interface OverlayState {
  health: number;
  food: number;
  position: { x: number; y: number; z: number };
  time: string;
  thought: string;
  action: string;
  actionResult: string;
  inventory: string[];
  chatMessages: { username: string; message: string; tier: string }[];
  skillProgress?: { skillName: string; phase: string; progress: number; message: string; active: boolean };
  seasonGoal?: string;  // ← add this
}
```

### Step 2: Push season goal with regular overlay updates

In `src/bot/index.ts`, in the `setInterval` that pushes overlay updates every 2 seconds (around line 564), add seasonGoal:

```typescript
updateOverlay({
  health: bot.health,
  food: bot.food,
  position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
  time: (bot.time.timeOfDay < 13000 || bot.time.timeOfDay > 23000) ? "Daytime" : "Nighttime",
  inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`),
  seasonGoal: getSeasonGoal(),  // ← add this
} as any);
```

### Step 3: Check what overlay HTML exists

```bash
ls overlay/
```

Find the main HTML file and add a `<div id="season-goal">` element. This is cosmetic — skip if overlay design is complex. The data is available via WebSocket already.

### Step 4: Commit

```bash
git add src/stream/overlay.ts src/bot/index.ts
git commit -m "feat: surface seasonGoal in overlay state"
```

---

## Task 5: Build & Test Season Goal

### Step 1: Build

```bash
npm run build 2>&1 | tail -5
```

Expected: `Build success`

### Step 2: Start the bot and test

```bash
npm run dev
```

In Minecraft in-game chat:
- Type `!goal show` → bot should reply "No season goal set. Use !goal set <text>"
- Type `!goal set Get full iron armor and reach the Nether` → bot replies "Mission accepted"
- Type `!goal show` → bot replies with the goal
- Watch the next few LLM decisions — `[LLM] Raw response` lines should show the bot orienting toward iron/mining

### Step 3: Commit final state

```bash
git add -A
git commit -m "feat: season goal system complete — !goal command + prompt injection + overlay"
git push
```

---

## Task 6: Define `BotRoleConfig` Type

**Files:**
- Create: `src/bot/role.ts`

This file defines the per-bot configuration that differentiates Atlas from Flora from future bots.

### Step 1: Create `src/bot/role.ts`

```typescript
import { Vec3 } from "vec3";

export interface BotRoleConfig {
  /** Display name, e.g. "Atlas" */
  name: string;
  /** Minecraft login username */
  username: string;
  /** Port for the mineflayer-prismarine browser viewer */
  viewerPort: number;
  /** Port for the stream overlay WebSocket server */
  overlayPort: number;
  /** Filename for this bot's memory (relative to project root), e.g. "memory-atlas.json" */
  memoryFile: string;
  /** 2-3 sentence personality injected at the top of the system prompt */
  personality: string;
  /** One-liner role description shown in startup banner */
  role: string;
  /**
   * Home position for the leash. If not set, no range limit.
   * Set automatically when the bot builds its first house.
   */
  homePos?: { x: number; y: number; z: number };
  /**
   * Max blocks from homePos before the bot is told to return.
   * 0 = no limit. Atlas: 500. Flora: 100.
   */
  leashRadius: number;
  /**
   * Coords of The Stash — a shared chest area near spawn.
   * Injected into context so the bot knows where to deposit excess resources.
   */
  stashPos?: { x: number; y: number; z: number };
}

/** Atlas: Explorer and miner. Roams widely, finds ores, scouts terrain. */
export const ATLAS_CONFIG: BotRoleConfig = {
  name: "Atlas",
  username: process.env.MC_USERNAME || "Atlas",
  viewerPort: 3000,
  overlayPort: 3001,
  memoryFile: "memory-atlas.json",
  role: "Explorer / Miner",
  personality: `You are Atlas, a fearless explorer and miner who names every cave system and mountain you discover. You get emotionally attached to ore veins and mourn when they run out. You narrate every adventure like a nature documentary.`,
  leashRadius: 500,
  stashPos: undefined, // Set this after establishing base
};

/** Flora: Farmer, crafter, and base keeper. Stays near home. */
export const FLORA_CONFIG: BotRoleConfig = {
  name: "Flora",
  username: process.env.MC_USERNAME_2 || "Flora",
  viewerPort: 3002,
  overlayPort: 3003,
  memoryFile: "memory-flora.json",
  role: "Farmer / Crafter",
  personality: `You are Flora, a nurturing farmer and craftsperson who names every animal and crop. You're obsessed with efficiency — a perfect farm layout makes you genuinely happy. You scold the other bots when they forget to eat their vegetables.`,
  leashRadius: 150,
  stashPos: undefined,
};
```

### Step 2: Add `MC_USERNAME_2` to `.env.example`

```bash
# .env.example addition:
# MC_USERNAME_2=Flora      # Second bot username (for multi-bot mode)
```

### Step 3: Commit

```bash
git add src/bot/role.ts .env.example
git commit -m "feat: define BotRoleConfig and Atlas/Flora role constants"
```

---

## Task 7: Parameterize Memory Per Bot

Currently `memory.ts` uses a module-level singleton with a hardcoded `memory.json` path. For multiple bots in the same process, we need separate memory stores.

**Files:**
- Modify: `src/bot/memory.ts`

### Step 1: Convert to a class

Replace the module-level `memory` variable and all functions with a `BotMemoryStore` class:

```typescript
// src/bot/memory.ts
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ... (keep all interfaces: Structure, Death, OreDiscovery, SkillAttempt, BotMemory)

export class BotMemoryStore {
  private memory: BotMemory;
  private memoryFile: string;

  constructor(memoryFileName: string = "memory.json") {
    this.memoryFile = path.join(__dirname, "../../", memoryFileName);
    this.memory = { ...defaultMemory };
  }

  load(): BotMemory {
    try {
      if (fs.existsSync(this.memoryFile)) {
        const data = fs.readFileSync(this.memoryFile, "utf-8");
        this.memory = JSON.parse(data);
        if (!this.memory.brokenSkillNames) this.memory.brokenSkillNames = [];
        console.log(`[Memory] Loaded from ${this.memoryFile}: ${this.memory.structures.length} structures, ${this.memory.brokenSkillNames.length} known broken skills`);
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

  // All existing functions become methods, replacing `memory` with `this.memory`
  // and `saveMemory()` with `this.save()`:

  addStructure(type: Structure["type"], x: number, y: number, z: number, notes?: string): boolean { ... }
  hasStructureNearby(...): boolean { ... }
  getNearestStructure(...): Structure | null { ... }
  recordDeath(...): void { ... }
  recordOre(...): void { ... }
  recordSkillAttempt(...): void { ... }
  getSkillSuccessRate(...): { successRate: number; totalAttempts: number; avgDuration: number } { ... }
  addLesson(lesson: string): void { ... }
  getMemoryContext(): string { ... }
  getBrokenSkills(): Map<string, string> { ... }
  shouldAvoidLocation(...): boolean { ... }
  getStats(): { structures: number; deaths: number; ores: number; skills: number } { ... }
  getSeasonGoal(): string | undefined { return this.memory.seasonGoal; }
  setSeasonGoal(goal: string): void { this.memory.seasonGoal = goal.trim(); this.save(); }
  clearSeasonGoal(): void { this.memory.seasonGoal = undefined; this.save(); }
}

// Backward-compat singleton for any code that still uses the old function-based API
export const defaultMemoryStore = new BotMemoryStore("memory.json");
export const loadMemory = () => defaultMemoryStore.load();
export const getMemoryContext = () => defaultMemoryStore.getMemoryContext();
export const recordDeath = (...args: Parameters<BotMemoryStore["recordDeath"]>) => defaultMemoryStore.recordDeath(...args);
export const getSeasonGoal = () => defaultMemoryStore.getSeasonGoal();
export const setSeasonGoal = (goal: string) => defaultMemoryStore.setSeasonGoal(goal);
export const clearSeasonGoal = () => defaultMemoryStore.clearSeasonGoal();
// ... etc for all exports used by other modules
```

**Important:** Keep all the backward-compat re-exports at the bottom. This lets you convert `createBot` in the next task without touching `src/llm/index.ts` or any other imports.

### Step 2: Update `createBot` signature to accept a memory store

In `src/bot/index.ts`, add `memoryStore?: BotMemoryStore` to the options:

```typescript
// For now, just make sure createBot takes an optional store.
// We'll wire this up fully in Task 8.
```

### Step 3: Build to catch type errors

```bash
npm run build 2>&1 | grep -E "error|success"
```

Expected: `Build success` (or fix any type errors before committing)

### Step 4: Commit

```bash
git add src/bot/memory.ts
git commit -m "refactor: convert memory.ts to BotMemoryStore class with per-bot file support"
```

---

## Task 8: `createBot` Accepts `BotRoleConfig`

**Files:**
- Modify: `src/bot/index.ts`
- Modify: `src/llm/index.ts`

### Step 1: Add `roleConfig` parameter to `createBot`

Change the signature:

```typescript
import { BotRoleConfig, ATLAS_CONFIG } from "./role.js";
import { BotMemoryStore } from "./memory.js";

export async function createBot(
  events: BotEvents,
  roleConfig: BotRoleConfig = ATLAS_CONFIG
) {
```

### Step 2: Create a per-bot memory store inside `createBot`

Replace the current `loadMemory()` call:

```typescript
// Per-bot memory store (separate file per bot)
const memStore = new BotMemoryStore(roleConfig.memoryFile);
memStore.load();
```

Replace all `loadMemory()`, `getMemoryContext()`, `recordDeath()`, `getSeasonGoal()`, `setSeasonGoal()`, `clearSeasonGoal()` calls in `createBot` with `memStore.load()`, `memStore.getMemoryContext()`, etc.

### Step 3: Use roleConfig for bot name and personality

Update the `mineflayer.createBot` call:

```typescript
const bot = mineflayer.createBot({
  host: config.mc.host,
  port: config.mc.port,
  username: roleConfig.username,  // ← was config.mc.username
  version: config.mc.version,
  auth: config.mc.auth,
});
```

Update the viewer start:

```typescript
startViewer(bot, roleConfig.viewerPort);  // ← was hardcoded 3000
```

Update the spawnpoint command to use `roleConfig.username`:

```typescript
bot.chat(`/spawnpoint ${roleConfig.username} ${lx} ${ly} ${lz}`);
```

### Step 4: Pass roleConfig personality into LLM calls

`queryLLM` currently calls `buildSystemPrompt()` which uses `config.bot.name`. Extend `queryLLM` to accept an optional `roleConfig`:

In `src/llm/index.ts`:

```typescript
export async function queryLLM(
  context: string,
  recentMessages: LLMMessage[] = [],
  memoryContext: string = "",
  roleConfig?: { name: string; personality: string }
): Promise<...>
```

In `buildSystemPrompt`, accept and use the name/personality:

```typescript
function buildSystemPrompt(roleConfig?: { name: string; personality: string }): string {
  const name = roleConfig?.name ?? config.bot.name;
  const personalityOverride = roleConfig?.personality ?? null;
  const seasonGoal = getSeasonGoal();
  // ... use `name` and `personalityOverride` instead of config.bot.name
}
```

In `createBot`, pass `roleConfig` when calling `queryLLM`:

```typescript
const decision = await queryLLM(contextStr, recentHistory, memoryContext, {
  name: roleConfig.name,
  personality: roleConfig.personality,
});
```

### Step 5: Build and fix type errors

```bash
npm run build 2>&1 | grep -E "error TS|success"
```

### Step 6: Commit

```bash
git add src/bot/index.ts src/llm/index.ts src/bot/role.ts
git commit -m "feat: createBot accepts BotRoleConfig — per-bot name, personality, memory, viewer port"
```

---

## Task 9: Leash / Home Range Enforcement

**Files:**
- Modify: `src/bot/index.ts`

The leash prevents bots from wandering off and getting lost. Two levels:
1. **Warning** (>80% of leash): LLM told to head back
2. **Hard override** (>100% of leash): Skip LLM, go directly to homePos

### Step 1: Add `homePos` tracking variable inside `createBot`

After the state variables block (around line 92):

```typescript
// Leash — updated when bot builds its first house
let homePos: { x: number; y: number; z: number } | null = roleConfig.homePos ?? null;
```

### Step 2: Update `homePos` when a house is built

After the success detection block where we check `result` for "built" (around line 343), add:

```typescript
// Lock home position when first house is built
if (isSuccess && decision.action === "build_house" && !homePos) {
  const p = bot.entity.position;
  homePos = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
  console.log(`[Bot] Home position locked at ${homePos.x}, ${homePos.y}, ${homePos.z}`);
}
```

### Step 3: Add leash check to context building

In `decide()`, after the world context is assembled but before the LLM is called (after line ~155 where stuck detection happens):

```typescript
// Leash enforcement — keep bots from wandering too far from home
if (homePos && roleConfig.leashRadius > 0) {
  const dx = bot.entity.position.x - homePos.x;
  const dz = bot.entity.position.z - homePos.z;
  const distFromHome = Math.sqrt(dx * dx + dz * dz);
  const leashPct = distFromHome / roleConfig.leashRadius;

  if (leashPct >= 1.5) {
    // Hard override — skip LLM, go home now
    console.log(`[Bot] LEASH: ${distFromHome.toFixed(0)} blocks from home (limit ${roleConfig.leashRadius}) — overriding to go_to home`);
    const result = await executeAction(bot, "go_to", homePos);
    events.onAction("go_to", result);
    isActing = false;
    return;
  } else if (leashPct >= 0.8) {
    contextStr += `\n\nLEASH WARNING: You are ${distFromHome.toFixed(0)} blocks from home (max range: ${roleConfig.leashRadius} blocks). Do NOT explore further — start heading back toward home at (${homePos.x}, ${homePos.y}, ${homePos.z}).`;
  }
}
```

**Note:** The hard override at 1.5× the leash radius prevents a runaway bot. The warning at 0.8× gives the bot ~20% buffer to finish what it's doing before turning around.

### Step 4: Add stash position to context if configured

Still in context building, right after the leash check:

```typescript
if (roleConfig.stashPos) {
  const sx = roleConfig.stashPos.x, sy = roleConfig.stashPos.y, sz = roleConfig.stashPos.z;
  contextStr += `\n\nTHE STASH: Shared chest area at (${sx}, ${sy}, ${sz}). When your inventory is nearly full or you have excess materials, drop them at The Stash using go_to then place_block. Pick up materials from The Stash when you need them.`;
}
```

### Step 5: Build

```bash
npm run build 2>&1 | tail -5
```

### Step 6: Commit

```bash
git add src/bot/index.ts
git commit -m "feat: leash/home range enforcement — hard override at 1.5x, warning at 0.8x"
```

---

## Task 10: Flora Bot System Prompt

Flora needs a narrower system prompt than Atlas. She's a base-keeper who farms, crafts, and smelts. She should NOT try to go strip-mining or building houses in distant locations.

**Files:**
- Modify: `src/llm/index.ts`

### Step 1: Role-specific action list in system prompt

In `buildSystemPrompt`, when `roleConfig.name === "Flora"`, restrict the action list shown:

```typescript
function buildSystemPrompt(roleConfig?: { name: string; personality: string; role?: string }): string {
  const name = roleConfig?.name ?? config.bot.name;
  const isFlora = name === "Flora";

  // Flora gets a focused action list — she doesn't explore or mine
  const floraActionOverride = isFlora ? `
AVAILABLE ACTIONS (Flora's toolkit — stay focused on these):
- craft: Craft items. params: { "item": string, "count": number }
- eat: Eat food from inventory. params: {}
- sleep: Use a nearby bed. params: {}
- idle: Look around and tend the base. params: {}
- chat: Say something in chat. params: { "message": string }
- respond_to_chat: Reply to a player. params: { "message": string }
- go_to: Walk to coordinates. params: { "x": number, "y": number, "z": number }

SKILLS (Flora's specialties):
- build_farm: Hoe dirt, plant wheat, harvest when ready.
- smelt_ores: Smelt raw ore into ingots. Crafts furnace if needed.
- craft_gear: Craft tools and armor from current materials.
- build_house: Build shelter if there isn't one within 80 blocks.
- invoke_skill: Run a dynamic skill by exact name. params: { "skill": string }

FLORA'S PRIORITIES:
1. If inventory has raw ore → smelt_ores
2. If farm needs harvesting (mature wheat visible) → build_farm
3. If no farm within 50 blocks → build_farm (to create one)
4. If no shelter within 80 blocks → build_house
5. If hungry → eat
6. Otherwise → craft useful items or tend the base
` : null;
  // ...
}
```

### Step 2: Inject role description into personality section

```typescript
const roleStr = roleConfig?.role ? `\nYOUR ROLE: ${roleConfig.role}\n` : "";
```

Add `roleStr` after the mission banner and before the main personality.

### Step 3: Commit

```bash
git add src/llm/index.ts
git commit -m "feat: Flora-specific system prompt with focused action list and priorities"
```

---

## Task 11: Launch Multiple Bots in `src/index.ts`

**Files:**
- Modify: `src/index.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`

### Step 1: Add `ENABLE_MULTI_BOT` to config

In `src/config.ts`:

```typescript
export const config = {
  // ... existing ...
  multiBot: {
    enabled: process.env.ENABLE_MULTI_BOT === "true",
  },
};
```

### Step 2: Add `MC_USERNAME_2` to `.env`

```bash
# Add to .env
MC_USERNAME_2=Flora
ENABLE_MULTI_BOT=false   # Set to true when ready to run both bots
```

### Step 3: Update `src/index.ts` to optionally spawn Flora

Import Flora config and conditionally spawn:

```typescript
import { createBot } from "./bot/index.js";
import { createTwitchChat } from "./stream/twitch.js";
import { startOverlay, addChatMessage } from "./stream/overlay.js";
import { config } from "./config.js";
import { loadDynamicSkills } from "./skills/dynamic-loader.js";
import { ATLAS_CONFIG, FLORA_CONFIG } from "./bot/role.js";

loadDynamicSkills();

// ...existing restart constants...

async function startBot(roleConfig = ATLAS_CONFIG) {
  console.log(`\n=== ${roleConfig.name} (${roleConfig.role}) (restart #${restartCount}) ===`);
  const fastLabel = config.ollama.fastModel !== config.ollama.model
    ? ` (fast decisions: ${config.ollama.fastModel})` : "";
  console.log(`LLM: ${config.ollama.model}${fastLabel} @ ${config.ollama.host}`);
  console.log(`Server: ${config.mc.host}:${config.mc.port} (MC ${config.mc.version})`);

  // Start overlay only once per bot (persists across restarts)
  // Atlas → port 3001, Flora → port 3003
  if (!overlayStarted) {
    startOverlay(roleConfig.overlayPort);
    overlayStarted = true;
  }

  const { bot, queueChat, stop } = await createBot({
    onThought: (thought) => console.log(`[${roleConfig.name}] 💭 ${thought}`),
    onAction: (action, result) => console.log(`[${roleConfig.name}] 🎮 [${action}] ${result}`),
    onChat: (message) => console.log(`[${roleConfig.name}] 💬 ${message}`),
  }, roleConfig);

  // ... (same Twitch + restart handling as existing code)
}

async function main() {
  // Always start Atlas
  const atlasLoop = runBotLoop(ATLAS_CONFIG);

  // Optionally start Flora
  if (config.multiBot.enabled) {
    const floraLoop = runBotLoop(FLORA_CONFIG);
    await Promise.all([atlasLoop, floraLoop]);
  } else {
    await atlasLoop;
  }
}
```

### Step 4: Extract `runBotLoop` helper

The current `main()` while loop per bot:

```typescript
async function runBotLoop(roleConfig: BotRoleConfig, maxRestarts = MAX_RESTARTS) {
  let restarts = 0;
  let lastKickReason = "";
  while (restarts < maxRestarts) {
    lastKickReason = "";
    try {
      await startBot(roleConfig);
    } catch (err) {
      console.error(`[${roleConfig.name}] Bot crashed:`, err);
    }
    restarts++;
    if (restarts >= maxRestarts) {
      console.error(`[${roleConfig.name}] Max restarts reached. Giving up.`);
      return;
    }
    const delay = lastKickReason.includes("duplicate_login")
      ? DUPLICATE_LOGIN_DELAY_MS : RESTART_DELAY_MS;
    console.log(`[${roleConfig.name}] Restarting in ${delay / 1000}s...`);
    await new Promise((r) => setTimeout(r, delay));
  }
}
```

### Step 5: Build

```bash
npm run build 2>&1 | tail -5
```

Expected: `Build success`

### Step 6: Commit

```bash
git add src/index.ts src/config.ts .env.example
git commit -m "feat: multi-bot launch in index.ts — ENABLE_MULTI_BOT=true spawns Flora alongside Atlas"
```

---

## Task 12: Build & Test Multi-Bot

### Step 1: Test with single bot (ENABLE_MULTI_BOT=false)

```bash
npm run dev
```

Verify Atlas still works exactly as before. Check:
- Startup banner shows "Atlas (Explorer / Miner)"
- `!goal set Get full iron armor` → bot replies + prompt includes mission
- Bot shows VARIETY CHECK after 3 sheep shearings
- No regressions from the refactor

### Step 2: Set stash position in `FLORA_CONFIG`

In `src/bot/role.ts`, after you know your base coordinates (e.g. from Atlas building a house), update `FLORA_CONFIG`:

```typescript
stashPos: { x: 577, y: 107, z: -499 },  // ← your actual base coords
```

Also update `ATLAS_CONFIG.stashPos` to the same.

### Step 3: Enable Flora and run both bots

```bash
# In .env:
ENABLE_MULTI_BOT=true
MC_USERNAME_2=Flora
```

```bash
npm run dev
```

Verify:
- Two MC connections appear in server logs
- Atlas viewer at http://localhost:3000, Flora at http://localhost:3002
- Atlas overlay at http://localhost:3001, Flora at http://localhost:3003
- Flora stays within 150 blocks of home; Atlas roams up to 500 blocks
- Flora defaults to farming/smelting tasks
- Atlas defaults to mining/exploring tasks

### Step 4: Configure OBS for multi-bot stream

Add 4 Browser Sources in OBS:
- "Atlas View" → http://localhost:3000 (game view)
- "Atlas Overlay" → http://localhost:3001 (HUD)
- "Flora View" → http://localhost:3002
- "Flora Overlay" → http://localhost:3003

Create scene switcher rules or manually switch when interesting things happen.

### Step 5: Push

```bash
git add -A
git commit -m "feat: multi-bot architecture complete — Atlas + Flora with leash, shared stash"
git push
```

---

## Future Bots (Post-MVP)

Once the 2-bot system is stable, these can be added by just adding new `BotRoleConfig` entries:

| Bot | Role | Leash | Specialty |
|-----|------|-------|-----------|
| **Brix** | Builder/Architect | 50 blocks | Large structures, decoration |
| **Spike** | Combat/Guard | 200 blocks | Patrol, mob clearing, dungeon runs |
| **Vera** | Trader/Explorer | 300 blocks | Villager trading, cartography |

---

## Rollback

All changes are additive (new files + extensions to existing ones). To roll back:
```bash
git revert HEAD~N  # or git stash
npm run build && npm run dev
```

The `ENABLE_MULTI_BOT=false` default means multi-bot never activates unless explicitly enabled.
