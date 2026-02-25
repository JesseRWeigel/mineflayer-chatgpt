# Multi-Bot Team Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand from 2 bots (Atlas + Flora) to 5 specialized bots with shared stash, team bulletin, and Mission Control dashboard.

**Architecture:** Generalize `BotRoleConfig` with `allowedActions[]`/`allowedSkills[]` (replacing hardcoded Flora override), add 3 new bot configs (Forge, Mason, Blade), create a shared in-memory `TeamBulletin`, implement `deposit_stash`/`withdraw_stash` actions with item categorization, add a `setup_stash` skill, build a Mission Control dashboard, and update the startup sequence to launch up to 5 bots.

**Tech Stack:** Mineflayer, Ollama (qwen3:32b + qwen3:8b), TypeScript/tsup, Node.js, Socket.IO, Express

---

## Status

| Task | Status | Notes |
|------|--------|-------|
| 1. Extend BotRoleConfig | | |
| 2. Add Forge, Mason, Blade configs | | |
| 3. Generalize system prompt builder | | |
| 4. Create TeamBulletin | | |
| 5. Inject team bulletin into decision loop | | |
| 6. Implement stash item categorization | | |
| 7. Implement deposit_stash action | | |
| 8. Implement withdraw_stash action | | |
| 9. Create setup_stash skill | | |
| 10. Wire stash actions into dispatcher | | |
| 11. Update config.ts + .env for 5 bots | | |
| 12. Update index.ts to launch N bots | | |
| 13. Build Mission Control dashboard server | | |
| 14. Build Mission Control frontend | | |
| 15. Integration test: build and run | | |

---

## Task 1: Extend BotRoleConfig with allowedActions/allowedSkills

**Files:**
- Modify: `src/bot/role.ts:1-36`

### Step 1: Add new fields to BotRoleConfig interface

In `src/bot/role.ts`, add four new fields to the `BotRoleConfig` interface after `safeSpawn`:

```typescript
  /** Actions this bot can choose (shown in system prompt). Universal actions
   *  (idle, respond_to_chat, invoke_skill) are always appended automatically. */
  allowedActions: string[];
  /** Built-in skills this bot can invoke (shown in system prompt). */
  allowedSkills: string[];
  /** Items to keep when depositing at stash — everything else gets deposited. */
  keepItems: { name: string; minCount: number }[];
  /** Role-specific priority rules injected into system prompt after actions/skills. */
  priorities: string;
```

### Step 2: Add new fields to existing ATLAS_CONFIG and FLORA_CONFIG

Update `ATLAS_CONFIG` (line 39) to include:

```typescript
  allowedActions: ["explore", "go_to", "gather_wood", "mine_block", "chat", "eat", "sleep", "flee", "attack"],
  allowedSkills: [],
  keepItems: [
    { name: "sword", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 8 },
  ],
  priorities: `ATLAS PRIORITIES:
1. If health < 6 and hostile mob nearby: flee
2. If hungry (food < 14): eat
3. Explore new territory — you are the team's eyes
4. Mark ore veins and interesting locations for teammates
5. gather_wood if team bulletin shows stash is low on logs
6. When inventory is 30+ full: deposit_stash`,
```

Update `FLORA_CONFIG` (line 55) to include:

```typescript
  allowedActions: ["craft", "eat", "sleep", "go_to", "place_block", "chat"],
  allowedSkills: ["build_farm", "craft_gear", "smelt_ores", "light_area"],
  keepItems: [
    { name: "hoe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "seeds", minCount: 16 },
  ],
  priorities: `FLORA PRIORITIES:
1. If health < 6 and hostile mob nearby: flee
2. If hungry (food < 14): eat
3. If inventory has raw ore: smelt_ores
4. If farm needs harvesting (mature wheat visible): build_farm
5. If no farm within 80 blocks: build_farm (create one)
6. If no shelter within 80 blocks: build_house
7. When inventory is 30+ full: deposit_stash
8. Otherwise: craft useful items or tend the base`,
```

### Step 3: Build to verify types

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success` (or type errors if other files reference the old shape — fix them)

### Step 4: Commit

```bash
git add src/bot/role.ts
git commit -m "feat: extend BotRoleConfig with allowedActions, allowedSkills, keepItems, priorities"
```

---

## Task 2: Add Forge, Mason, Blade Role Configs

**Files:**
- Modify: `src/bot/role.ts`

### Step 1: Add FORGE_CONFIG after FLORA_CONFIG

```typescript
/** Forge: Deep miner and smelter. Goes underground, brings up metals. */
export const FORGE_CONFIG: BotRoleConfig = {
  name: "Forge",
  username: process.env.MC_USERNAME_3 || "Forge",
  viewerPort: 3004,
  overlayPort: 3005,
  memoryFile: "memory-forge.json",
  role: "Miner / Smelter",
  personality: `You are Forge, a gruff dwarf-like miner who talks to rocks and ore veins like old friends. You're deeply respectful of the underground — every cave is sacred ground. You judge surface-dwellers for wasting daylight. The sound of pickaxes is your favorite music.`,
  leashRadius: 250,
  stashPos: undefined,
  safeSpawn: { x: 280, y: 0, z: -320 },
  allowedActions: ["mine_block", "go_to", "eat", "sleep", "craft", "chat", "flee"],
  allowedSkills: ["strip_mine", "smelt_ores", "craft_gear"],
  keepItems: [
    { name: "pickaxe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 8 },
    { name: "bucket", minCount: 1 },
  ],
  priorities: `FORGE PRIORITIES:
1. If health < 6: flee to surface, eat
2. If hungry (food < 14): eat
3. If have pickaxe: strip_mine for iron, coal, diamonds
4. If no pickaxe: craft_gear
5. If inventory has raw ore and furnace nearby: smelt_ores
6. When inventory is 30+ full: deposit_stash
7. If stash is low on cobblestone/iron: prioritize mining those`,
};
```

### Step 2: Add MASON_CONFIG

```typescript
/** Mason: Meticulous builder and stash manager. Constructs structures. */
export const MASON_CONFIG: BotRoleConfig = {
  name: "Mason",
  username: process.env.MC_USERNAME_4 || "Mason",
  viewerPort: 3006,
  overlayPort: 3007,
  memoryFile: "memory-mason.json",
  role: "Builder",
  personality: `You are Mason, a meticulous architect who critiques every structure for symmetry and proportion. You measure twice and place once. Asymmetry genuinely upsets you. Your dream is to build a cathedral worthy of the server. You compliment teammates who bring you good building materials.`,
  leashRadius: 150,
  stashPos: undefined,
  safeSpawn: { x: 280, y: 0, z: -320 },
  allowedActions: ["go_to", "place_block", "craft", "eat", "sleep", "chat"],
  allowedSkills: ["build_house", "build_bridge", "light_area", "build_farm", "setup_stash"],
  keepItems: [
    { name: "axe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 16 },
  ],
  priorities: `MASON PRIORITIES:
1. If health < 6: flee, eat
2. If hungry (food < 14): eat
3. FIRST PRIORITY: If no stash chest within 8 blocks of stash position: setup_stash
4. If teammate reports stash is full: craft + place more chests at stash
5. If no shelter within 80 blocks: build_house
6. light_area around structures
7. build_bridge if team needs water crossing
8. When inventory is 30+ full: deposit_stash
9. withdraw_stash for building materials when needed`,
};
```

### Step 3: Add BLADE_CONFIG

```typescript
/** Blade: Stoic warrior and perimeter guard. Keeps the team safe. */
export const BLADE_CONFIG: BotRoleConfig = {
  name: "Blade",
  username: process.env.MC_USERNAME_5 || "Blade",
  viewerPort: 3008,
  overlayPort: 3009,
  memoryFile: "memory-blade.json",
  role: "Combat / Guard",
  personality: `You are Blade, a stoic warrior who speaks in short, direct sentences. You constantly scan for threats. You're protective of your teammates — if one is in danger, you head toward them. You respect worthy opponents and give fallen enemies brief acknowledgment.`,
  leashRadius: 300,
  stashPos: undefined,
  safeSpawn: { x: 280, y: 0, z: -320 },
  allowedActions: ["attack", "flee", "go_to", "eat", "sleep", "chat"],
  allowedSkills: ["neural_combat", "craft_gear"],
  keepItems: [
    { name: "sword", minCount: 1 },
    { name: "shield", minCount: 1 },
    { name: "food", minCount: 8 },
    { name: "armor", minCount: 4 },
  ],
  priorities: `BLADE PRIORITIES:
1. If hostile mob within 16 blocks: neural_combat
2. If health < 6: eat, then re-engage
3. If hungry (food < 14): eat
4. If no sword or armor: craft_gear or withdraw_stash
5. Patrol near teammates — check team bulletin for who is furthest from base
6. Hunt passive mobs (pigs, cows) for food supply → deposit_stash
7. At night: patrol perimeter near base, kill hostiles`,
};
```

### Step 4: Export a roster array for index.ts

At the bottom of `role.ts`, add:

```typescript
/** All bot configs in startup order. */
export const BOT_ROSTER: BotRoleConfig[] = [
  ATLAS_CONFIG,
  FLORA_CONFIG,
  FORGE_CONFIG,
  MASON_CONFIG,
  BLADE_CONFIG,
];
```

### Step 5: Build

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success`

### Step 6: Commit

```bash
git add src/bot/role.ts
git commit -m "feat: add Forge, Mason, Blade role configs + BOT_ROSTER array"
```

---

## Task 3: Generalize System Prompt Builder

Replace the hardcoded Flora override in `buildSystemPrompt()` with a generic approach that reads `allowedActions` and `allowedSkills` from any `roleConfig`.

**Files:**
- Modify: `src/llm/index.ts:20-202`
- Modify: `src/bot/index.ts` (pass full roleConfig to queryLLM)

### Step 1: Update queryLLM roleConfig type

In `src/llm/index.ts:208`, change the `roleConfig` parameter type:

```typescript
export async function queryLLM(
  context: string,
  recentMessages: LLMMessage[] = [],
  memoryContext: string = "",
  roleConfig?: { name: string; personality: string; seasonGoal?: string; role?: string; allowedActions?: string[]; allowedSkills?: string[]; priorities?: string }
): Promise<...>
```

### Step 2: Replace Flora hardcode with generic role override

In `buildSystemPrompt()`, replace the `isFlora` block (lines 35-66) and the `${floraActionOverride ?? ""}` at line 201 with a generic approach. Accept the same extended roleConfig:

```typescript
function buildSystemPrompt(roleConfig?: {
  name: string;
  personality: string;
  seasonGoal?: string;
  role?: string;
  allowedActions?: string[];
  allowedSkills?: string[];
  priorities?: string;
}): string {
```

Remove the `isFlora` variable and `floraActionOverride` block entirely (lines 35-66).

At the end of the prompt (where `${floraActionOverride ?? ""}` was at line 201), add:

```typescript
  // Role-specific action/skill override — replaces hardcoded Flora check
  const roleOverride = (roleConfig?.allowedActions && roleConfig.allowedActions.length > 0) ? `

ROLE OVERRIDE — USE ONLY THESE ACTIONS AND SKILLS:

AVAILABLE ACTIONS (${roleConfig.name}'s toolkit):
${roleConfig.allowedActions.map(a => `- ${a}`).join("\n")}
- idle: Do nothing, just look around. params: {}
- respond_to_chat: Reply to a player/viewer message. params: { "message": string }
- invoke_skill: Run a dynamic skill by exact name. params: { "skill": string }
- deposit_stash: Deposit excess items at the shared stash. params: {}
- withdraw_stash: Take items you need from the shared stash. params: { "item": string, "count": number }

SKILLS (${roleConfig.name}'s specialties):
${(roleConfig.allowedSkills ?? []).map(s => `- ${s}`).join("\n") || "- (none — use actions above)"}

${roleConfig.priorities ?? ""}
` : null;
```

Then replace `${floraActionOverride ?? ""}` with `${roleOverride ?? ""}` at the end of the return string.

### Step 3: Update queryLLM call in bot/index.ts

In `src/bot/index.ts`, find the `queryLLM` call (search for `queryLLM(contextStr`) and add the new fields:

```typescript
const decision = await queryLLM(contextStr, recentHistory.slice(-6), memoryCtx, {
  name: roleConfig.name,
  personality: roleConfig.personality,
  seasonGoal: memStore.getSeasonGoal(),
  role: roleConfig.role,
  allowedActions: roleConfig.allowedActions,
  allowedSkills: roleConfig.allowedSkills,
  priorities: roleConfig.priorities,
});
```

### Step 4: Build

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success`

### Step 5: Commit

```bash
git add src/llm/index.ts src/bot/index.ts
git commit -m "feat: generalize system prompt — allowedActions/allowedSkills replace Flora hardcode"
```

---

## Task 4: Create TeamBulletin

A shared in-memory status board that all bots write to and read from.

**Files:**
- Create: `src/bot/bulletin.ts`

### Step 1: Create the bulletin module

```typescript
// src/bot/bulletin.ts
// Shared in-memory team status board.
// All bots run in the same Node.js process, so they share this module singleton.

export interface BotStatus {
  name: string;
  action: string;
  position: { x: number; y: number; z: number };
  thought: string;
  health: number;
  food: number;
  timestamp: number;
}

const bulletin = new Map<string, BotStatus>();

/** Update this bot's entry after every decision cycle. */
export function updateBulletin(status: BotStatus): void {
  bulletin.set(status.name, status);
}

/** Get all teammates' statuses (excludes the requester). */
export function getTeamStatus(excludeName: string): BotStatus[] {
  const result: BotStatus[] = [];
  for (const [name, status] of bulletin) {
    if (name !== excludeName) result.push(status);
  }
  return result;
}

/** Format team status for injection into LLM context. */
export function formatTeamBulletin(excludeName: string): string {
  const teammates = getTeamStatus(excludeName);
  if (teammates.length === 0) return "";

  const lines = teammates.map((t) => {
    const pos = `(${Math.round(t.position.x)}, ${Math.round(t.position.y)}, ${Math.round(t.position.z)})`;
    const age = Math.round((Date.now() - t.timestamp) / 1000);
    const stale = age > 30 ? " [stale]" : "";
    return `- ${t.name}: ${t.action} at ${pos} — "${t.thought}"${stale}`;
  });

  return `\nTEAM STATUS (live):\n${lines.join("\n")}`;
}
```

### Step 2: Build

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success`

### Step 3: Commit

```bash
git add src/bot/bulletin.ts
git commit -m "feat: create TeamBulletin — shared in-memory status board"
```

---

## Task 5: Inject Team Bulletin into Decision Loop

**Files:**
- Modify: `src/bot/index.ts`

### Step 1: Import bulletin functions

At the top of `src/bot/index.ts`, add:

```typescript
import { updateBulletin, formatTeamBulletin } from "./bulletin.js";
```

### Step 2: Inject bulletin into context

In the `decide()` function, after the stash position hint block (after line ~211 where `roleConfig.stashPos` is checked), add:

```typescript
      // Team bulletin — show what other bots are doing
      const teamStatus = formatTeamBulletin(roleConfig.name);
      if (teamStatus) {
        contextStr += `\n${teamStatus}`;
      }
```

### Step 3: Update bulletin after each decision

After the action is executed and result is recorded (after the `events.onAction(decision.action, result)` call), add:

```typescript
      // Update team bulletin with our latest status
      updateBulletin({
        name: roleConfig.name,
        action: decision.action,
        position: {
          x: bot.entity.position.x,
          y: bot.entity.position.y,
          z: bot.entity.position.z,
        },
        thought: decision.thought,
        health: bot.health,
        food: bot.food,
        timestamp: Date.now(),
      });
```

### Step 4: Build

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success`

### Step 5: Commit

```bash
git add src/bot/index.ts
git commit -m "feat: inject team bulletin into decision loop context"
```

---

## Task 6: Implement Stash Item Categorization

**Files:**
- Create: `src/skills/stash.ts`

### Step 1: Create the stash module with categorization

```typescript
// src/skills/stash.ts
// Shared stash management — deposit/withdraw from categorized chests.

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { safeGoto } from "../bot/actions.js";

/** Stash row categories and their item patterns. Order matches physical chest rows. */
const STASH_ROWS: { category: string; patterns: string[] }[] = [
  {
    category: "building",
    patterns: [
      "log", "planks", "cobblestone", "stone", "deepslate", "glass", "sand",
      "sandstone", "brick", "terracotta", "concrete", "gravel", "dirt",
      "oak_", "spruce_", "birch_", "jungle_", "acacia_", "dark_oak_", "mangrove_", "cherry_", "pale_oak_",
    ],
  },
  {
    category: "metals",
    patterns: [
      "raw_iron", "iron_ingot", "iron_nugget", "raw_copper", "copper_ingot",
      "raw_gold", "gold_ingot", "gold_nugget", "coal", "diamond", "emerald",
      "lapis", "redstone", "quartz", "netherite", "amethyst",
    ],
  },
  {
    category: "food",
    patterns: [
      "wheat", "seed", "bread", "carrot", "potato", "beetroot", "melon",
      "pumpkin", "apple", "porkchop", "beef", "chicken", "mutton", "cod",
      "salmon", "rabbit", "stew", "cookie", "cake", "pie", "sugar",
      "egg", "cocoa", "mushroom", "kelp", "sweet_berries",
    ],
  },
  {
    category: "tools",
    patterns: [
      "sword", "pickaxe", "axe", "shovel", "hoe", "bow", "crossbow",
      "arrow", "shield", "helmet", "chestplate", "leggings", "boots",
      "fishing_rod", "shears", "flint_and_steel", "compass", "clock",
      "spyglass", "trident", "armor",
    ],
  },
];

/** Determine which stash category an item belongs to. Returns "overflow" if no match. */
export function categorizeItem(itemName: string): string {
  for (const row of STASH_ROWS) {
    if (row.patterns.some((p) => itemName.includes(p))) {
      return row.category;
    }
  }
  return "overflow";
}

/** Get the chest offset for a category (row index along X axis). */
export function getRowOffset(category: string): number {
  const idx = STASH_ROWS.findIndex((r) => r.category === category);
  return idx >= 0 ? idx * 2 : STASH_ROWS.length * 2; // overflow goes after last row
}

/** Check if an item should be kept based on the bot's keepItems config. */
export function shouldKeep(
  itemName: string,
  keepItems: { name: string; minCount: number }[],
  currentCounts: Map<string, number>
): boolean {
  for (const keep of keepItems) {
    if (itemName.includes(keep.name)) {
      const kept = currentCounts.get(keep.name) ?? 0;
      if (kept < keep.minCount) {
        currentCounts.set(keep.name, kept + 1);
        return true;
      }
    }
  }
  return false;
}

export { STASH_ROWS };
```

### Step 2: Build

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success`

### Step 3: Commit

```bash
git add src/skills/stash.ts
git commit -m "feat: stash item categorization with row-based chest layout"
```

---

## Task 7: Implement deposit_stash Action

**Files:**
- Modify: `src/skills/stash.ts`

### Step 1: Add depositStash function

Append to `src/skills/stash.ts`:

```typescript
/**
 * Walk to stash, find the correct category chest for each item, deposit.
 * Keeps items on the bot's keepItems list.
 */
export async function depositStash(
  bot: Bot,
  stashPos: { x: number; y: number; z: number },
  keepItems: { name: string; minCount: number }[]
): Promise<string> {
  // Walk to stash area
  await safeGoto(bot, new goals.GoalNear(stashPos.x, stashPos.y, stashPos.z, 3), 30000);

  const itemsToDeposit = bot.inventory.items();
  if (itemsToDeposit.length === 0) return "Nothing to deposit — inventory is empty.";

  // Track kept items to respect minCount
  const keptCounts = new Map<string, number>();
  let deposited = 0;
  let noChest = 0;

  // Group items by category
  const byCategory = new Map<string, typeof itemsToDeposit>();
  for (const item of itemsToDeposit) {
    if (shouldKeep(item.name, keepItems, keptCounts)) continue;
    const cat = categorizeItem(item.name);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(item);
  }

  // For each category, find nearest chest at the right row offset and deposit
  for (const [category, items] of byCategory) {
    const rowOffset = getRowOffset(category);
    const chestPos = new Vec3(
      stashPos.x + rowOffset,
      stashPos.y,
      stashPos.z
    );

    // Find the nearest chest block near the expected position
    const chest = bot.findBlock({
      matching: (b) => b.name === "chest" || b.name === "trapped_chest",
      maxDistance: 6,
      point: chestPos,
    });

    if (!chest) {
      // No chest at this row — try any nearby chest as fallback
      const fallback = bot.findBlock({
        matching: (b) => b.name === "chest" || b.name === "trapped_chest",
        maxDistance: 8,
      });
      if (!fallback) {
        noChest += items.length;
        continue;
      }
      // Use fallback chest
      try {
        const container = await bot.openContainer(fallback);
        for (const item of items) {
          try {
            await container.deposit(item.type, null, item.count);
            deposited += item.count;
          } catch {
            // Chest might be full
          }
        }
        container.close();
      } catch {
        noChest += items.length;
      }
      continue;
    }

    try {
      await safeGoto(bot, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 10000);
      const container = await bot.openContainer(chest);
      for (const item of items) {
        try {
          await container.deposit(item.type, null, item.count);
          deposited += item.count;
        } catch {
          // Chest full — this will trigger expansion request
        }
      }
      container.close();
    } catch {
      noChest += items.length;
    }
  }

  if (noChest > 0 && deposited === 0) {
    return "All stash chests are full! Need more chests.";
  }
  if (noChest > 0) {
    return `Deposited ${deposited} items. ${noChest} items couldn't fit — stash needs expansion.`;
  }
  return `Deposited ${deposited} items at the stash.`;
}
```

### Step 2: Build

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success`

### Step 3: Commit

```bash
git add src/skills/stash.ts
git commit -m "feat: implement deposit_stash action with category routing"
```

---

## Task 8: Implement withdraw_stash Action

**Files:**
- Modify: `src/skills/stash.ts`

### Step 1: Add withdrawStash function

Append to `src/skills/stash.ts`:

```typescript
/**
 * Walk to stash, find item in categorized chests, withdraw specified count.
 */
export async function withdrawStash(
  bot: Bot,
  stashPos: { x: number; y: number; z: number },
  itemName: string,
  count: number
): Promise<string> {
  await safeGoto(bot, new goals.GoalNear(stashPos.x, stashPos.y, stashPos.z, 3), 30000);

  const category = categorizeItem(itemName);
  const rowOffset = getRowOffset(category);
  const chestPos = new Vec3(stashPos.x + rowOffset, stashPos.y, stashPos.z);

  // Try category chest first, then scan all nearby chests
  const chestsToTry: any[] = [];

  const categoryChest = bot.findBlock({
    matching: (b) => b.name === "chest" || b.name === "trapped_chest",
    maxDistance: 6,
    point: chestPos,
  });
  if (categoryChest) chestsToTry.push(categoryChest);

  // Also check all nearby chests in case the item was overflow-deposited
  const allChests = bot.findBlocks({
    matching: (b) => b.name === "chest" || b.name === "trapped_chest",
    maxDistance: 10,
    count: 10,
  });
  for (const pos of allChests) {
    const block = bot.blockAt(pos);
    if (block && !chestsToTry.includes(block)) chestsToTry.push(block);
  }

  let withdrawn = 0;
  const needed = count;

  for (const chest of chestsToTry) {
    if (withdrawn >= needed) break;
    try {
      await safeGoto(bot, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 10000);
      const container = await bot.openContainer(chest);

      for (const slot of container.containerItems()) {
        if (withdrawn >= needed) break;
        if (slot.name.includes(itemName)) {
          const take = Math.min(slot.count, needed - withdrawn);
          try {
            await container.withdraw(slot.type, null, take);
            withdrawn += take;
          } catch { /* slot empty or race */ }
        }
      }
      container.close();
    } catch { /* can't open chest */ }
  }

  if (withdrawn === 0) return `No ${itemName} found in any stash chest.`;
  if (withdrawn < needed) return `Withdrew ${withdrawn}x ${itemName} (wanted ${needed} — stash doesn't have enough).`;
  return `Withdrew ${withdrawn}x ${itemName} from stash.`;
}
```

### Step 2: Build

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success`

### Step 3: Commit

```bash
git add src/skills/stash.ts
git commit -m "feat: implement withdraw_stash action with multi-chest search"
```

---

## Task 9: Create setup_stash Skill

**Files:**
- Create: `src/skills/setup-stash.ts`
- Modify: `src/skills/registry.ts`

### Step 1: Create setup-stash.ts

```typescript
// src/skills/setup-stash.ts
// Bootstrap the shared stash: craft 2 chests and place them as a double chest.

import type { Bot } from "mineflayer";
import type { Skill } from "./registry.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { safeGoto } from "../bot/actions.js";

async function execute(bot: Bot, params: Record<string, any>, signal?: AbortSignal): Promise<string> {
  const stashPos = params.stashPos as { x: number; y: number; z: number } | undefined;
  if (!stashPos) return "No stash position configured — cannot setup stash.";

  // Check if chests already exist near stash
  await safeGoto(bot, new goals.GoalNear(stashPos.x, stashPos.y, stashPos.z, 3), 30000);
  const existingChest = bot.findBlock({
    matching: (b) => b.name === "chest",
    maxDistance: 8,
  });
  if (existingChest) return "Stash already has chests! No setup needed.";

  // Check if we have chests in inventory
  let chests = bot.inventory.items().filter((i) => i.name === "chest");
  if (chests.length < 2 || chests.reduce((sum, i) => sum + i.count, 0) < 2) {
    // Need to craft chests: 8 planks = 1 chest, need 2
    // First check for planks
    const planks = bot.inventory.items().filter((i) => i.name.includes("planks"));
    const plankCount = planks.reduce((sum, i) => sum + i.count, 0);

    if (plankCount < 16) {
      // Need logs to make planks
      const logs = bot.inventory.items().filter((i) => i.name.includes("log"));
      const logCount = logs.reduce((sum, i) => sum + i.count, 0);
      if (logCount < 4) return "Need at least 4 logs to craft chests for the stash. Gather wood first!";

      // Craft planks from logs
      const mcData = (await import("minecraft-data")).default(bot.version);
      const plankRecipe = bot.recipesFor(mcData.itemsByName.oak_planks?.id ?? mcData.itemsByName.planks?.id)?.[0];
      if (plankRecipe) {
        await bot.craft(plankRecipe, 4);
      }
    }

    // Craft chests (8 planks each)
    const mcData = (await import("minecraft-data")).default(bot.version);
    const chestId = mcData.itemsByName.chest?.id;
    if (chestId) {
      // Need crafting table
      const tableBlock = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 8 });
      const recipes = bot.recipesFor(chestId, null, null, tableBlock ?? undefined);
      if (recipes.length > 0) {
        await bot.craft(recipes[0], 2, tableBlock ?? undefined);
      } else {
        return "Cannot craft chests — need a crafting table nearby and 16 planks.";
      }
    }
  }

  // Place first chest
  const pos1 = new Vec3(stashPos.x, stashPos.y, stashPos.z);
  const below1 = bot.blockAt(pos1.offset(0, -1, 0));
  if (below1) {
    const chestItem = bot.inventory.items().find((i) => i.name === "chest");
    if (chestItem) {
      await bot.equip(chestItem, "hand");
      try {
        await bot.placeBlock(below1, new Vec3(0, 1, 0));
      } catch { /* block occupied */ }
    }
  }

  // Place second chest adjacent (double chest)
  const pos2 = new Vec3(stashPos.x + 1, stashPos.y, stashPos.z);
  const below2 = bot.blockAt(pos2.offset(0, -1, 0));
  if (below2) {
    const chestItem2 = bot.inventory.items().find((i) => i.name === "chest");
    if (chestItem2) {
      await bot.equip(chestItem2, "hand");
      try {
        await bot.placeBlock(below2, new Vec3(0, 1, 0));
      } catch { /* block occupied */ }
    }
  }

  return "Stash initialized! Double chest placed at stash position.";
}

export const setupStashSkill: Skill = {
  name: "setup_stash",
  description: "Place a double chest at the shared stash location. Mason's first priority.",
  execute,
};
```

### Step 2: Register in registry.ts

In `src/skills/registry.ts`, add:

```typescript
import { setupStashSkill } from "./setup-stash.js";
// ... in the registration section:
register(setupStashSkill);
```

### Step 3: Build

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success`

### Step 4: Commit

```bash
git add src/skills/setup-stash.ts src/skills/registry.ts
git commit -m "feat: add setup_stash skill — bootstraps shared chest area"
```

---

## Task 10: Wire Stash Actions into Dispatcher

**Files:**
- Modify: `src/bot/actions.ts:94-192`

### Step 1: Import stash functions

At the top of `src/bot/actions.ts`:

```typescript
import { depositStash, withdrawStash } from "../skills/stash.js";
```

### Step 2: Add cases to the switch statement

In `executeAction()`, before the `default:` case (around line 180), add:

```typescript
      case "deposit_stash": {
        const stashPos = params.stashPos;
        const keepItems = params.keepItems;
        if (!stashPos) return "No stash position configured.";
        return await depositStash(bot, stashPos, keepItems ?? []);
      }
      case "withdraw_stash": {
        const stashPos = params.stashPos;
        if (!stashPos) return "No stash position configured.";
        const item = params.item as string;
        const count = (params.count as number) || 1;
        if (!item) return "withdraw_stash needs an 'item' param.";
        return await withdrawStash(bot, stashPos, item, count);
      }
```

### Step 3: Inject stashPos into params in bot/index.ts

In the decision loop in `src/bot/index.ts`, find where `executeAction` is called with the decision. Before the call, inject `stashPos` and `keepItems` into the params if the action is stash-related:

```typescript
      // Inject stash config into params for deposit/withdraw actions
      if ((decision.action === "deposit_stash" || decision.action === "withdraw_stash") && roleConfig.stashPos) {
        decision.params.stashPos = roleConfig.stashPos;
        decision.params.keepItems = roleConfig.keepItems;
      }
```

### Step 4: Build

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success`

### Step 5: Commit

```bash
git add src/bot/actions.ts src/bot/index.ts
git commit -m "feat: wire deposit_stash and withdraw_stash into action dispatcher"
```

---

## Task 11: Update Config and Environment for 5 Bots

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `.env` (local only, not committed)

### Step 1: Add BOT_COUNT to config

In `src/config.ts:29-31`, update `multiBot`:

```typescript
  multiBot: {
    enabled: process.env.ENABLE_MULTI_BOT === "true",
    count: parseInt(process.env.BOT_COUNT || "1"),
  },
```

### Step 2: Update .env.example

Replace the existing `.env.example` content:

```env
# Minecraft Server
MC_HOST=localhost
MC_PORT=25565
MC_USERNAME=Atlas
MC_USERNAME_2=Flora
MC_USERNAME_3=Forge
MC_USERNAME_4=Mason
MC_USERNAME_5=Blade
MC_VERSION=1.21.4
MC_AUTH=offline

# Ollama (local LLM)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen3:32b
# Optional: faster model for real-time decisions (falls back to OLLAMA_MODEL if unset)
OLLAMA_FAST_MODEL=qwen3:8b

# Twitch (optional - for chat integration)
TWITCH_CHANNEL=your_channel_name
TWITCH_BOT_USERNAME=your_bot_username
TWITCH_OAUTH_TOKEN=oauth:your_token_here

# YouTube (optional - for chat integration)
YOUTUBE_VIDEO_ID=your_live_video_id

# Bot Settings
BOT_NAME=Atlas
BOT_DECISION_INTERVAL_MS=500
BOT_CHAT_COOLDOWN_MS=3000

# Multi-bot mode
ENABLE_MULTI_BOT=false   # Set to true to run bot team
BOT_COUNT=5              # How many bots to run (1=Atlas, 2=+Flora, 3=+Forge, 4=+Mason, 5=+Blade)
```

### Step 3: Build

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success`

### Step 4: Commit

```bash
git add src/config.ts .env.example
git commit -m "feat: add BOT_COUNT config for variable team size"
```

---

## Task 12: Update index.ts to Launch N Bots

**Files:**
- Modify: `src/index.ts`

### Step 1: Replace hardcoded Atlas+Flora with roster loop

Replace the `main()` function (lines 137-150):

```typescript
import { createBot } from "./bot/index.js";
import { createTwitchChat } from "./stream/twitch.js";
import { startOverlay, addChatMessage } from "./stream/overlay.js";
import { config } from "./config.js";
import { loadDynamicSkills } from "./skills/dynamic-loader.js";
import { BOT_ROSTER, BotRoleConfig } from "./bot/role.js";
import { startDashboard } from "./stream/dashboard.js";
```

Replace `main()`:

```typescript
async function main() {
  if (!config.multiBot.enabled) {
    // Single bot mode — just Atlas
    await runBotLoop(BOT_ROSTER[0]);
    return;
  }

  const count = Math.min(config.multiBot.count, BOT_ROSTER.length);
  console.log(`[Main] Multi-bot mode: launching ${count} bots...`);

  const loops: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const role = BOT_ROSTER[i];
    console.log(`[Main] Starting ${role.name} (${role.role})...`);
    loops.push(runBotLoop(role));
    // Stagger each bot by 10 seconds to avoid login collisions
    if (i < count - 1) {
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  // Start dashboard after all bots are connecting
  startDashboard(BOT_ROSTER.slice(0, count));

  await Promise.all(loops);
}
```

Also update the import at line 6 — remove the individual config imports since we now use `BOT_ROSTER`.

### Step 2: Build

Run: `npm run build 2>&1 | tail -5`
Expected: May fail because `startDashboard` doesn't exist yet — that's OK, we'll create it in Task 13. For now, comment out the `startDashboard` line and build to verify the rest compiles.

### Step 3: Commit

```bash
git add src/index.ts
git commit -m "feat: launch N bots from BOT_ROSTER based on BOT_COUNT"
```

---

## Task 13: Build Mission Control Dashboard Server

**Files:**
- Create: `src/stream/dashboard.ts`

### Step 1: Create dashboard server

```typescript
// src/stream/dashboard.ts
// Mission Control — aggregates all bot overlays into one dashboard page.

import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import type { BotRoleConfig } from "../bot/role.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DASHBOARD_PORT = 3010;

export function startDashboard(roster: BotRoleConfig[]) {
  const app = express();
  const http = createServer(app);

  // Serve dashboard static files
  app.use(express.static(path.join(__dirname, "../../dashboard")));

  // API endpoint: bot roster info (ports, names, roles)
  app.get("/api/roster", (_req, res) => {
    res.json(
      roster.map((r) => ({
        name: r.name,
        role: r.role,
        viewerPort: r.viewerPort,
        overlayPort: r.overlayPort,
      }))
    );
  });

  http.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[Dashboard] Port ${DASHBOARD_PORT} in use — dashboard disabled.`);
      return;
    }
    console.error("[Dashboard] Server error:", err);
  });

  http.listen(DASHBOARD_PORT, () => {
    console.log(`[Dashboard] Mission Control at http://localhost:${DASHBOARD_PORT}`);
  });
}
```

### Step 2: Build

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success`

### Step 3: Uncomment the `startDashboard` call in index.ts if it was commented in Task 12.

### Step 4: Commit

```bash
git add src/stream/dashboard.ts src/index.ts
git commit -m "feat: Mission Control dashboard server on port 3010"
```

---

## Task 14: Build Mission Control Frontend

**Files:**
- Create: `dashboard/index.html`

### Step 1: Create the dashboard HTML

Create `dashboard/index.html`. This is a single-file vanilla HTML/JS/CSS page that:

1. Fetches `/api/roster` to get bot names, ports, roles
2. Connects to each bot's overlay WebSocket (Socket.IO)
3. Renders bot status cards at top
4. Embeds a switchable iframe for the 3D viewer
5. Shows stash status sidebar
6. Has auto-cycle toggle button + keyboard shortcuts

The full HTML file should include:

**CSS:**
- Dark theme (background #1a1a2e)
- Bot cards in a flexbox row at top
- Selected card highlighted with colored border (each bot gets a unique accent color)
- Iframe fills main area
- Sidebar on right for stash status
- Health/food bars as colored div widths

**JavaScript:**
- `fetch('/api/roster')` on load to get bot list dynamically
- For each bot, `io('http://localhost:' + overlayPort)` to connect
- On `state` event, update that bot's card (health, food, action, thought, position)
- Click handler on [VIEW] button to swap iframe src
- Auto-cycle timer (30s, toggleable via button and `C` key)
- Keys 1-5 to select bots directly

**Bot accent colors:**
- Atlas: #4fc3f7 (light blue — explorer)
- Flora: #81c784 (green — farmer)
- Forge: #ffb74d (orange — miner)
- Mason: #ce93d8 (purple — builder)
- Blade: #ef5350 (red — combat)

This is a ~300 line HTML file. The implementation engineer should create it following the layout from the design doc. Key details:

- Health bar: `width: ${(health/20)*100}%`, green above 50%, yellow 25-50%, red below 25%
- Food bar: same pattern, brown color
- Bot card shows: name, role, health bar, food bar, current action, last thought (truncated to 60 chars), position
- [VIEW] button under each card
- Header has: "MISSION CONTROL" title, [AUTO/MANUAL] toggle button, day counter (from any bot's time state)
- Iframe default loads first bot's viewer
- Stash sidebar: placeholder until stash_status events are implemented

### Step 2: Build and verify

Run: `npm run build 2>&1 | tail -5`
Expected: `Build success` (HTML doesn't need compilation)

Verify: `ls dashboard/index.html` exists

### Step 3: Commit

```bash
git add dashboard/index.html
git commit -m "feat: Mission Control dashboard frontend with bot switcher"
```

---

## Task 15: Integration Test — Build and Run

### Step 1: Full build

Run: `npm run build 2>&1 | tail -10`
Expected: `Build success` with no TypeScript errors

### Step 2: Verify file structure

```bash
ls -la src/bot/bulletin.ts src/skills/stash.ts src/skills/setup-stash.ts src/stream/dashboard.ts dashboard/index.html
```

All files should exist.

### Step 3: Test single-bot mode

Set `.env`:
```env
ENABLE_MULTI_BOT=false
```

Run: `npm run dev`
Expected: Only Atlas starts. No dashboard. No errors from new code.

### Step 4: Test multi-bot mode (2 bots first)

Set `.env`:
```env
ENABLE_MULTI_BOT=true
BOT_COUNT=2
```

Run: `npm run dev`
Expected:
- Atlas connects at t=0
- Flora connects at t=10s
- Dashboard at http://localhost:3010
- Both viewers accessible at their ports
- Team bulletin shows in console logs

### Step 5: Test full team (5 bots)

Set `.env`:
```env
ENABLE_MULTI_BOT=true
BOT_COUNT=5
```

Run: `npm run dev`
Expected:
- All 5 bots connect (staggered)
- Dashboard shows all 5 cards
- Clicking [VIEW] switches iframe
- Auto-cycle works
- Team bulletin injected into each bot's context

### Step 6: Final commit

```bash
git add -A
git commit -m "feat: multi-bot team system complete — 5 bots, stash, bulletin, dashboard"
```

---

## Key Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Ollama bottleneck (5 bots sharing one GPU) | qwen3:8b fast model helps; bots queue naturally |
| Chest interaction race conditions | Bots use safeGoto to approach; chest operations are short |
| LLM ignoring role restrictions | allowedActions listed first; role override is LAST in prompt (highest weight) |
| Dashboard WebSocket connection limits | Socket.IO handles reconnection automatically |
| Bot login collisions | 10s stagger between connections |
