import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder } = pathfinderPkg;
import pvpPkg from "mineflayer-pvp";
const pvp = pvpPkg;
import { loader as autoEat } from "mineflayer-auto-eat";
import { config } from "../config.js";
import { queryLLM, chatWithLLM, type LLMMessage } from "../llm/index.js";
import { getWorldContext } from "./perception.js";
import { executeAction } from "./actions.js";
import { startViewer } from "../stream/viewer.js";
import { updateOverlay, addChatMessage, speakThought } from "../stream/overlay.js";
import { generateSpeech } from "../stream/tts.js";
import { filterContent, filterChatMessage, filterViewerMessage } from "../safety/filter.js";
import { abortActiveSkill, isSkillRunning, getActiveSkillName } from "../skills/executor.js";
import { loadMemory, getMemoryContext, recordDeath } from "./memory.js";
import { spawn } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { isNeuralServerRunning } from "../neural/bridge.js";

export interface ChatMessage {
  source: "minecraft" | "twitch" | "youtube";
  username: string;
  message: string;
  timestamp: number;
}

export interface BotEvents {
  onThought: (thought: string) => void;
  onAction: (action: string, result: string) => void;
  onChat: (message: string) => void;
}

async function ensureNeuralServer(): Promise<void> {
  if (await isNeuralServerRunning()) {
    console.log("[Bot] Neural server already running.");
    return;
  }
  console.log("[Bot] Starting neural server...");
  const proc = spawn("python3", [path.resolve(__dirname, "../../neural_server.py")], { stdio: "pipe" });
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

export async function createBot(events: BotEvents) {
  ensureNeuralServer().catch((e) => console.warn("[Bot] Neural spawn error:", e));

  // Load memory at startup
  loadMemory();

  console.log(
    `[Bot] Connecting to ${config.mc.host}:${config.mc.port} as ${config.mc.username}...`
  );

  const bot = mineflayer.createBot({
    host: config.mc.host,
    port: config.mc.port,
    username: config.mc.username,
    version: config.mc.version,
    auth: config.mc.auth,
  });

  // Load plugins
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp.plugin);
  bot.loadPlugin(autoEat);

  // Static skill names that can be called directly OR via invoke_skill — normalize both
  const DIRECT_SKILL_NAMES = new Set([
    "gather_wood", "mine_block", "craft_gear", "build_house", "strip_mine",
    "smelt_ores", "go_fishing", "build_farm", "light_area", "build_bridge",
  ]);

  // State
  const pendingChatMessages: ChatMessage[] = [];
  const recentHistory: LLMMessage[] = [];
  // Maps canonical skill/action key → last failure message (cleared on success).
  // NOT pre-populated from memory — let the bot try fresh each session.
  // Memory context already warns the LLM about historically broken skills.
  const recentFailures = new Map<string, string>();
  let isActing = false;
  let loopRunning = false;
  let lastAction = "";
  let repeatCount = 0;
  let currentGoal = "";
  let goalStepsLeft = 0;

  // Queue a chat message for the LLM to consider
  function queueChat(msg: ChatMessage) {
    // Filter incoming viewer messages for safety and prompt injection
    const viewerFilter = filterViewerMessage(msg.message);
    if (!viewerFilter.safe) {
      console.log(`[Safety] Filtered viewer message from ${msg.username}: ${viewerFilter.reason}`);
      msg.message = viewerFilter.cleaned;
    }
    pendingChatMessages.push(msg);
    // Keep only last 10
    if (pendingChatMessages.length > 10) pendingChatMessages.shift();
  }

  // Main decision loop
  async function decide() {
    if (isActing) return;
    isActing = true;

    try {
      // Build context
      const worldContext = getWorldContext(bot);
      let contextStr = `CURRENT STATE:\n${worldContext}`;

      // Goal persistence: tell the LLM what it was working on
      const hasUrgentChat = pendingChatMessages.some(
        (m) => "tier" in m && (m as any).tier === "paid"
      );

      // Add pending chat messages
      if (pendingChatMessages.length > 0) {
        const chatStr = pendingChatMessages
          .map((m) => `[${m.source}] ${m.username}: ${m.message}`)
          .join("\n");
        contextStr += `\n\nMESSAGES FROM PLAYERS/VIEWERS:\n${chatStr}`;
        pendingChatMessages.length = 0; // Clear after including
      }
      const isEmergency = bot.health <= 6 || hasUrgentChat;

      if (currentGoal && goalStepsLeft > 0 && !isEmergency) {
        contextStr += `\n\nCURRENT GOAL: "${currentGoal}" (${goalStepsLeft} steps remaining). Continue working toward this goal. Pick the NEXT logical step.`;
      } else if (isEmergency) {
        if (hasUrgentChat) {
          contextStr += `\n\nURGENT: A PAID viewer sent a command! Drop your current goal and respond to them.`;
        } else {
          contextStr += `\n\nEMERGENCY: Health is critically low (${bot.health}/20)! Prioritize survival.`;
        }
        currentGoal = "";
        goalStepsLeft = 0;
      }

      // Stuck detection: if repeating the same action 2+ times, tell the LLM to change strategy
      if (repeatCount >= 2) {
        contextStr += `\n\nIMPORTANT: You've tried "${lastAction}" ${repeatCount} times in a row and it keeps failing. You MUST choose a COMPLETELY DIFFERENT action. Abandon your current goal and try something new.`;
        currentGoal = "";
        goalStepsLeft = 0;
      }

      // Recent failures: show the LLM exactly what failed and why so it stops retrying
      // Strip the internal "skill:" prefix so the LLM sees the same name it would type
      if (recentFailures.size > 0) {
        const failLines = Array.from(recentFailures.entries())
          .map(([k, v]) => `- ${k.replace(/^skill:/, "")}: ${v}`)
          .join("\n");
        contextStr += `\n\nSKILLS/ACTIONS THAT JUST FAILED (DO NOT RETRY THESE):\n${failLines}\nChoose a DIFFERENT action.`;
      }

      contextStr += "\n\nWhat should you do next? Respond with a JSON action.";

      // Safety override: if the bot is deep underground, skip the LLM and escape to surface.
      // Pathfinding failures underground flood recentFailures and the LLM never self-rescues.
      // Safety override: if bot is in water, try /tp to land, or ask user for help.
      const waterFeet = bot.blockAt(bot.entity.position);
      const waterHead = bot.blockAt(bot.entity.position.offset(0, 1, 0));
      if (waterFeet?.name === "water" || waterHead?.name === "water") {
        const wx = Math.floor(bot.entity.position.x);
        const wz = Math.floor(bot.entity.position.z);
        const wy = bot.entity.position.y.toFixed(1);
        console.log(`[Bot] In water at ${wx},${wy},${wz} — attempting /tp escape`);

        // Try a few /tp attempts (spacing them out to avoid AFK kick)
        const offsets = [[0, 300], [300, 0], [0, -300], [-300, 0]];
        let foundLand = false;
        for (const [dx, dz] of offsets) {
          bot.chat(`/tp ${wx + dx} 80 ${wz + dz}`);
          await new Promise((r) => setTimeout(r, 3000));
          const fb = bot.blockAt(bot.entity.position);
          if (fb?.name !== "water" && fb?.name !== "air") {
            const lx = Math.floor(bot.entity.position.x);
            const ly = Math.floor(bot.entity.position.y);
            const lz = Math.floor(bot.entity.position.z);
            console.log(`[Bot] Found land at ${lx},${ly},${lz} — setting spawnpoint`);
            bot.chat(`/spawnpoint ${config.mc.username} ${lx} ${ly} ${lz}`);
            foundLand = true;
            break;
          }
        }

        if (!foundLand) {
          // /tp likely failed (bot not OP) — ask user in chat and try pathfinder
          console.warn("[Bot] /tp failed — bot may not be OP. Asking for help.");
          bot.chat("I'm stuck in the ocean! Please /tp me to dry land, or run: /op " + config.mc.username);
          // Try pathfinder as a last resort (may work if near shore)
          const { explorerMoves: em, safeGoto: sg } = await import("./actions.js");
          const pfPkg = await import("mineflayer-pathfinder");
          const pfGoals = (pfPkg as any).goals || (pfPkg.default as any).goals;
          bot.pathfinder.setMovements(em(bot));
          try {
            await sg(bot, new pfGoals.GoalY(64), 30000);
          } catch { /* best effort */ }
          try {
            const p = bot.entity.position;
            await sg(bot, new pfGoals.GoalNear(p.x + 200, 64, p.z, 5), 60000);
          } catch { /* best effort */ }
        }
        return;
      }

      // Emergency escape: bot is inside solid rock (actually buried, not just in a cave)
      const feetBlock = bot.blockAt(bot.entity.position);
      const isInsideSolid = feetBlock && feetBlock.name !== "air" && feetBlock.name !== "cave_air"
        && feetBlock.name !== "water" && feetBlock.diggable && bot.entity.position.y < 55;
      if (isInsideSolid) {
        const underY = bot.entity.position.y.toFixed(1);
        console.log(`[Bot] Buried in ${feetBlock?.name} at Y=${underY} — attempting escape`);
        const tx = Math.floor(bot.entity.position.x);
        const tz = Math.floor(bot.entity.position.z);
        // Try /tp first (works if bot has OP)
        bot.chat(`/tp ${tx} 80 ${tz}`);
        await new Promise(r => setTimeout(r, 2000));
        if (bot.entity.position.y >= 55) {
          bot.chat(`/spawnpoint ${config.mc.username} ${tx} 80 ${tz}`);
          console.log(`[Bot] Teleported to Y=${bot.entity.position.y.toFixed(1)}`);
          return;
        }
        // Dig one block up and jump — repeat up to 5 times
        console.log("[Bot] /tp failed — digging up");
        for (let i = 0; i < 5; i++) {
          const pos = bot.entity.position;
          const above = bot.blockAt(pos.offset(0, 1, 0));
          if (!above || !above.diggable || above.name === "air") break;
          try { await bot.dig(above); } catch { break; }
          bot.setControlState("jump", true);
          await new Promise(r => setTimeout(r, 500));
          bot.setControlState("jump", false);
        }
        console.log(`[Bot] Now at Y=${bot.entity.position.y.toFixed(1)}`);
        return;
      }

      // Query LLM with memory context
      const memoryCtx = getMemoryContext();
      const decision = await queryLLM(contextStr, recentHistory.slice(-6), memoryCtx);

      // Filter thought for safety before showing on stream
      const thoughtFilter = filterContent(decision.thought);
      if (!thoughtFilter.safe) {
        console.log(`[Safety] Blocked thought: ${thoughtFilter.reason}`);
        decision.thought = thoughtFilter.cleaned;
      }

      // Filter chat/respond actions before they go to in-game chat
      if ((decision.action === "chat" || decision.action === "respond_to_chat") && decision.params?.message) {
        const chatFilter = filterChatMessage(decision.params.message);
        if (!chatFilter.safe) {
          console.log(`[Safety] Blocked chat: ${chatFilter.reason}`);
          decision.params.message = chatFilter.cleaned;
        }
      }

      events.onThought(decision.thought);
      console.log(
        `[Bot] Thought: "${decision.thought}" → Action: ${decision.action}`
      );

      // Push thought + action to overlay IMMEDIATELY (before execution)
      updateOverlay({
        health: bot.health,
        food: bot.food,
        position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
        time: (bot.time.timeOfDay < 13000 || bot.time.timeOfDay > 23000) ? "Daytime" : "Nighttime",
        thought: decision.thought,
        action: decision.action,
        actionResult: "...",
        inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`),
      });

      // Generate TTS in background (don't block the decision loop)
      generateSpeech(decision.thought).then((audioUrl) => {
        if (audioUrl) speakThought(audioUrl);
      }).catch(() => {});

      // Normalize action key: invoke_skill:X and direct skill call X are the same thing
      const actionKey =
        decision.action === "invoke_skill" && decision.params?.skill
          ? `skill:${decision.params.skill}`
          : DIRECT_SKILL_NAMES.has(decision.action)
          ? `skill:${decision.action}`
          : decision.action;
      // Don't let LLM-fallback `idle` breaks streak tracking for real skills
      if (decision.action !== "idle" || decision.thought !== "Brain buffering...") {
        if (actionKey === lastAction) {
          repeatCount++;
        } else {
          lastAction = actionKey;
          repeatCount = 1;
        }
      }

      // Server-side blacklist: block any action that's currently in recentFailures.
      // The LLM prompt says "don't retry these" but LLMs don't always comply — this enforces it.
      const isBlacklisted = recentFailures.has(actionKey);
      if (isBlacklisted) {
        const blockMsg = `Blocked: "${actionKey}" is in the failure blacklist. Choose a different action.`;
        console.log(`[Bot] ${blockMsg}`);
        events.onAction(decision.action, blockMsg);
        recentHistory.push({ role: "assistant", content: blockMsg });
        if (recentHistory.length > 20) recentHistory.splice(0, recentHistory.length - 10);
        isActing = false;
        return;
      }

      // Execute action
      const result = await executeAction(bot, decision.action, decision.params);
      events.onAction(decision.action, result);
      console.log(`[Bot] Result: ${result}`);

      // Update overlay with execution result
      updateOverlay({
        health: bot.health,
        food: bot.food,
        position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
        time: (bot.time.timeOfDay < 13000 || bot.time.timeOfDay > 23000) ? "Daytime" : "Nighttime",
        actionResult: result,
        inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`),
      });

      // Track failures for skill-type actions only (go_to/idle shouldn't pollute the list)
      const isSkillAction =
        DIRECT_SKILL_NAMES.has(decision.action) ||
        decision.action === "invoke_skill" ||
        decision.action === "neural_combat" ||
        decision.action === "generate_skill" ||
        decision.action === "explore";
      const isSuccess = /complet|harvest|built|planted|smelted|crafted|arriv|gather|mined|caught|lit|bridg|chop|killed|ate|explored|placed|fished/i.test(result);
      if (isSkillAction) {
        if (!isSuccess) {
          recentFailures.set(actionKey, result.slice(0, 120));
          goalStepsLeft = Math.max(0, goalStepsLeft - 2);
        } else {
          recentFailures.delete(actionKey);
          // On success, expire the oldest failure entry to keep the soft-blacklist from going stale
          if (recentFailures.size > 0) {
            const firstKey = recentFailures.keys().next().value;
            if (firstKey) recentFailures.delete(firstKey);
          }
        }
      }

      // Track goal from LLM response — only decrement on success so goals survive failures
      if (decision.goal) {
        currentGoal = decision.goal;
        goalStepsLeft = decision.goalSteps || 5;
      } else if (goalStepsLeft > 0 && isSuccess) {
        goalStepsLeft--;
      }

      // Track history for context
      recentHistory.push({
        role: "assistant",
        content: `I decided to ${decision.action}: ${decision.thought}. Result: ${result}`,
      });

      // Keep history manageable
      if (recentHistory.length > 20) {
        recentHistory.splice(0, recentHistory.length - 10);
      }
    } catch (err) {
      console.error("[Bot] Decision error:", err);
    } finally {
      isActing = false;
    }
  }

  // Handle in-game chat
  bot.on("chat", async (username, message) => {
    if (username === bot.username) return;
    console.log(`[MC Chat] ${username}: ${message}`);

    // Eval commands (in-game skill testing): /eval <name> or /eval all [filter]
    if (message.startsWith("/eval ") || message === "/eval") {
      const parts = message.trim().split(/\s+/);
      const { evalSkill, evalAll } = await import("../eval/runner.js");
      if (parts[1] === "all") {
        evalAll(bot, parts[2]).catch((e) => bot.chat(`[EVAL] Error: ${e.message}`));
      } else if (parts[1]) {
        evalSkill(bot, parts[1]).catch((e) => bot.chat(`[EVAL] Error: ${e.message}`));
      } else {
        bot.chat("[EVAL] Usage: /eval <skillname>  or  /eval all [filter]");
      }
      return;
    }

    queueChat({
      source: "minecraft",
      username,
      message,
      timestamp: Date.now(),
    });
    addChatMessage(username, message, "free");
  });

  // Handle death
  bot.on("death", () => {
    const pos = bot.entity.position;
    // Try to detect cause from recent events (simplified)
    const cause = "unknown";
    recordDeath(pos.x, pos.y, pos.z, cause);

    console.log("[Bot] I died! Respawning...");
    abortActiveSkill();
    recentHistory.push({
      role: "assistant",
      content: "I just died! Need to be more careful.",
    });
  });

  // Handle kicked
  bot.on("kicked", (reason) => {
    console.log(`[Bot] Kicked: ${JSON.stringify(reason)}`);
    loopRunning = false;
  });

  // Handle errors
  bot.on("error", (err) => {
    console.error("[Bot] Error:", err);
  });

  // Spawn safety — runs on every spawn (initial connection AND respawns after death).
  // Locks spawnpoint only once the bot is confirmed standing on solid ground.
  let spawnSafetyRunning = false;
  async function runSpawnSafety() {
    if (spawnSafetyRunning) return; // prevent concurrent runs (e.g. death mid-fall)
    spawnSafetyRunning = true;
    // Small delay for server to sync position
    await new Promise((r) => setTimeout(r, 800));

    // If still falling, wait until onGround (up to 60 seconds)
    if (!bot.entity.onGround) {
      console.log(`[Bot] Spawn at Y=${bot.entity.position.y.toFixed(1)} — waiting for landing...`);
      const deadline = Date.now() + 60_000;
      while (!bot.entity.onGround && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!bot.entity.onGround) {
        // Still falling — force /tp to a reasonable height
        const px = Math.floor(bot.entity.position.x);
        const pz = Math.floor(bot.entity.position.z);
        console.log("[Bot] Still falling after 60s — forcing /tp to Y=80");
        bot.chat(`/tp ${px} 80 ${pz}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    const pos = bot.entity.position;
    const feet = bot.blockAt(pos);
    const below = bot.blockAt(pos.offset(0, -1, 0));

    // Case: spawned in water — find land
    if (feet?.name === "water" || below?.name === "water") {
      console.log("[Bot] In water — using /tp to find land");
      const sx = Math.floor(pos.x);
      const sz = Math.floor(pos.z);
      let foundLand = false;
      for (const [dx, dz] of [[0, 300], [300, 0], [0, -300], [-300, 0], [300, 300]]) {
        bot.chat(`/tp ${sx + dx} 80 ${sz + dz}`);
        await new Promise((r) => setTimeout(r, 3000));
        const fb = bot.blockAt(bot.entity.position);
        if (fb && fb.name !== "water" && fb.name !== "air") {
          const lx = Math.floor(bot.entity.position.x);
          const ly = Math.floor(bot.entity.position.y);
          const lz = Math.floor(bot.entity.position.z);
          bot.chat(`/spawnpoint ${config.mc.username} ${lx} ${ly} ${lz}`);
          console.log(`[Bot] Spawnpoint set to land at ${lx},${ly},${lz}`);
          foundLand = true;
          break;
        }
      }
      if (!foundLand) {
        console.warn("[Bot] Could not find dry land for spawnpoint");
      }
      return;
    }

    // Case: underground (solid block above within 6 blocks and Y < 100)
    if (pos.y < 100) {
      let hasCeiling = false;
      for (let dy = 1; dy <= 6; dy++) {
        const b = bot.blockAt(pos.offset(0, dy, 0));
        if (b && b.name !== "air" && b.name !== "cave_air") { hasCeiling = true; break; }
      }
      if (hasCeiling) {
        const sx = Math.floor(pos.x);
        const sz = Math.floor(pos.z);
        console.log(`[Bot] Underground at Y=${pos.y.toFixed(0)} — /tp to surface with slow_falling`);
        bot.chat(`/effect give ${config.mc.username} slow_falling 60 1`);
        await new Promise((r) => setTimeout(r, 500));
        bot.chat(`/tp ${sx} 200 ${sz}`);
        // Wait for landing (slow_falling is slow — poll onGround)
        const deadline = Date.now() + 60_000;
        while (!bot.entity.onGround && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 300));
        }
        console.log(`[Bot] Landed at Y=${bot.entity.position.y.toFixed(1)}`);
      }
    }

    // Lock spawnpoint at current confirmed ground position
    const lx = Math.floor(bot.entity.position.x);
    const ly = Math.floor(bot.entity.position.y);
    const lz = Math.floor(bot.entity.position.z);
    bot.chat(`/spawnpoint ${config.mc.username} ${lx} ${ly} ${lz}`);
    console.log(`[Bot] Spawnpoint locked at ${lx},${ly},${lz}`);
    spawnSafetyRunning = false;
  }

  // Re-run spawn safety on every respawn (deaths included)
  bot.on("spawn", async () => {
    bot.chat("/gamerule keepInventory true");
    bot.chat("/gamerule doMobSpawning true");
    runSpawnSafety().catch((e) => console.warn("[Bot] Spawn safety error:", e));
  });

  // Spawn handler (once — one-time setup only)
  bot.once("spawn", () => {
    console.log("[Bot] Spawned! Starting decision loop...");

    // Start browser viewer on port 3000
    startViewer(bot, 3000);

    // Give pathfinder more time to compute paths (default ~5s is too short with canDig=false)
    bot.pathfinder.thinkTimeout = 10000;

    // Configure auto-eat
    bot.autoEat.opts = {
      priority: "foodPoints",
      minHunger: 14,
      minHealth: 6,
      bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato"],
      returnToLastItem: true,
      offhand: false,
      eatingTimeout: 3000,
      strictErrors: false,
    };

    // Push overlay updates every 2 seconds for smooth stat tracking
    setInterval(() => {
      const overlayData: Partial<Parameters<typeof updateOverlay>[0]> = {
        health: bot.health,
        food: bot.food,
        position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
        time: (bot.time.timeOfDay < 13000 || bot.time.timeOfDay > 23000) ? "Daytime" : "Nighttime",
        inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`),
      };
      if (isSkillRunning()) {
        (overlayData as any).action = `[SKILL] ${getActiveSkillName()}`;
      }
      updateOverlay(overlayData as any);
    }, 2000);

    // Continuous action loop — fires immediately after each action completes
    loopRunning = true;
    async function runLoop() {
      await new Promise((r) => setTimeout(r, 2000)); // Initial delay after spawn
      while (loopRunning) {
        await decide();
        // Minimum gap between decisions (prevents hammering when actions return instantly)
        await new Promise((r) => setTimeout(r, config.bot.decisionIntervalMs));
      }
    }
    runLoop().catch((e) => console.error("[Bot] Decision loop crashed:", e));
  });

  return {
    bot,
    queueChat,
    stop: () => {
      loopRunning = false;
      bot.quit();
    },
  };
}
