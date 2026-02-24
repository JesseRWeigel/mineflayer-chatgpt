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
import { registerBotMemory } from "./memory-registry.js";
import { skillRegistry } from "../skills/registry.js";
import { BotMemoryStore } from "./memory.js";
import { BotRoleConfig, ATLAS_CONFIG } from "./role.js";
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

export async function createBot(events: BotEvents, roleConfig: BotRoleConfig = ATLAS_CONFIG) {
  ensureNeuralServer().catch((e) => console.warn("[Bot] Neural spawn error:", e));

  // Load memory at startup — register with executor so skill results go to this bot's file.
  const memStore = new BotMemoryStore(roleConfig.memoryFile);
  memStore.load();
  // Auto-heal blacklisted skills that now have working files in the registry.
  // This prevents a skill from staying permanently broken after its file is created.
  memStore.healBrokenSkillsFromRegistry(new Set(skillRegistry.keys()));

  console.log(
    `[Bot] Connecting to ${config.mc.host}:${config.mc.port} as ${roleConfig.username}...`
  );

  const bot = mineflayer.createBot({
    host: config.mc.host,
    port: config.mc.port,
    username: roleConfig.username,
    version: config.mc.version,
    auth: config.mc.auth,
    // Increase keepalive timeout from 30s → 120s so heavy skill execution
    // (pathfinding, vm evaluation) doesn't cause disconnects
    checkTimeoutInterval: 120_000,
  });

  // Register per-bot memory store so executor records skill results to the right file.
  registerBotMemory(bot, memStore);

  // Load plugins
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp.plugin);
  bot.loadPlugin(autoEat);

  // State
  const pendingChatMessages: ChatMessage[] = [];
  const recentHistory: LLMMessage[] = [];
  // Maps canonical skill/action key → last failure message (cleared on success).
  // NOT pre-populated from memory — let the bot try fresh each session.
  // Memory context already warns the LLM about historically broken skills.
  const recentFailures = new Map<string, string>();
  // Count consecutive failures per action — only hard-blacklist after 2+ consecutive failures
  const failureCounts = new Map<string, number>();
  let successesSinceLastExpiry = 0;
  let isActing = false;
  let loopRunning = false;
  let lastAction = "";
  let lastResult = "";
  let repeatCount = 0;
  let lastActionWasSuccess = false;
  // Track directions that led to water — shown to LLM so it avoids them
  const waterDirections = new Set<string>();
  let currentGoal = "";
  let goalStepsLeft = 0;
  // Leash — tracks home position, set automatically when first house is built
  let homePos: { x: number; y: number; z: number } | null = roleConfig.homePos ?? null;

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

      // Stuck detection: repeating the same action — distinguish failure loops from success ruts
      if (repeatCount >= 2 && !lastActionWasSuccess) {
        contextStr += `\n\nIMPORTANT: You've tried "${lastAction}" ${repeatCount} times in a row and it keeps failing. You MUST choose a COMPLETELY DIFFERENT action. Abandon your current goal and try something new.`;
        currentGoal = "";
        goalStepsLeft = 0;
      } else if (repeatCount >= 3 && lastActionWasSuccess) {
        contextStr += `\n\nVARIETY CHECK: You've successfully done "${lastAction.replace(/^skill:/, "")}" ${repeatCount} times in a row. Great work — but you're in a rut! Move on to your next goal. Pick a DIFFERENT action that advances your overall progress.`;
        if (repeatCount >= 5 && lastAction !== "explore" && lastAction !== "gather_wood") {
          // Hard enforcement: temporarily block this action to force diversification.
          // Exclude explore/gather_wood — these are navigation primitives that may need many
          // iterations and should never be permanently blocked by the variety check.
          recentFailures.set(lastAction, `Repeated ${repeatCount} times successfully — time to move on to something else`);
        }
      }

      // Leash enforcement — keep bots from wandering too far from home
      if (homePos && roleConfig.leashRadius > 0) {
        const dx = bot.entity.position.x - homePos.x;
        const dz = bot.entity.position.z - homePos.z;
        const distFromHome = Math.sqrt(dx * dx + dz * dz);
        const leashPct = distFromHome / roleConfig.leashRadius;

        if (leashPct >= 1.5) {
          // Hard override — skip LLM entirely, go home now
          console.log(`[Bot] LEASH: ${distFromHome.toFixed(0)} blocks from home (limit ${roleConfig.leashRadius}) — overriding to go_to home`);
          const homeResult = await executeAction(bot, "go_to", homePos);
          events.onAction("go_to", homeResult);
          return;
        } else if (leashPct >= 0.8) {
          contextStr += `\n\nLEASH WARNING: You are ${distFromHome.toFixed(0)} blocks from home (max range: ${roleConfig.leashRadius} blocks). Do NOT explore further — start heading back toward home at (${homePos.x}, ${homePos.y}, ${homePos.z}).`;
        }
      }

      // Stash position hint — tells bot where to deposit excess resources
      if (roleConfig.stashPos) {
        const { x: sx, y: sy, z: sz } = roleConfig.stashPos;
        contextStr += `\n\nTHE STASH: Shared chest area at (${sx}, ${sy}, ${sz}). When your inventory is nearly full or you have excess materials, go_to The Stash and deposit them. Pick up materials from The Stash when you need them.`;
      }

      // Recent failures: show the LLM exactly what failed and why so it stops retrying
      // Strip the internal "skill:" prefix so the LLM sees the same name it would type
      if (recentFailures.size > 0) {
        const failLines = Array.from(recentFailures.entries())
          .map(([k, v]) => `- ${k.replace(/^skill:/, "")}: ${v}`)
          .join("\n");
        contextStr += `\n\nSKILLS/ACTIONS THAT JUST FAILED (DO NOT RETRY THESE):\n${failLines}\nChoose a DIFFERENT action.`;
      }

      // If the last action found trees, strongly hint to gather_wood now
      if (lastResult && /found trees nearby/i.test(lastResult)) {
        contextStr += "\n\n⚠️ TREES ARE NEARBY! Use gather_wood RIGHT NOW to collect logs. Don't explore further — you're standing next to trees!";
      }

      // Wood shortage warning: inject explicit gather_wood (or explore) instruction
      const logCount = bot.inventory.items()
        .filter(i => i.name.endsWith("_log"))
        .reduce((s: number, i: any) => s + i.count, 0);
      const plankCount = bot.inventory.items()
        .filter(i => i.name.endsWith("_planks"))
        .reduce((s: number, i: any) => s + i.count, 0);
      if (logCount === 0 && plankCount < 4) {
        const gatherWoodJustFailed = lastAction === "gather_wood" && !lastActionWasSuccess;
        const botZ = Math.floor(bot.entity.position.z);
        if (gatherWoodJustFailed) {
          // In Minecraft, Z increases going south. Forest zone is around Z=-200.
          // Bots spawn near Z=-333 which is north of the forest.
          const forestTargetZ = -200;
          const distToForest = forestTargetZ - botZ; // positive = need to go south
          if (distToForest > 20) {
            const stepsNeeded = Math.ceil(distToForest / 40);
            contextStr += `\n\n⚠️ WOOD SHORTAGE: gather_wood searched 128 blocks and found nothing. Previous structures were built with trees near Z=${forestTargetZ}. You are at Z=${botZ} — ${distToForest} blocks south. Explore SOUTH (repeat ~${stepsNeeded} times) until reaching Z=${forestTargetZ}, then use gather_wood. Do NOT explore north (ocean) or east (only ores there).`;
          } else {
            contextStr += `\n\n⚠️ WOOD SHORTAGE: gather_wood searched 128 blocks and found nothing. You're near Z=${botZ} (expected forest zone). Try exploring further south or west/northwest. Do NOT explore east (only ores) or north (ocean).`;
          }
        } else {
          contextStr += `\n\n⚠️ WOOD SHORTAGE: You have ${logCount} logs and ${plankCount} planks — NOT enough to craft. Use gather_wood NOW (searches 128 blocks including trees across water). Do NOT keep crafting, do NOT explore yet.`;
        }
      }

      // Warn LLM about ocean directions that lead to water (from past water-escape teleports)
      if (waterDirections.size > 0) {
        const dirs = Array.from(waterDirections).join(", ");
        contextStr += `\n\n⚠️ OCEAN WARNING: Exploring ${dirs} leads directly into the ocean. Use a DIFFERENT direction (${["north","south","east","west"].filter(d => !waterDirections.has(d)).join(", ")}) to find land, trees, and resources.`;
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

        // If safeSpawn is configured, always escape back to the known-safe area
        if (roleConfig.safeSpawn) {
          const { x: sx, z: sz } = roleConfig.safeSpawn;
          // Record which direction led to water so the LLM can avoid it
          if (lastAction === "explore" || lastAction.startsWith("explore")) {
            const lastDir = lastResult.match(/Explored (\w+)/)?.[1]?.toLowerCase();
            if (lastDir) waterDirections.add(lastDir);
          }
          console.log(`[Bot] In water — teleporting back to safeSpawn area (${sx},80,${sz})`);
          bot.chat(`/tp ${sx} 80 ${sz}`);
          await new Promise((r) => setTimeout(r, 3000));
          // Clear location-specific failures — they triggered away from home base and
          // are not relevant once we're back in the forest area.
          for (const k of ["skill:build_house", "skill:build_farm"]) {
            recentFailures.delete(k);
            failureCounts.delete(k);
          }
          return;
        }

        // No safeSpawn — try a few /tp attempts (spacing them out to avoid AFK kick)
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
            bot.chat(`/spawnpoint ${roleConfig.username} ${lx} ${ly} ${lz}`);
            foundLand = true;
            break;
          }
        }

        if (!foundLand) {
          // /tp likely failed (bot not OP) — ask user in chat and try pathfinder
          console.warn("[Bot] /tp failed — bot may not be OP. Asking for help.");
          bot.chat("I'm stuck in the ocean! Please /tp me to dry land, or run: /op " + roleConfig.username);
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
          bot.chat(`/spawnpoint ${roleConfig.username} ${tx} 80 ${tz}`);
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
      const memoryCtx = memStore.getMemoryContext();
      const decision = await queryLLM(contextStr, recentHistory.slice(-6), memoryCtx, {
        name: roleConfig.name,
        personality: roleConfig.personality,
        seasonGoal: memStore.getSeasonGoal(),
      });

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

      // Normalize action key: invoke_skill:X, direct skill call X, and any known skill name
      // all map to the same canonical "skill:<name>" key so streak/blacklist tracking works
      // regardless of which call pattern the LLM uses.
      const actionKey =
        decision.action === "invoke_skill" && decision.params?.skill
          ? `skill:${decision.params.skill}`
          : skillRegistry.has(decision.action)
          ? `skill:${decision.action}`
          // craft failures are item-specific — blacklist craft:item not all crafting.
          // LLMs sometimes put item in params.item and sometimes at top-level — check both.
          : decision.action === "craft" && (decision.params?.item ?? (decision as any).item)
          ? `craft:${decision.params?.item ?? (decision as any).item}`
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
      // Check both bare name and skill:-prefixed name to catch cross-prefix dynamic skill calls.
      // Also check go_to coordinate-specific keys (stored as "go_to:x,z") to block repeat visits.
      const goToCoordKey = decision.action === "go_to"
        ? `go_to:${decision.params?.x},${decision.params?.z}`
        : null;
      const isBlacklisted = recentFailures.has(actionKey)
        || recentFailures.has(`skill:${actionKey}`)
        || (goToCoordKey !== null && recentFailures.has(goToCoordKey));
      if (isBlacklisted) {
        const blockMsg = `Blocked: "${actionKey}" is in the failure blacklist. Choose a different action.`;
        console.log(`[Bot] ${blockMsg}`);
        events.onAction(decision.action, blockMsg);
        // Do NOT push to recentHistory — flooding history with block messages causes
        // the LLM to obsessively keep picking the same blocked action. The recentFailures
        // section in contextStr already tells the LLM what not to retry.
        isActing = false;
        return;
      }

      // Persistent broken-skills gate: block invoke_skill, generate_skill, AND direct dynamic
      // skill calls (LLMs sometimes call skill names as the action directly without invoke_skill).
      // Uses getPersistentBrokenSkillNames() (not getBrokenSkills) so built-in skills with precondition
      // failures (e.g. build_house "no trees", build_farm "no water") are never wrongly blocked.
      const persistentBroken = memStore.getPersistentBrokenSkillNames();
      if (decision.action === "invoke_skill" || decision.action === "generate_skill" || skillRegistry.has(decision.action)) {
        const targetName =
          decision.action === "invoke_skill"
            ? (decision.params?.skill as string | undefined)
            : decision.action === "generate_skill"
            ? undefined // generate_skill: check task text for a broken skill name
            : decision.action; // direct dynamic skill dispatch (e.g. "action": "mineFiveCoalOres")
        const taskText = (decision.params?.task as string | undefined) ?? "";
        const isTargetBroken =
          targetName
            ? persistentBroken.has(targetName)
            : [...persistentBroken].some((k) => taskText.includes(k));
        if (isTargetBroken) {
          const blockedName = targetName ?? "that skill";
          const altMsg =
            targetName?.toLowerCase().includes("shear") || targetName?.toLowerCase().includes("wool")
              ? "Use 'attack' on sheep to get wool (kill sheep, they drop 0-2 wool each)."
              : targetName?.toLowerCase().includes("zombie") || targetName?.toLowerCase().includes("kilone")
                ? "Combat is unreliable — explore, gather resources, build_house, or build_farm instead."
                : targetName?.toLowerCase().includes("coal") || targetName?.toLowerCase().includes("minewo")
                  ? "Use 'mine_block' with block='coal_ore' or 'oak_log' directly instead of dynamic skills."
                  : "Choose a completely different approach.";
          const blockMsg = `BLOCKED: '${blockedName}' is permanently broken — ${altMsg}`;
          console.log(`[Bot] ${blockMsg}`);
          events.onAction(decision.action, blockMsg);
          isActing = false;
          return;
        }
      }

      // Normalize params: LLMs sometimes put direction/skill/item at the top level instead of in params.
      // Merge any recognized top-level fields into params so executeAction can find them.
      const rawDecision = decision as Record<string, any>;
      const normalizedParams = { ...(decision.params ?? {}) };
      for (const field of ["direction", "skill", "item", "block", "blockType", "count", "x", "y", "z", "message"]) {
        if (rawDecision[field] !== undefined && normalizedParams[field] === undefined) {
          normalizedParams[field] = rawDecision[field];
        }
      }

      // Execute action
      const result = await executeAction(bot, decision.action, normalizedParams);
      lastResult = result;
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

      // Hallucinated action names — immediately block so the bot stops retrying different variants
      if (result.startsWith("Unknown action:")) {
        recentFailures.set(decision.action, "Unknown action — not in action list");
      }

      // Track failures for skill-type actions only (go_to/idle shouldn't pollute the list)
      // explore is intentionally excluded: it's a navigation primitive that handles its own errors
      // internally. Blacklisting it leads to permanent stuck states. The variety check (repeatCount)
      // already prevents explore ruts. go_to is also excluded for the same reason.
      const isSkillAction =
        skillRegistry.has(decision.action) ||
        decision.action === "invoke_skill" ||
        decision.action === "neural_combat" ||
        decision.action === "generate_skill" ||
        decision.action === "craft";
      const isSuccess = /complet|harvest|built|planted|smelted|crafted|arriv|gather|mined|caught|lit|bridg|chop|killed|ate|explored|placed|fished/i.test(result);

      // go_to "Already here!" is a soft-loop — blacklist this destination so the bot moves on
      if (decision.action === "go_to" && result === "Already here!") {
        recentFailures.set(`go_to:${decision.params?.x},${decision.params?.z}`, "Already at this location — pick a different destination or use explore");
      }
      lastActionWasSuccess = isSuccess;
      if (isSkillAction) {
        if (!isSuccess) {
          // "Already running skill X" means the skill runner was busy — the REQUESTED skill
          // never started, so this is not a real failure for that skill. Skip failure counting
          // to prevent skills like build_house from being wrongly blacklisted just because
          // a different skill was hogging the runner.
          const isAlreadyRunning = result.startsWith("Already running skill");
          if (!isAlreadyRunning) {
            const prevCount = (failureCounts.get(actionKey) ?? 0) + 1;
            failureCounts.set(actionKey, prevCount);
            // Only hard-blacklist after 2+ consecutive failures (single failures may be transient)
            if (prevCount >= 2) {
              recentFailures.set(actionKey, result.slice(0, 120));
            }
          }
          goalStepsLeft = Math.max(0, goalStepsLeft - 2);
        } else {
          failureCounts.delete(actionKey);
          recentFailures.delete(actionKey);
        }
      }
      // Every 8 successes (any action, including explore/go_to), expire the oldest blacklist
      // entry so stale location-specific failures don't linger forever.
      if (isSuccess) {
        successesSinceLastExpiry++;
        if (successesSinceLastExpiry >= 8 && recentFailures.size > 0) {
          successesSinceLastExpiry = 0;
          const firstKey = recentFailures.keys().next().value;
          if (firstKey) recentFailures.delete(firstKey);
        }
      }

      // Lock home position when first house is built
      if (isSuccess && decision.action === "build_house" && !homePos) {
        const p = bot.entity.position;
        homePos = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
        console.log(`[Bot] Home position locked at ${homePos.x}, ${homePos.y}, ${homePos.z}`);
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

    // !goal commands — set/clear the season goal from in-game
    if (message.startsWith("!goal")) {
      const parts = message.trim().split(/\s+/);
      const sub = parts[1]?.toLowerCase();
      if (sub === "set" && parts.length > 2) {
        const newGoal = parts.slice(2).join(" ");
        memStore.setSeasonGoal(newGoal);
        bot.chat(`Mission accepted: "${newGoal}"`);
      } else if (sub === "clear") {
        memStore.clearSeasonGoal();
        bot.chat("Season goal cleared. Going freeform.");
      } else if (sub === "show" || !sub) {
        const current = memStore.getSeasonGoal();
        bot.chat(current ? `Current mission: "${current}"` : "No season goal set. Use !goal set <text>");
      } else {
        bot.chat("Usage: !goal set <text> | !goal clear | !goal show");
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
    memStore.recordDeath(pos.x, pos.y, pos.z, cause);

    console.log("[Bot] I died! Respawning...");
    abortActiveSkill(bot);
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
  // Resolves once the first spawn safety run completes — gates the decision loop
  let resolveSpawnSafetyDone!: () => void;
  const spawnSafetyDone = new Promise<void>((r) => { resolveSpawnSafetyDone = r; });
  async function runSpawnSafety() {
    if (spawnSafetyRunning) return; // prevent concurrent runs (e.g. death mid-fall)
    spawnSafetyRunning = true;
    // Small delay for server to sync position
    await new Promise((r) => setTimeout(r, 800));

    // If a safe spawn location is configured, always TP there and set spawnpoint.
    // TP to Y=80 (just above typical forest floor ~Y=64) — bot falls < 1s, ~6 blocks = 1.5 hearts.
    if (roleConfig.safeSpawn) {
      const { x, z } = roleConfig.safeSpawn;
      console.log(`[Bot] safeSpawn configured — teleporting to ${x},80,${z}`);
      bot.chat(`/tp ${x} 80 ${z}`);
      // Wait for landing (falling from Y=80 to Y~64 takes < 2 seconds)
      const landDeadline = Date.now() + 8_000;
      while (!bot.entity.onGround && Date.now() < landDeadline) {
        await new Promise((r) => setTimeout(r, 200));
        // Abort if we landed in water (safeSpawn coords are in ocean) — fall through to water handler
        const feetBlock = bot.blockAt(bot.entity.position);
        if (feetBlock?.name === "water") break;
      }
      const feetCheck = bot.blockAt(bot.entity.position);
      if (feetCheck?.name === "water") {
        console.warn(`[Bot] safeSpawn landed in water at ${x},${z} — falling through to water handler`);
        // Don't set spawnpoint — the water handler will TP elsewhere
        spawnSafetyRunning = false;
        resolveSpawnSafetyDone();
        return;
      }
      const lx = Math.floor(bot.entity.position.x);
      const ly = Math.floor(bot.entity.position.y);
      const lz = Math.floor(bot.entity.position.z);
      console.log(`[Bot] Landed at ${lx},${ly},${lz} — setting spawnpoint`);
      bot.chat(`/spawnpoint ${roleConfig.username} ${lx} ${ly} ${lz}`);
      console.log(`[Bot] Spawnpoint set to safeSpawn area`);
      spawnSafetyRunning = false;
      resolveSpawnSafetyDone();
      return;
    }

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
          bot.chat(`/spawnpoint ${roleConfig.username} ${lx} ${ly} ${lz}`);
          console.log(`[Bot] Spawnpoint set to land at ${lx},${ly},${lz}`);
          foundLand = true;
          break;
        }
      }
      if (!foundLand) {
        console.warn("[Bot] Could not find dry land for spawnpoint");
      }
      spawnSafetyRunning = false;
      resolveSpawnSafetyDone();
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
        bot.chat(`/effect give ${roleConfig.username} slow_falling 60 1`);
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
    bot.chat(`/spawnpoint ${roleConfig.username} ${lx} ${ly} ${lz}`);
    console.log(`[Bot] Spawnpoint locked at ${lx},${ly},${lz}`);
    spawnSafetyRunning = false;
    resolveSpawnSafetyDone();
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

    // Start browser viewer on roleConfig viewer port
    startViewer(bot, roleConfig.viewerPort);

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
        seasonGoal: memStore.getSeasonGoal() ?? undefined,
      };
      if (isSkillRunning(bot)) {
        (overlayData as any).action = `[SKILL] ${getActiveSkillName(bot)}`;
      }
      updateOverlay(overlayData as any);
    }, 2000);

    // Continuous action loop — fires immediately after each action completes
    loopRunning = true;
    async function runLoop() {
      await spawnSafetyDone; // Wait for spawn safety to complete before first decision
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
