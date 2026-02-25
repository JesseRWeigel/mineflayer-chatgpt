# Multi-Bot Team Design — 5 Specialized Bots

**Date:** 2026-02-25
**Status:** Approved, pending implementation

**Goal:** Expand from 2 bots (Atlas + Flora) to 5 specialized bots that share a base, coordinate through shared context, and manage resources through a central stash. Add a Mission Control dashboard for monitoring all bots simultaneously.

**Architecture:** Each bot gets a `BotRoleConfig` with `allowedActions[]` and `allowedSkills[]` (replacing the hardcoded Flora override). A shared in-memory `TeamBulletin` gives each bot awareness of teammates. A central stash with categorized chests enables resource flow between specialists. A dashboard page connects to all overlay WebSockets for at-a-glance monitoring.

**Tech Stack:** Mineflayer, Ollama (qwen3:32b + qwen3:8b), TypeScript/tsup, Node.js, Socket.IO, Express

---

## Bot Roster

| Bot | Role | Leash | Allowed Actions | Allowed Skills |
|-----|------|-------|----------------|---------------|
| **Atlas** | Scout / Explorer | 500 | explore, go_to, gather_wood, mine_block, chat, eat, sleep, flee, attack | (navigation-only — no built-in skills) |
| **Flora** | Farmer / Crafter | 100 | craft, eat, sleep, go_to, place_block, chat | build_farm, craft_gear, smelt_ores, light_area |
| **Forge** | Miner / Smelter | 250 | mine_block, go_to, eat, sleep, craft, chat, flee | strip_mine, smelt_ores, craft_gear |
| **Mason** | Builder | 150 | go_to, place_block, craft, eat, sleep, chat | build_house, build_bridge, light_area, build_farm, setup_stash |
| **Blade** | Combat / Guard | 300 | attack, flee, go_to, eat, sleep, chat | neural_combat, craft_gear |

All bots also get: `idle`, `respond_to_chat`, `invoke_skill` (for relevant Voyager/generated skills).

### Personalities

- **Atlas:** Fearless explorer who names every cave and mountain. Narrates adventures like a nature documentary. Gets emotionally attached to ore veins.
- **Flora:** Nurturing farmer obsessed with efficiency. Names every animal and crop. Scolds other bots about eating vegetables.
- **Forge:** Gruff dwarf-like miner who talks to rocks. Deeply respectful of ore veins. Judges surface-dwellers. Loves the sound of pickaxes.
- **Mason:** Meticulous architect who critiques every structure. Measures twice, places once. Gets genuinely upset about asymmetry. Dreams of building a cathedral.
- **Blade:** Stoic warrior who speaks in short sentences. Constantly scanning for threats. Protective of teammates. Respects worthy opponents.

---

## Team Bulletin (Shared Context)

A lightweight in-memory `Map<string, BotStatus>` that each bot writes to after every decision cycle. All bots run in the same Node.js process, so they share the reference directly.

### BotStatus shape

```typescript
interface BotStatus {
  name: string;
  action: string;
  position: { x: number; y: number; z: number };
  thought: string;
  health: number;
  timestamp: number;
}
```

### Injected into each bot's LLM prompt

```
TEAM STATUS (live):
- Atlas: exploring north at (450, 72, -280) — "Found a massive cave system!"
- Flora: running build_farm at (285, 65, -318) — "Planting wheat row 3 of 4"
- Forge: running strip_mine at (290, 11, -315) — "Mining iron ore vein"
- Mason: running build_house at (282, 66, -322) — "Placing roof blocks"
- Blade: patrolling at (300, 68, -310) — "No hostiles nearby, all clear"
```

~50 tokens per bot, ~250 tokens total. Always included. No task assignment, no commands — just awareness that enables natural coordination.

### What this enables

- Flora sees Forge deposited raw iron -> decides to smelt it
- Mason sees Atlas discovered a good building spot -> goes there
- Blade sees Flora farming at night -> patrols near her
- Forge sees Atlas found an ore vein -> heads that direction

### What it does NOT do (intentionally)

- No task assignment or commands between bots
- No shared inventory tracking (bots check stash chests themselves)
- No voting or consensus
- No coordinator bot

---

## Shared Stash

All 5 bots share a cluster of chests at a known coordinate near the base center.

### New Actions

- `deposit_stash` — Walk to stash, open correct category chest, deposit all items except keep-list
- `withdraw_stash` — Walk to stash, open relevant category chest, take items needed for current goal

### Keep Lists (items NOT deposited)

| Bot | Always Keeps |
|-----|-------------|
| Atlas | sword, food (4+), torches (8+) |
| Flora | hoe, food (4+), seeds |
| Forge | pickaxe, food (4+), torches (8+), bucket |
| Mason | axe, food (4+), torches (16+) |
| Blade | sword, shield, food (8+), armor |

### Stash Bootstrap

Mason handles initial stash setup. On first spawn, if no chest exists within 8 blocks of `stashPos`:

1. Gather 2 logs -> craft 8 planks -> craft 2 chests
2. Go to stash coordinates
3. Place double chest (2 chests side by side = 54 slots)

This is a new built-in skill: `setup_stash`.

### Stash Expansion

Any bot that tries `deposit_stash` and finds all chests full logs a message in the team bulletin:

```
- Forge: deposit_stash FAILED — "All stash chests are full! Need more chests."
```

Mason sees this and has a standing priority rule to craft + place additional double chests adjacent to the existing row.

### Stash Organization (Row-Based)

```
STASH LAYOUT (rows along X axis from stash origin):
  Row 1 (closest): Building materials — logs, planks, cobblestone, glass
  Row 2: Metals & ores — raw iron, iron ingots, copper, gold, coal
  Row 3: Food & farming — wheat, seeds, bread, raw meat, cooked meat
  Row 4: Tools & combat — swords, pickaxes, armor, bows, arrows
  Row 5+: Overflow — anything that doesn't fit above
```

Item categorization is a code-level lookup map:

```typescript
const STASH_CATEGORIES: Record<string, string[]> = {
  building: ["oak_log", "oak_planks", "cobblestone", "stone", "glass", ...],
  metals:   ["raw_iron", "iron_ingot", "raw_copper", "coal", "gold_ingot", ...],
  food:     ["wheat", "wheat_seeds", "bread", "cooked_porkchop", ...],
  tools:    ["iron_sword", "iron_pickaxe", "bow", "arrow", "shield", ...],
};
```

Items not in the map go to overflow (Row 5). No item frames, signs, or hoppers.

---

## Mission Control Dashboard

Single HTML page at `http://localhost:3010`.

### Layout

```
+-------------------------------------------------------------+
|  MISSION CONTROL                       [AUTO] [day 47]       |
+---------+---------+---------+---------+---------+------------+
|  Atlas  |  Flora  |  Forge  |  Mason  |  Blade  |            |
|  health |  health |  health |  health |  health |            |
| explore |build_farm|strip_mine|build_house| patrol |            |
| "Found a|"Planting|"Hit iron|"Roof is |"All    |            |
|  ravine"|  row 3" |  vein!" |  done!" | clear" |            |
| (450,72)|(285,65) |(290,11) |(282,66) |(300,68)|            |
|  [VIEW] |  [VIEW] |  [VIEW] |  [VIEW] |  [VIEW] |            |
+---------+---------+---------+---------+---------+   STASH    |
|                                                  |  STATUS   |
|              3D VIEWER (iframe)                   |           |
|                                                  | Bldg: 38  |
|         Switches to selected bot's               | Metal: 52 |
|         prismarine viewer port                   | Food: 24  |
|                                                  | Tool: 18  |
|                                                  | Free: 112 |
+--------------------------------------------------+-----------+
```

### Implementation

- New Express server on port 3010 serving `dashboard/index.html`
- Connects to ALL 5 overlay WebSockets simultaneously
- Bot cards update in real-time: health, food, current action, last thought, position
- Clicking [VIEW] swaps iframe src to that bot's viewer port
- Selected bot card gets highlight border
- [AUTO] button toggles auto-cycle (30s per bot). Keyboard `C` also toggles.
- Keyboard 1-5 to switch bots directly
- Right sidebar shows stash inventory summary via `stash_status` overlay event
- Vanilla JS + Socket.IO client, no build step, no framework

### Port Allocation

| Bot | Viewer Port | Overlay Port |
|-----|------------|-------------|
| Atlas | 3000 | 3001 |
| Flora | 3002 | 3003 |
| Forge | 3004 | 3005 |
| Mason | 3006 | 3007 |
| Blade | 3008 | 3009 |
| Dashboard | 3010 | — |

---

## BotRoleConfig Changes

```typescript
export interface BotRoleConfig {
  // Existing fields
  name: string;
  username: string;
  viewerPort: number;
  overlayPort: number;
  memoryFile: string;
  personality: string;
  role: string;
  homePos?: { x: number; y: number; z: number };
  leashRadius: number;
  stashPos?: { x: number; y: number; z: number };
  safeSpawn?: { x: number; y: number; z: number };

  // New fields
  allowedActions: string[];    // Actions this bot can use
  allowedSkills: string[];     // Built-in skills this bot can invoke
  keepItems: { name: string; minCount: number }[];  // Items to keep when depositing
  priorities: string;          // Priority rules injected into system prompt
}
```

This replaces the hardcoded `if (name === "Flora")` check in `buildSystemPrompt()`. The prompt builder reads `allowedActions` and `allowedSkills` generically for any bot.

---

## Environment Changes

```env
MC_USERNAME=Atlas
MC_USERNAME_2=Flora
MC_USERNAME_3=Forge
MC_USERNAME_4=Mason
MC_USERNAME_5=Blade

ENABLE_MULTI_BOT=true
BOT_COUNT=5          # 1=Atlas only, 2=+Flora, 3-5=additional bots
```

`BOT_COUNT` allows running a subset during development. Startup staggers each bot by 10 seconds.

### Server Requirements

- MC server needs 5+ player slots
- All 5 usernames must be `/op`'d
- Ollama handles requests sequentially (one GPU) — fast model (qwen3:8b) keeps latency reasonable
- ~11 ports used (3000-3010)

---

## Startup Sequence

```
t=0s   Atlas connects
t=10s  Flora connects
t=20s  Forge connects
t=30s  Mason connects
t=40s  Blade connects
t=50s  Dashboard server starts on :3010
```

Each bot runs its own independent `runBotLoop()` with its own restart counter and memory file.

---

## Files to Create

- `src/bot/bulletin.ts` — TeamBulletin shared state
- `src/skills/setup-stash.ts` — Bootstrap stash skill
- `src/skills/stash.ts` — deposit_stash / withdraw_stash actions + item categorization
- `src/stream/dashboard.ts` — Dashboard Express server
- `dashboard/index.html` — Mission Control frontend

## Files to Modify

- `src/bot/role.ts` — Add Forge/Mason/Blade configs, add allowedActions/allowedSkills/keepItems/priorities fields
- `src/bot/index.ts` — Inject team bulletin into context, write to bulletin after each decision
- `src/llm/index.ts` — Replace Flora hardcode with generic allowedActions/allowedSkills from roleConfig
- `src/bot/actions.ts` — Add deposit_stash/withdraw_stash action routing
- `src/index.ts` — Launch up to 5 bots based on BOT_COUNT, start dashboard server
- `src/config.ts` — Add BOT_COUNT config
- `.env.example` — Add MC_USERNAME_3/4/5, BOT_COUNT
- `README.md` — Full update for multi-bot system

---

## What We're NOT Building

- No coordinator bot or task assignment system
- No shared inventory database — bots check chests directly
- No item frame labels or signs on chests
- No hopper/redstone sorting systems
- No inter-bot chat commands or protocols
- No reservation system for stash items
