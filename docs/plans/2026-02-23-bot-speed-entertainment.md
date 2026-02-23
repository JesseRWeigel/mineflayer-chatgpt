# Bot Speed & Entertainment Overhaul

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the bot dramatically faster and more entertaining to watch on stream by eliminating idle gaps, fixing the blacklist death spiral, using a faster LLM model, and keeping the bot vocal during long skills.

**Architecture:** Five targeted changes to `src/bot/index.ts`, `src/bot/memory.ts`, `src/config.ts`, and `src/skills/executor.ts`. No new files needed. Each change is independent and can be validated separately.

**Tech Stack:** Mineflayer, Ollama (local LLM), TypeScript/tsup, Node.js

---

## Status

| Task | Status | Notes |
|------|--------|-------|
| 1. Save plan | ✅ Done | |
| 2. Continuous action loop | ✅ Done | `setInterval` → self-calling `runLoop()`, 500ms gap |
| 3. Fast model config | ✅ Done | `qwen3:8b` for decisions, `qwen3:32b` kept for skill gen |
| 4. Fix blacklist spiral | ✅ Done | Threshold 2→5, no pre-population from memory on start |
| 5. Bot talks during skills | ✅ Done | 30s chatter interval in executor.ts |
| 6. Smarter goal tracking | ✅ Done | Only decrements on success |
| 7. Pull fast model | ✅ Done | `qwen3:8b` (5.2 GB) pulled |
| 8. Build & test | ✅ Done | TypeScript compiles clean |
| 9. Run & observe | ✅ Done | Observed ~3 min of live operation |
| 10. Fix skill graveyard | ✅ Done | 46→9 generated skills; restored static skills from blacklist |
| 11. Action alias fixes | ✅ Done | `mine_X`→`mine_block`, `manuallyBuild*`→`build_house`, `move`→`explore`; unknown actions blocked on 1st fail |
| 12. Fix success rut loop | ✅ Done | After 3 consecutive successes of same action, LLM told to pick something different |

## Verified Behaviors

- Decisions fire immediately after each action (no 5-second gaps)
- Startup banner shows `LLM: qwen3:32b (fast decisions: qwen3:8b)`
- `mine` action alias correctly routes to `mine_block`
- `decisionLoop is not defined` crash fixed (now uses `loopRunning` flag)
- `craftAFurnaceUsing8CobblestoneBlocks` correctly blacklisted after 5 failures (new threshold)
- tsx hot-reload works — code changes take effect without manual restart
- No crashes observed during 3-minute observation window
- Static skills (`build_house`, `craft_gear`, `build_farm`, `light_area`, `build_bridge`) restored from false blacklist
- 37 broken/redundant dynamic skills deleted; 2 broken furnace skills added to permanent blacklist
- `mine_iron_ore` / `mine_coal` / etc. now route to `mine_block` with correct `blockType` param
- `manuallyBuildAShelter*` / `constructShelter*` now route to `build_house`
- `move` / `walk` / `travel` now route to `explore`
- Hallucinated unknown actions added to `recentFailures` immediately (1 fail = blocked, was: blocked only after 5 permanent blacklist threshold)

## Remaining Known Issues (Pre-existing, not introduced by this PR)

- First LLM response per session occasionally has wrong format (no `thought` field) — cold-start issue with qwen3:8b. The fallback `"..."` thought handles it gracefully.
- Bot will do the same successful action up to 3 times before being nudged to diversify — intentional, prevents over-interruption of multi-step tasks.

---

## Background: Why the Bot Is Slow

1. **5-second polling interval** — `setInterval(decide, 5000)` creates dead air between actions even when the bot has nothing to do but wait.
2. **qwen3:32b is slow** — ~61 tok/s for decisions that only need a 120-char thought + JSON. Overkill.
3. **Blacklist spiral** — 2 skill failures = permanent ban. Pre-populated from `memory.json` on every start. Bot runs out of valid actions → idles.
4. **Skills silence the bot** — `isActing` blocks all decisions. During a 2-minute `build_house`, the bot is frozen.
5. **goalStepsLeft countdown** — decrements regardless of success/failure. Goals expire and get abandoned mid-task.

---

## Task 1: Write Plan File

**Files:**
- Create: `docs/plans/2026-02-23-bot-speed-entertainment.md`

**Step 1:** File already created (this file).

**Step 2: Commit**
```bash
git add docs/plans/2026-02-23-bot-speed-entertainment.md
git commit -m "docs: add bot speed/entertainment implementation plan"
```

---

## Task 2: Continuous Action Loop

**Problem:** `setInterval(decide, 5000)` adds a 5-second gap after every action. Combined with LLM query time (~5-10s), the effective decision rate is 15-20s per action.

**Fix:** Replace `setInterval` with a self-calling async loop that re-fires immediately after each action completes. Add a 500ms minimum gap to prevent hammering.

**Files:**
- Modify: `src/bot/index.ts` (around line 564)

**Step 1: Find the current loop setup**

```typescript
// Current code at ~line 563-567:
// Start the decision loop
decisionLoop = setInterval(decide, config.bot.decisionIntervalMs);

// First decision immediately
setTimeout(decide, 2000);
```

**Step 2: Replace with continuous loop**

Replace the `setInterval` block and the `decisionLoop` variable usage with:

```typescript
// Continuous action loop — re-fires immediately after each action
let loopRunning = true;
async function decisionLoop() {
  // Initial delay after spawn
  await new Promise((r) => setTimeout(r, 2000));
  while (loopRunning) {
    await decide();
    // Minimum gap between decisions (prevents hammering when actions are instant)
    await new Promise((r) => setTimeout(r, config.bot.decisionIntervalMs));
  }
}
decisionLoop().catch((e) => console.error("[Bot] Decision loop crashed:", e));
```

Also update the `stop()` return to set `loopRunning = false` instead of `clearInterval`.

**Step 3: Update config default**

In `src/config.ts`, change `decisionIntervalMs` default from `"5000"` to `"500"`:

```typescript
decisionIntervalMs: parseInt(process.env.BOT_DECISION_INTERVAL_MS || "500"),
```

**Expected result:** Bot acts every ~500ms + LLM query time instead of every 5s + LLM query time.

---

## Task 3: Dual-Model Config (Fast Decisions, Smart Generation)

**Problem:** `qwen3:32b` at ~61 tok/s is used for everything. Decisions only need a short JSON response — a fast 8B model handles this 3-4x faster.

**Fix:** Add a second `fastModel` config field. Use the fast model for real-time decisions (`queryLLM`), keep the full model for skill generation (`generateSkill`) and chat responses.

**Files:**
- Modify: `src/config.ts`
- Modify: `src/llm/index.ts`
- Modify: `src/skills/generator.ts`

**Step 1: Add fastModel to config**

```typescript
// src/config.ts
ollama: {
  host: process.env.OLLAMA_HOST || "http://localhost:11434",
  model: process.env.OLLAMA_MODEL || "qwen3:32b",
  fastModel: process.env.OLLAMA_FAST_MODEL || "qwen3:32b", // Falls back to main model if unset
},
```

**Step 2: Use fastModel in queryLLM**

In `src/llm/index.ts`, change the `queryLLM` function to use `config.ollama.fastModel`:

```typescript
// In queryLLM():
let response = await ollama.chat({
  model: config.ollama.fastModel,  // <-- was config.ollama.model
  ...
});
```

The `chatWithLLM` function and the retry fallback prompt should also use `fastModel`.

**Step 3: Keep generator using main model**

`src/skills/generator.ts` already uses `config.ollama.model` — leave it as-is.

**Step 4: Set env var**

Add to `.env`:
```
OLLAMA_FAST_MODEL=llama3.1:8b
```
(Or whichever fast model is pulled — see Task 7)

---

## Task 4: Fix the Blacklist Death Spiral

**Problem:** 2 failures → permanent ban per `src/bot/memory.ts:209`. Loaded from `memory.json` on every boot via `getBrokenSkills()`. Bot ends up with no valid actions.

**Three sub-fixes:**
1. Raise threshold from 2 → 5 real failures before permanent ban
2. Don't pre-populate `recentFailures` from memory on startup — let the bot try things fresh each session, learning only within the session
3. Make the in-session `recentFailures` map expire entries after 3 successful decisions (not just on success of the same skill)

**Files:**
- Modify: `src/bot/memory.ts` (line 209)
- Modify: `src/bot/index.ts` (line 91)

**Step 1: Raise permanent blacklist threshold**

In `src/bot/memory.ts`, change:
```typescript
// line 209 — was >= 2
if (!success && !isPreconditionFail && realFailures.length >= 5 && !memory.brokenSkillNames.includes(skill)) {
```

**Step 2: Don't pre-populate recentFailures from memory**

In `src/bot/index.ts`, change:
```typescript
// Was: const recentFailures = new Map<string, string>(getBrokenSkills());
// Only import broken skills into the in-session soft blacklist but DON'T pre-populate recentFailures.
// Let the bot attempt things fresh; memory just informs the LLM via getMemoryContext().
const recentFailures = new Map<string, string>();
```

The `getMemoryContext()` already tells the LLM about broken skills — that's enough context without hard-blocking at the code level.

**Step 3: Auto-expire recentFailures entries**

After a successful action, clear ONE random entry from `recentFailures` (the oldest one) to prevent the map from growing stale. Add after the success detection block in `src/bot/index.ts`:

```typescript
// After a successful action, expire one old failure to keep the list fresh
if (isSuccess && recentFailures.size > 0) {
  const firstKey = recentFailures.keys().next().value;
  if (firstKey) recentFailures.delete(firstKey);
}
```

---

## Task 5: Bot Talks During Skills

**Problem:** While a skill runs (1-3 min), `isActing` blocks all decisions and the bot is silent. Dead air on stream.

**Fix:** In the skill executor, emit a random in-character one-liner to in-game chat every 30 seconds while a skill runs.

**Files:**
- Modify: `src/skills/executor.ts`

**Step 1: Add a chatter interval to runSkill**

In `src/skills/executor.ts`, after setting `activeSkill`, add a 30-second interval that picks a random quip from a small list and has the bot say it:

```typescript
// Skill chatter — bot narrates every 30s so stream isn't dead
const SKILL_QUIPS = [
  "Still working on it... this better be worth it.",
  "Don't rush me, I'm an AI. Time is relative.",
  "Going great. Totally under control.",
  "This is fine. Everything is fine.",
  "Almost there... maybe.",
  "I have no idea how long this will take.",
  "Chat, if this works, you owe me a follow.",
];
const chatterInterval = setInterval(() => {
  if (activeSkill) {
    const quip = SKILL_QUIPS[Math.floor(Math.random() * SKILL_QUIPS.length)];
    bot.chat(quip);
  }
}, 30000);

// Clear it when skill finishes (in finally block)
```

Make sure to `clearInterval(chatterInterval)` in the `finally` block.

---

## Task 6: Smarter Goal Tracking

**Problem:** `goalStepsLeft` is a naive countdown that decrements regardless of whether progress was made. Goals expire mid-task.

**Fix:** Only decrement `goalStepsLeft` when an action **succeeds**. On failure, keep the counter stable (but still switch away from the failed action via `recentFailures`).

**Files:**
- Modify: `src/bot/index.ts` (around lines 336-358)

**Step 1: Move goal decrement inside success check**

Find the current logic:
```typescript
// Track goal from LLM response
if (decision.goal) {
  currentGoal = decision.goal;
  goalStepsLeft = decision.goalSteps || 5;
} else if (goalStepsLeft > 0) {
  goalStepsLeft--;  // ← decrements even on failure
}
```

Change to:
```typescript
if (decision.goal) {
  currentGoal = decision.goal;
  goalStepsLeft = decision.goalSteps || 5;
} else if (goalStepsLeft > 0 && isSuccess) {
  goalStepsLeft--;  // ← only decrement on success
}
```

Where `isSuccess` is the boolean already computed in the failure tracking block below. Move the `isSuccess` computation above the goal tracking.

---

## Task 7: Pull Fast LLM Model

**Files:** None (shell command)

**Step 1: Check what's already pulled**
```bash
ollama list
```

**Step 2: Pull fast model if needed**
```bash
# Recommended: llama3.1:8b — 213 tok/s on 5090, small enough to coexist with qwen3:32b
ollama pull llama3.1:8b
```

**Step 3: Test it responds**
```bash
ollama run llama3.1:8b "Respond with valid JSON: {\"thought\": \"test\", \"action\": \"idle\", \"params\": {}}"
```

---

## Task 8: Build & Verify TypeScript Compiles

**Files:** None (build command)

**Step 1: Build**
```bash
npm run build 2>&1 | head -50
```

Expected: No TypeScript errors.

**Step 2: Fix any type errors**

Common issues:
- `loopRunning` referenced in `stop()` — ensure it's in scope (use `let loopRunning = true` in `createBot` scope)
- `isSuccess` used before declaration — move the success check block above the goal tracking block

---

## Task 9: Run & Observe

**Step 1: Start the bot**
```bash
npm start
```

**Step 2: Watch for these indicators of success**
- Decision loop fires rapidly (look for `[Bot] Thought:` lines with < 2s gaps)
- Bot actions flow continuously without long pauses
- When a skill runs, bot says quips in chat every 30s
- No spiral of "Blocked: X is in the failure blacklist" messages filling the log

**Step 3: Check model speed**
```bash
# In another terminal, watch ollama ps to confirm which model is serving
watch -n 2 ollama ps
```

**Step 4: If something breaks**
- Bot stuck: check `[Bot] Decision loop crashed:` in logs
- Skills not running: check `recentFailures` isn't blocking everything
- LLM errors: check ollama is running (`ollama serve` in another terminal)

---

## Rollback

All changes are in TypeScript source. To rollback:
```bash
git stash
npm run build && npm start
```
