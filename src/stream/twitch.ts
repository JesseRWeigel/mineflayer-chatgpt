import tmi from "tmi.js";
import { config } from "../config.js";
import type { ChatMessage } from "../bot/index.js";

export type ChatTier = "paid" | "sub" | "free";

export interface TieredChatMessage extends ChatMessage {
  tier: ChatTier;
  bits?: number;
}

function getTier(tags: tmi.ChatUserstate): ChatTier {
  // Bits = donation
  if (tags.bits && parseInt(tags.bits) > 0) return "paid";
  // Subscriber
  if (tags.subscriber) return "sub";
  // VIP or mod — treat as sub tier
  if (tags.mod || tags.vip) return "sub";
  return "free";
}

function formatForLLM(username: string, message: string, tier: ChatTier): string {
  const tag = tier === "paid" ? "[PAID]" : tier === "sub" ? "[SUB]" : "[FREE]";
  return `${tag} ${username}: ${message}`;
}

export function createTwitchChat(
  onMessage: (msg: TieredChatMessage) => void
): { client: tmi.Client; sendMessage: (msg: string) => void } | null {
  if (!config.twitch.enabled) {
    console.log("[Twitch] Not configured, skipping.");
    return null;
  }

  const client = new tmi.Client({
    options: { debug: false },
    identity: config.twitch.oauthToken
      ? {
          username: config.twitch.botUsername,
          password: config.twitch.oauthToken,
        }
      : undefined,
    channels: [config.twitch.channel],
  });

  client.on("message", (_channel, tags, message, self) => {
    if (self) return;
    const username = tags["display-name"] || tags.username || "viewer";
    const tier = getTier(tags);
    const bits = tags.bits ? parseInt(tags.bits) : undefined;

    console.log(`[Twitch] [${tier.toUpperCase()}] ${username}: ${message}`);

    onMessage({
      source: "twitch",
      username,
      message: formatForLLM(username, message, tier),
      timestamp: Date.now(),
      tier,
      bits,
    });
  });

  // Handle cheers (bits donations)
  client.on("cheer", (_channel, tags, message) => {
    const username = tags["display-name"] || tags.username || "viewer";
    const bits = tags.bits ? parseInt(tags.bits) : 0;
    console.log(`[Twitch] CHEER ${bits} bits from ${username}: ${message}`);

    onMessage({
      source: "twitch",
      username,
      message: formatForLLM(username, `[CHEERED ${bits} BITS] ${message}`, "paid"),
      timestamp: Date.now(),
      tier: "paid",
      bits,
    });
  });

  // Handle subscription events
  client.on("subscription", (_channel, username) => {
    console.log(`[Twitch] New sub: ${username}`);
    onMessage({
      source: "twitch",
      username,
      message: formatForLLM(username, "just subscribed! Welcome them!", "paid"),
      timestamp: Date.now(),
      tier: "paid",
    });
  });

  client.on("connected", () => {
    console.log(`[Twitch] Connected to #${config.twitch.channel}`);
  });

  client.on("disconnected", (reason) => {
    console.log(`[Twitch] Disconnected: ${reason}`);
    setTimeout(() => client.connect().catch(console.error), 5000);
  });

  client.connect().catch((err) => {
    console.error("[Twitch] Connection error:", err);
  });

  function sendMessage(msg: string) {
    if (config.twitch.oauthToken) {
      client.say(config.twitch.channel, msg).catch(console.error);
    }
  }

  return { client, sendMessage };
}
