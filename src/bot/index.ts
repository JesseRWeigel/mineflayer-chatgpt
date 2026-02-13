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

export async function createBot(events: BotEvents) {
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

  // State
  const pendingChatMessages: ChatMessage[] = [];
  const recentHistory: LLMMessage[] = [];
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

      // Stuck detection: if repeating the same action 3+ times, tell the LLM to change strategy
      if (repeatCount >= 3) {
        contextStr += `\n\nIMPORTANT: You've tried "${lastAction}" ${repeatCount} times in a row and it keeps failing. You MUST choose a COMPLETELY DIFFERENT action. Abandon your current goal and try something new.`;
        currentGoal = "";
        goalStepsLeft = 0;
      }

      contextStr += "\n\nWhat should you do next? Respond with a JSON action.";

      // Query LLM
      const decision = await queryLLM(contextStr, recentHistory.slice(-6));

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

      // Track repeat actions for stuck detection
      if (decision.action === lastAction) {
        repeatCount++;
      } else {
        lastAction = decision.action;
        repeatCount = 1;
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

      // If action failed, reduce goal commitment
      if (result.includes("failed") || result.includes("No ") || result.includes("Stuck")) {
        goalStepsLeft = Math.max(0, goalStepsLeft - 2);
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
    console.log("[Bot] I died! Respawning...");
    abortActiveSkill();
    recentHistory.push({
      role: "assistant",
      content: "I just died! Need to be more careful.",
    });
  });

  // Handle kicked
  bot.on("kicked", (reason) => {
    console.log(`[Bot] Kicked: ${reason}`);
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
