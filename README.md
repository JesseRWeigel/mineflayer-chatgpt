# Atlas — Autonomous AI Minecraft Bot

An autonomous AI agent that plays Minecraft on its own, powered by a local LLM (Ollama) with a hybrid skill system: hand-crafted TypeScript skills, 57 Voyager-style JavaScript skills, and dynamic skill generation at runtime.

Designed for live streaming: includes a browser viewer, OBS overlay, TTS, and Twitch integration.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Decision Loop (5s)                    │
│  World Context → LLM (qwen2.5:32b) → JSON Action        │
└────────────────────────┬────────────────────────────────┘
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
          │        Persistent Memory    │
          │  (structures, deaths, ores, │
          │   skill success rates)      │
          └─────────────────────────────┘
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Decision loop | `src/bot/index.ts` | LLM query → action every 5s |
| World perception | `src/bot/perception.ts` | Builds context string for LLM |
| Action executor | `src/bot/actions.ts` | Routes JSON actions to implementations |
| LLM client | `src/llm/index.ts` | Ollama API with retry + JSON repair |
| Skill executor | `src/skills/executor.ts` | Runs skills with abort support |
| Voyager loader | `src/skills/dynamic-loader.ts` | Runs JS skills in vm sandbox |
| Skill generator | `src/skills/generator.ts` | LLM generates new JS skills |
| Memory | `src/bot/memory.ts` | Persistent JSON: structures, deaths, ores |
| Neural combat | `src/neural/combat.ts` | 50ms tick loop using TCP server |
| Neural server | `neural_server.py` | Python heuristic/VPT policy server |
| Stream viewer | `src/stream/viewer.ts` | prismarine-viewer on port 3000 |
| OBS overlay | `src/stream/overlay.ts` | WebSocket overlay for OBS |
| TTS | `src/stream/tts.ts` | Text-to-speech for bot thoughts |
| Safety filter | `src/safety/filter.ts` | Blocks harmful chat/thoughts |

---

## Setup

### Requirements

- Node.js 20+
- [Ollama](https://ollama.ai) with `qwen2.5:32b` pulled
- Minecraft Java Edition server (1.21.4)
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
MC_USERNAME=AIBot
MC_VERSION=1.21.4
MC_AUTH=offline

# LLM (Ollama)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen2.5:32b

# Bot identity
BOT_NAME=Atlas
BOT_DECISION_INTERVAL_MS=5000

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

The bot will:
1. Connect to the Minecraft server
2. Start the neural combat server automatically
3. Open browser viewer at `http://localhost:3000`
4. Begin autonomous decision loop

> **Note:** The bot must be an operator on the server (`/op AIBot`) so it can set gamerules at startup (`/difficulty peaceful`, `/gamerule keepInventory true`).

---

## Features

### Autonomous Decision Making

Every 5 seconds, the bot:
1. Gathers world context (health, position, inventory, nearby entities/blocks, time)
2. Queries the local LLM with context + memory + recent history
3. Executes the chosen action
4. Records success/failure and updates memory

**Stuck detection:** If the same action fails 2+ times in a row, the bot is forced to choose a different approach. Failed actions are injected into the next prompt as "SKILLS/ACTIONS THAT JUST FAILED."

**Goal persistence:** The LLM can set multi-step goals (e.g., "build a house") with a step count. The bot tracks progress and continues toward the goal across decision cycles.

**Surface escape:** If the bot ends up underground at Y < 55 (e.g., fell into a cave), it teleports to Y=80 directly rather than relying on pathfinding, which can fail in sealed caves.

### Skill System

**TypeScript skills** (always available):
- `gather_wood` — chop nearby trees
- `mine_block` — mine a specific block type
- `craft_gear` — craft tools and armor progressively
- `build_house` — build a small shelter from blueprints
- `strip_mine` — horizontal strip mining at current Y
- `smelt_ores` — smelt raw ores in a furnace
- `go_fishing` — cast and reel a fishing rod
- `build_farm` — place water + soil + seeds
- `light_area` — place torches in a radius
- `build_bridge` — build a bridge across a gap

**Voyager JS skills** (57 skills, run in vm sandbox):
- Crafting: `craftWoodenPickaxe`, `craftIronPickaxe`, `craftCraftingTable`, `craftFurnace`, `craftChest`, `craftBucket`, `craftIronSword`, `craftIronArmor`, and more
- Mining: `mineWoodLog`, `mineFiveCoalOres`, `mineFiveIronOres`, `mineTenCobblestone`, and more
- Smelting: `smeltFiveRawIron`, `smeltRawCopper`, `smeltCactusIntoGreenDye`, and more
- Combat: `killOnePig`, `killOneZombie`, `killFourSheep`, and more
- Gathering: `collectBamboo`, `collectFiveCactusBlocks`, `fillBucketWithWater`

**Dynamic skill generation:** The bot can generate new JS skills at runtime when it needs to do something none of the existing skills cover. Generated skills are saved to `skills/generated/` and reused on future runs.

**Important notes on generated skills:**
- Skills run in a Node.js `vm` sandbox with `mineflayer-pathfinder`, Voyager primitives, and `mcData` injected
- The generator prompt explicitly bans `try/catch` (to prevent silent failures) and the old pathfinder API (`setGoal`/`waitForGoal`)
- Always use `await bot.pathfinder.goto(new goals.GoalNear(...))` in generated skills

### Persistent Memory

Saved to `memory.json`, survives restarts:
- **Structures:** Location and type of every house/farm/furnace/mine the bot builds
- **Deaths:** Last 50 deaths with location and cause
- **Ore discoveries:** Locations of found ore veins
- **Skill history:** Success rate and average duration for every skill (last 100 attempts)
- **Lessons:** Free-text lessons the bot learns

The memory context is injected into every LLM prompt so the bot remembers what it has built and avoids places where it has died.

### Neural Combat

A Python TCP server (`neural_server.py`) runs on port 12345 and responds to combat observations with one of: `attack`, `strafe_left`, `strafe_right`, `flee`, `use_item`, `idle`.

The current policy is **heuristic** (rule-based): attack if close, strafe at medium range, flee if health is low. A slot exists for a VPT (Video PreTraining) neural policy — run with `python neural_server.py --model vpt` when ready.

Combat ticks run at 50ms intervals for up to 10 seconds per engagement. If the neural server is unreachable, the bot falls back to `mineflayer-pvp`.

> **Status:** The neural server runs automatically at bot startup, but `neural_combat` has only been tested in peaceful mode (no hostile mobs). The full loop (LLM decides → neural_combat runs → mobs engage) is implemented but not yet observed in survival mode.

### Live Streaming

- **Browser viewer** — 3D bot POV at `http://localhost:3000` via prismarine-viewer
- **OBS overlay** — WebSocket overlay showing health, food, position, inventory, current thought, and action result. Connect OBS Browser Source to the overlay server.
- **TTS** — Bot thoughts are converted to speech and played through the overlay
- **Twitch integration** — Reads Twitch chat; viewers can interact with the bot

### Safety

All chat messages and bot thoughts are filtered before being displayed or sent:
- Blocks harmful/inappropriate content
- Detects and sanitizes prompt injection attempts from player chat
- Viewer messages are filtered separately with tighter rules

---

## Project Structure

```
mineflayer-chatgpt/
├── src/
│   ├── bot/
│   │   ├── index.ts         # Main bot + decision loop
│   │   ├── actions.ts       # Action implementations
│   │   ├── perception.ts    # World context builder
│   │   └── memory.ts        # Persistent memory
│   ├── llm/
│   │   └── index.ts         # Ollama client + JSON repair
│   ├── skills/
│   │   ├── executor.ts      # Skill runner (abort support)
│   │   ├── generator.ts     # Dynamic skill generator
│   │   ├── dynamic-loader.ts# Voyager vm sandbox
│   │   ├── registry.ts      # Skill registration
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
│   │   ├── viewer.ts        # prismarine-viewer
│   │   ├── overlay.ts       # OBS WebSocket overlay
│   │   └── tts.ts           # Text-to-speech
│   ├── safety/
│   │   └── filter.ts        # Content safety filter
│   └── config.ts            # Env-based config
├── skills/
│   ├── voyager/             # 57 Voyager-style JS skills
│   └── generated/           # LLM-generated skills (runtime)
├── neural_server.py          # Python combat policy server
├── memory.json               # Persistent bot memory (git-ignored)
└── .env                      # Local config (git-ignored)
```

---

## Known Issues

| Issue | Status |
|-------|--------|
| `mineFiveIronOres` timeout | Pathfinder can't reach iron ore within 60s in some terrain |
| `smeltRawCopper` dependency chain | Requires furnace which requires crafting_table — chain sometimes fails |
| Neural combat untested in survival | Server is implemented and running; needs hostile mob environment |
| Generated skills may fail on first run | LLM sometimes generates skills with incorrect block names |

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
3. Add it to `DIRECT_SKILL_NAMES` in `src/bot/index.ts` if it should be callable by name

### Adding a Voyager Skill

Drop a `.js` file into `skills/voyager/`. The function name must match the filename (camelCase). It will be loaded automatically by the dynamic loader and available in the skill bundle for other skills to call.

---

## Credits

- Original mineflayer-chatgpt by Jesse Weigel
- Voyager skill library from [MineDreamer/Voyager](https://github.com/MineDreamer/Voyager)
- Autonomous agent architecture, neural combat, and streaming features added in 2024–2025
