import { createBot } from "./bot/index.js";
import { createTwitchChat } from "./stream/twitch.js";
import { startOverlay, addChatMessage } from "./stream/overlay.js";
import { config } from "./config.js";
import { loadDynamicSkills } from "./skills/dynamic-loader.js";

loadDynamicSkills();

const MAX_RESTARTS = 50;
const RESTART_DELAY_MS = 10000;
let restartCount = 0;
let overlayStarted = false;

async function startBot() {
  console.log(`\n=== Minecraft AI Streamer (restart #${restartCount}) ===`);
  console.log(`Bot name: ${config.bot.name}`);
  console.log(`LLM: ${config.ollama.model} @ ${config.ollama.host}`);
  console.log(
    `Server: ${config.mc.host}:${config.mc.port} (MC ${config.mc.version})`
  );
  console.log(`Decision interval: ${config.bot.decisionIntervalMs}ms`);
  console.log("");

  // Start overlay only once (it persists across bot restarts)
  if (!overlayStarted) {
    startOverlay(3001);
    overlayStarted = true;
  }

  // Create the bot
  const { bot, queueChat, stop } = await createBot({
    onThought: (thought) => {
      console.log(`💭 ${thought}`);
    },
    onAction: (action, result) => {
      console.log(`🎮 [${action}] ${result}`);
    },
    onChat: (message) => {
      console.log(`💬 ${message}`);
    },
  });

  // Set up Twitch chat
  const twitch = createTwitchChat((msg) => {
    queueChat(msg);
    addChatMessage(msg.username, msg.message, msg.tier);
  });

  // Auto-restart on disconnect/kick/error
  return new Promise<void>((resolve) => {
    bot.on("kicked", (reason) => {
      console.log(`[Bot] Kicked: ${JSON.stringify(reason)}`);
      stop();
      twitch?.client.disconnect();
      resolve();
    });

    bot.on("end", () => {
      console.log("[Bot] Connection ended.");
      stop();
      twitch?.client.disconnect();
      resolve();
    });

    bot.on("error", (err) => {
      console.error("[Bot] Error:", err);
    });

    // Graceful shutdown on SIGINT/SIGTERM
    const shutdown = () => {
      console.log("\n[Main] Shutting down (manual stop)...");
      stop();
      twitch?.client.disconnect();
      process.exit(0);
    };

    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    console.log("[Main] Bot is starting up. Waiting for spawn...");
  });
}

async function main() {
  while (restartCount < MAX_RESTARTS) {
    try {
      await startBot();
    } catch (err) {
      console.error("[Main] Bot crashed:", err);
    }

    restartCount++;
    if (restartCount >= MAX_RESTARTS) {
      console.error(`[Main] Max restarts (${MAX_RESTARTS}) reached. Giving up.`);
      process.exit(1);
    }

    console.log(`[Main] Restarting in ${RESTART_DELAY_MS / 1000}s... (attempt ${restartCount}/${MAX_RESTARTS})`);
    await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));
  }
}

main().catch((err) => {
  console.error("[Main] Fatal error:", err);
  process.exit(1);
});
