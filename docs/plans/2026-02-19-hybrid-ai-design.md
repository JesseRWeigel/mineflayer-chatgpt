# Hybrid AI Architecture Design
**Date:** 2026-02-19
**Project:** minecraft-ai-streamer v2.0.0
**Status:** Approved

## Overview

Transform the bot from a single-LLM-loop agent into a three-tier hybrid system:
1. **Hand-crafted TypeScript skills** — existing registry, unchanged
2. **Dynamic JS skill layer** — Voyager library + LLM-generated skills via `vm` sandbox
3. **Neural combat burst mode** — Python TCP server with structured observations at ~20Hz

## Architecture

```
Decision Loop (every 5s)
    │
    ├── Hand-crafted skills (TypeScript registry) ─── unchanged
    ├── Voyager JS skills   (vm sandbox, ./skills/voyager/*.js)
    ├── Generated JS skills (vm sandbox, ./skills/generated/*.js)
    │       └── Ollama writes code on-demand when LLM requests unknown skill
    │
    └── Neural combat burst mode (20Hz for 5–10s)
            └── Python TCP server (:12345) ← structured JSON obs
                    └── PyTorch model or scripted heuristic fallback
```

## Decisions

| Question | Decision |
|---|---|
| Neural observations | Structured JSON vectors (entity positions, distances, health) — no pixel capture |
| Voyager skills | Both: download actual files as seed library + LLM generation at runtime |
| Skill tiers | Two-tier hybrid: TypeScript registry + dynamic vm sandbox |
| Memory backend | SQLite replaces memory.json |

## New Files

| File | Purpose |
|---|---|
| `src/skills/dynamic-loader.ts` | vm sandbox, indexes Voyager + generated skills, hot-reloads |
| `src/skills/generator.ts` | Prompts Ollama to write JS skill code, saves & registers live |
| `neural_server.py` | Python TCP server, structured obs → action |
| `src/neural/bridge.ts` | TypeScript TCP client for neural server |
| `src/neural/combat.ts` | 20Hz combat loop, applies neural actions to bot |

## New LLM Actions

- `invoke_skill { skill: string }` — runs a Voyager/generated skill by name
- `generate_skill { task: string }` — asks Ollama to write new JS skill, saves & runs
- `neural_combat { duration: number }` — enters 5–10s neural burst mode

## Neural Observation Format

```json
{
  "bot_health": 18,
  "bot_food": 16,
  "bot_pos": [x, y, z],
  "nearest_hostile": { "type": "zombie", "distance": 4.2, "angle": 37.5, "health": 20 },
  "all_entities": [{ "type": "...", "distance": ..., "angle": ... }],
  "has_sword": true,
  "has_shield": false
}
```

## Neural Action Format

```json
{
  "action": "attack" | "strafe_left" | "strafe_right" | "flee" | "use_item" | "idle",
  "confidence": 0.87
}
```

## Memory

SQLite database (`memory.db`) replaces `memory.json`:
- `structures` table — built houses, farms, mines
- `deaths` table — death locations and causes
- `skill_history` table — attempts, success rates, durations
- `ore_discoveries` table — ore locations
- `lessons` table — text lessons for LLM context

## Implementation Phases

1. **Voyager skill loader** — vm sandbox + indexing Voyager JS files
2. **LLM skill generator** — Ollama writes JS, saves to disk, hot-registers
3. **SQLite memory** — drop-in replacement for memory.json module
4. **Python neural server** — TCP server with heuristic fallback, optional MineStudio VPT
5. **TypeScript neural bridge** — connect, send obs, receive actions, apply to bot
6. **Decision loop integration** — wire all three tiers into `executeAction` and LLM prompt
7. **End-to-end test** — verify skill invocation, generation, neural burst, memory persistence
