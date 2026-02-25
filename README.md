# Atlas — Autonomous AI Minecraft Bot Team

A team of autonomous AI agents that play Minecraft together, powered by a local LLM (Ollama) with a hybrid skill system: hand-crafted TypeScript skills, 57 Voyager-style JavaScript skills, and dynamic skill generation at runtime.

Each bot specializes in a different area — exploring, farming, mining, building, or combat — and they coordinate through shared context and a central resource stash.

Designed for live streaming: includes a Mission Control dashboard, per-bot 3D viewers, OBS overlays, TTS, and Twitch integration.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Decision Loop (per bot, 500ms)            │
│  World Context + Team Bulletin → LLM (qwen3:32b) → Action  │
└────────────────────────┬────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   TypeScript Skills  Voyager Skills  Neural Combat
   (build_house,      (57 JS skills   (Python TCP server
    craft_gear,        in vm sandbox)  heuristic policy)
    strip_mine, …)
          │              │              │
          └──────────────┴──────────────┘
                         │
          ┌──────────────▼──────────────┐
          │     Per-Bot Memory (.json)  │
          │  (structures, deaths, ores, │
          │   skill success rates)      │
          └──────────────┬──────────────┘
                         │
          ┌──────────────▼──────────────┐
          │     Team Bulletin (shared)  │
          │  (each bot's action, pos,   │
          │   thought — injected into   │
          │   every LLM prompt)         │
          └─────────────────────────────┘
```

### Bot Team

| Bot | Role | Specialty | Leash Radius |
|-----|------|-----------|-------------|
| **Atlas** | Scout / Explorer | Roams far, discovers ores/biomes, maps terrain | 500 blocks |
| **Flora** | Farmer / Crafter | Grows crops, breeds animals, processes materials | 100 blocks |
| **Forge** | Miner / Smelter | Strip mines, digs tunnels, smelts ores | 250 blocks |
| **Mason** | Builder | Builds houses, bridges, lights areas, manages stash | 150 blocks |
| **Blade** | Combat / Guard | Patrols perimeter, kills hostiles, hunts animals | 300 blocks |

Each bot has its own personality, allowed actions, allowed skills, memory file, and leash radius. They share a central stash of chests for resource exchange and see each other's status via the Team Bulletin.

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Decision loop | `src/bot/index.ts` | LLM query → action every 500ms |
| Role configs | `src/bot/role.ts` | Per-bot personality, actions, skills, leash |
| Team bulletin | `src/bot/bulletin.ts` | Shared status between bots |
| World perception | `src/bot/perception.ts` | Builds context string for LLM |
| Action executor | `src/bot/actions.ts` | Routes JSON actions to implementations |
| LLM client | `src/llm/index.ts` | Ollama API with retry + JSON repair |
| Skill executor | `src/skills/executor.ts` | Runs skills with abort support |
| Voyager loader | `src/skills/dynamic-loader.ts` | Runs JS skills in vm sandbox |
| Skill generator | `src/skills/generator.ts` | LLM generates new JS skills |
| Memory | `src/bot/memory.ts` | Per-bot persistent JSON |
| Stash actions | `src/skills/stash.ts` | Deposit/withdraw from shared chests |
| Neural combat | `src/neural/combat.ts` | 50ms tick loop using TCP server |
| Neural server | `neural_server.py` | Python heuristic/VPT policy server |
| Dashboard | `src/stream/dashboard.ts` | Mission Control on port 3010 |
| Stream viewer | `src/stream/viewer.ts` | Per-bot prismarine-viewer |
| OBS overlay | `src/stream/overlay.ts` | Per-bot WebSocket overlay for OBS |
| TTS | `src/stream/tts.ts` | Text-to-speech for bot thoughts |
| Safety filter | `src/safety/filter.ts` | Blocks harmful chat/thoughts |

---

## Setup

### Requirements

- Node.js 20+
- [Ollama](https://ollama.ai) with `qwen3:32b` pulled (+ optionally `qwen3:8b` for fast decisions)
- Minecraft Java Edition server (1.21.4) with 5+ player slots
- Python 3.10+ (for neural combat server)

### Install

```bash
git clone https://github.com/JesseRWeigel/mineflayer-chatgpt.git
cd mineflayer-chatgpt
npm install
pip install -r requirements.txt   # for neural server
```

### Configure

Create a `.env` file:

```env
# Minecraft server
MC_HOST=localhost
MC_PORT=25565
MC_USERNAME=Atlas
MC_USERNAME_2=Flora
MC_USERNAME_3=Forge
MC_USERNAME_4=Mason
MC_USERNAME_5=Blade
MC_VERSION=1.21.4
MC_AUTH=offline

# LLM (Ollama)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen3:32b
OLLAMA_FAST_MODEL=qwen3:8b   # Optional: faster model for real-time decisions

# Bot identity
BOT_NAME=Atlas
BOT_DECISION_INTERVAL_MS=500
BOT_CHAT_COOLDOWN_MS=3000

# Multi-bot mode
ENABLE_MULTI_BOT=true
BOT_COUNT=5                   # 1=Atlas only, 2=+Flora, 5=all bots

# Twitch (optional)
TWITCH_CHANNEL=your_channel
TWITCH_BOT_USERNAME=your_bot
TWITCH_OAUTH_TOKEN=oauth:...
```

### Run

```bash
# Start Minecraft server first, then:
npm run dev
```

The bots will:
1. Connect to the Minecraft server (staggered 10s apart)
2. Start the neural combat server automatically
3. Open per-bot 3D viewers (Atlas at `:3000`, Flora at `:3002`, etc.)
4. Start Mission Control dashboard at `http://localhost:3010`
5. Begin autonomous decision loops

> **Note:** All bot usernames must be operators on the server (e.g. `/op Atlas`, `/op Flora`, etc.) so they can set gamerules at startup.

### Single-Bot Mode

To run just Atlas (original single-bot behavior):

```env
ENABLE_MULTI_BOT=false
```

---

## Features

### Multi-Bot Team Coordination

The 5 bots coordinate through **shared context** — no coordinator bot, no task assignment. Each bot's LLM prompt includes a Team Bulletin showing what every other bot is doing:

```
TEAM STATUS (live):
- Atlas: exploring north at (450, 72, -280) — "Found a massive cave system!"
- Flora: running build_farm at (285, 65, -318) — "Planting wheat row 3"
- Forge: running strip_mine at (290, 11, -315) — "Mining iron ore vein"
- Mason: running build_house at (282, 66, -322) — "Placing roof blocks"
- Blade: patrolling at (300, 68, -310) — "All clear"
```

This enables natural coordination: Flora sees Forge deposited raw iron and decides to smelt it. Mason sees Atlas found a good building spot and heads there. Blade sees Flora farming at night and patrols near her.

### Shared Stash

All bots share a central stash of categorized chests:

| Row | Category | Example Items |
|-----|----------|--------------|
| 1 | Building | logs, planks, cobblestone, glass |
| 2 | Metals & Ores | raw iron, iron ingots, copper, coal |
| 3 | Food & Farming | wheat, seeds, bread, cooked meat |
| 4 | Tools & Combat | swords, pickaxes, armor, arrows |
| 5+ | Overflow | anything else |

Mason bootstraps the first chest on spawn. When chests fill up, Mason crafts and places more. Bots deposit excess items and withdraw what they need via `deposit_stash` / `withdraw_stash` actions.

### Mission Control Dashboard

Access at `http://localhost:3010` — a single page showing all bots at a glance:

- **Bot cards** at top: real-time health, current action, last thought, position
- **3D viewer** in center: click any bot to switch the live view
- **Stash status** sidebar: inventory summary across all stash chests
- **Auto-cycle** button: toggles automatic switching between bots (30s each)
- **Keyboard shortcuts**: 1-5 to select a bot, C to toggle auto-cycle

### Port Allocation

| Bot | 3D Viewer | Overlay |
|-----|-----------|---------|
| Atlas | :3000 | :3001 |
| Flora | :3002 | :3003 |
| Forge | :3004 | :3005 |
| Mason | :3006 | :3007 |
| Blade | :3008 | :3009 |
| Dashboard | :3010 | — |

### Autonomous Decision Making

Every 500ms, each bot:
1. Gathers world context (health, position, inventory, nearby entities/blocks, time)
2. Reads team bulletin (what other bots are doing)
3. Queries the local LLM with context + memory + role-specific prompt
4. Executes the chosen action (restricted to its allowed actions/skills)
5. Records success/failure and updates memory + team bulletin

**Stuck detection:** If the same action fails 2+ times in a row, the bot is forced to choose a different approach. Failed actions are injected into the next prompt.

**Goal persistence:** The LLM can set multi-step goals (e.g., "build a house") with a step count. The bot tracks progress across decision cycles.

**Leash enforcement:** Each bot has a max distance from home. At 80% of leash radius, the LLM is warned. At 150%, the bot is force-navigated home.

### Skill System

**TypeScript skills** (assigned per role):
- `build_house` — build a 7x7 shelter with doors, crafting table, torches
- `build_farm` — hoe dirt, plant wheat near water, harvest when ready
- `build_bridge` — bridge across water/gaps in facing direction
- `craft_gear` — craft best available tools and armor
- `strip_mine` — horizontal mining tunnel at current Y
- `smelt_ores` — smelt raw ore into ingots, crafts furnace if needed
- `light_area` — place torches in a radius
- `go_fishing` — cast and reel a fishing rod
- `setup_stash` — bootstrap shared chest area
- `neural_combat` — 50ms tick reactive combat via Python server

**Voyager JS skills** (57 skills, run in vm sandbox):
- Crafting: `craftWoodenPickaxe`, `craftIronPickaxe`, `craftCraftingTable`, `craftFurnace`, `craftChest`, `craftBucket`, and more
- Mining: `mineWoodLog`, `mineFiveCoalOres`, `mineFiveIronOres`, `mineTenCobblestone`, and more
- Smelting: `smeltFiveRawIron`, `smeltRawCopper`, and more
- Combat: `killOnePig`, `killOneZombie`, `killFourSheep`, and more
- Gathering: `collectBamboo`, `collectFiveCactusBlocks`, `fillBucketWithWater`

**Dynamic skill generation:** Bots can generate new JS skills at runtime when existing skills don't cover a task. Generated skills are saved to `skills/generated/` and reused.

### Persistent Memory

Each bot has its own memory file (e.g. `memory-atlas.json`, `memory-forge.json`):
- **Structures:** Location and type of every house/farm/furnace/mine built
- **Deaths:** Last 50 deaths with location and cause
- **Ore discoveries:** Locations of found ore veins
- **Skill history:** Success rate and average duration for every skill
- **Season goal:** Long-term mission set via `!goal set <text>` in-game
- **Broken skills:** Dynamic skills with 5+ failures permanently blocked

### Neural Combat

A Python TCP server (`neural_server.py`) on port 12345 responds to combat observations with: `attack`, `strafe_left`, `strafe_right`, `flee`, `use_item`, or `idle`.

Combat ticks run at 50ms intervals for up to 10 seconds per engagement. If the neural server is unreachable, bots fall back to `mineflayer-pvp`. Blade is the primary combat bot but all bots can flee from threats.

### Live Streaming

- **Mission Control** — All-bot dashboard at `http://localhost:3010`
- **Per-bot 3D viewers** — prismarine-viewer with follow/first-person/orbit camera modes
- **OBS overlays** — Per-bot WebSocket overlay showing health, food, position, inventory, thought, action
- **TTS** — Bot thoughts converted to speech and played through overlay
- **Twitch integration** — Reads Twitch chat; viewers can interact with the bots

### Safety

All chat messages and bot thoughts are filtered:
- Blocks harmful/inappropriate content
- Detects and sanitizes prompt injection attempts from player chat
- Viewer messages filtered separately with tighter rules

---

## Project Structure

```
mineflayer-chatgpt/
├── src/
│   ├── bot/
│   │   ├── index.ts         # Main bot + decision loop
│   │   ├── actions.ts       # Action implementations
│   │   ├── perception.ts    # World context builder
│   │   ├── memory.ts        # Per-bot persistent memory (BotMemoryStore)
│   │   ├── memory-registry.ts # Bot → memory store mapping
│   │   ├── role.ts          # BotRoleConfig + all 5 bot configs
│   │   └── bulletin.ts      # Team bulletin (shared status)
│   ├── llm/
│   │   └── index.ts         # Ollama client + JSON repair + system prompt
│   ├── skills/
│   │   ├── executor.ts      # Skill runner (abort support)
│   │   ├── generator.ts     # Dynamic skill generator
│   │   ├── dynamic-loader.ts# Voyager vm sandbox
│   │   ├── registry.ts      # Skill registration
│   │   ├── stash.ts         # Deposit/withdraw stash actions
│   │   ├── setup-stash.ts   # Bootstrap shared chest area
│   │   ├── build-house.ts
│   │   ├── build-farm.ts
│   │   ├── build-bridge.ts
│   │   ├── craft-gear.ts
│   │   ├── go-fishing.ts
│   │   ├── light-area.ts
│   │   ├── smelt-ores.ts
│   │   └── strip-mine.ts
│   ├── neural/
│   │   ├── bridge.ts        # TCP client for neural server
│   │   └── combat.ts        # 50ms tick combat loop
│   ├── stream/
│   │   ├── viewer.ts        # Per-bot prismarine-viewer
│   │   ├── viewer-client.html # 3D viewer with camera modes
│   │   ├── overlay.ts       # Per-bot OBS WebSocket overlay
│   │   ├── dashboard.ts     # Mission Control server
│   │   └── tts.ts           # Text-to-speech
│   ├── safety/
│   │   └── filter.ts        # Content safety filter
│   ├── config.ts            # Env-based config
│   └── index.ts             # Entry point — launches all bots
├── dashboard/
│   └── index.html           # Mission Control frontend
├── overlay/
│   └── index.html           # OBS overlay frontend
├── skills/
│   ├── voyager/             # 57 Voyager-style JS skills
│   └── generated/           # LLM-generated skills (runtime)
├── neural_server.py         # Python combat policy server
├── memory-atlas.json        # Atlas memory (git-ignored)
├── memory-flora.json        # Flora memory (git-ignored)
├── memory-forge.json        # Forge memory (git-ignored)
├── memory-mason.json        # Mason memory (git-ignored)
├── memory-blade.json        # Blade memory (git-ignored)
└── .env                     # Local config (git-ignored)
```

---

## Known Issues

| Issue | Status |
|-------|--------|
| `mineFiveIronOres` timeout | Pathfinder can't reach iron ore within 60s in some terrain |
| `smeltRawCopper` dependency chain | Requires furnace which requires crafting_table — chain sometimes fails |
| Neural combat untested in survival | Server is implemented and running; needs hostile mob environment |
| Generated skills may fail on first run | LLM sometimes generates skills with incorrect block names |
| Ollama sequential bottleneck | 5 bots share one GPU — decisions queue during busy periods |

---

## Development

```bash
npm run dev     # Run with tsx watch (hot reload)
npm test        # Run tests
npm run build   # Compile TypeScript
```

### Adding a New TypeScript Skill

1. Create `src/skills/my-skill.ts` implementing `async function mySkill(bot: Bot): Promise<string>`
2. Register it in `src/skills/registry.ts`
3. Add it to the appropriate bot's `allowedSkills` in `src/bot/role.ts`

### Adding a Voyager Skill

Drop a `.js` file into `skills/voyager/`. The function name must match the filename (camelCase). It will be loaded automatically by the dynamic loader.

### Adding a New Bot

1. Add a new `BotRoleConfig` in `src/bot/role.ts` with personality, allowed actions/skills, leash radius
2. Add the config to the bot roster array in `src/index.ts`
3. Add `MC_USERNAME_N` to `.env`
4. Increment `BOT_COUNT`

---

## Credits

- Original mineflayer-chatgpt by Jesse Weigel
- Voyager skill library from [MineDreamer/Voyager](https://github.com/MineDreamer/Voyager)
- Autonomous agent architecture, neural combat, multi-bot team system, and streaming features added in 2024-2026
