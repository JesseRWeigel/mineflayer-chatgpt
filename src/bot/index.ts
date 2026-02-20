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
  // Maps canonical skill/action key → last failure message (cleared on success)
  const recentFailures = new Map<string, string>();
  let isActing = false;
  let decisionLoop: ReturnType<typeof setInterval> | null = null;
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
      if (bot.entity.position.y < 55) {
        const underY = bot.entity.position.y.toFixed(1);
        console.log(`[Bot] Underground at Y=${underY} — teleporting to surface`);
        // Bot has OP (sends gamerule commands at startup), so /tp works.
        const tx = Math.floor(bot.entity.position.x);
        const tz = Math.floor(bot.entity.position.z);
        bot.chat(`/tp ${tx} 80 ${tz}`);
        await new Promise(r => setTimeout(r, 2000));
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

      // Track goal from LLM response
      if (decision.goal) {
        currentGoal = decision.goal;
        goalStepsLeft = decision.goalSteps || 5;
      } else if (goalStepsLeft > 0) {
        goalStepsLeft--;
      }

      // Track failures for skill-type actions only (idle/explore/go_to shouldn't pollute the list)
      const isSkillAction =
        DIRECT_SKILL_NAMES.has(decision.action) ||
        decision.action === "invoke_skill" ||
        decision.action === "neural_combat" ||
        decision.action === "generate_skill";
      if (isSkillAction) {
        const isSuccess = /complet|harvest|built|planted|smelted|crafted|arriv|gather|mined|caught|lit|bridg|chop|killed|ate/i.test(result);
        if (!isSuccess) {
          recentFailures.set(actionKey, result.slice(0, 120));
          goalStepsLeft = Math.max(0, goalStepsLeft - 2);
        } else {
          recentFailures.delete(actionKey);
        }
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
    if (decisionLoop) clearInterval(decisionLoop);
  });

  // Handle errors
  bot.on("error", (err) => {
    console.error("[Bot] Error:", err);
  });

  // Spawn handler
  bot.once("spawn", () => {
    console.log("[Bot] Spawned! Starting decision loop...");

    // Set server gamerules (requires bot to be an operator — /op AIBot)
    setTimeout(() => {
      bot.chat("/difficulty peaceful");
      bot.chat("/gamerule keepInventory true");
      console.log("[Bot] Sent gamerule commands (peaceful + keepInventory)");
    }, 1000);

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

    // Start the decision loop
    decisionLoop = setInterval(decide, config.bot.decisionIntervalMs);

    // First decision immediately
    setTimeout(decide, 2000);
  });

  return {
    bot,
    queueChat,
    stop: () => {
      if (decisionLoop) clearInterval(decisionLoop);
      bot.quit();
    },
  };
}
