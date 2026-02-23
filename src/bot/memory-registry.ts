/**
 * Per-bot memory store registry.
 *
 * Extracted into its own module to avoid circular imports:
 *   executor.ts → registry.ts → build-house.ts → memory-registry.ts ← executor.ts (OK)
 *
 * Both executor.ts (skill recording) and build-house.ts (structure recording)
 * need per-bot stores. Having this in a separate leaf module breaks the cycle.
 */
import type { Bot } from "mineflayer";
import type { BotMemoryStore } from "./memory.js";

const memStoreMap = new Map<Bot, BotMemoryStore>();

export function registerBotMemory(bot: Bot, store: BotMemoryStore): void {
  memStoreMap.set(bot, store);
}

export function getBotMemoryStore(bot: Bot): BotMemoryStore | undefined {
  return memStoreMap.get(bot);
}
