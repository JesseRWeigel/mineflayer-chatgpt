// src/bot/advancement-progress.ts
//
// Ground truth: what the SERVER says each bot has accomplished.
//
// Everything else in this codebase learns about success from the bot that
// claims it. Paper writes advancement completion to disk as the authority, so
// this module is the one place where progress cannot be self-reported.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * With online-mode=false the server derives player UUIDs from the name alone:
 * a version-3 (MD5) UUID over "OfflinePlayer:<name>". Reproducing it here means
 * we can find a bot's progress file without the server running.
 */
export function offlineUUID(name: string): string {
  const md5 = crypto.createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = md5.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The world directory is configurable; ours is "ai-world", not "world". */
export function levelName(serverDir = "server"): string {
  try {
    const props = readFileSync(path.join(serverDir, "server.properties"), "utf-8");
    return /^level-name=(.+)$/m.exec(props)?.[1].trim() || "world";
  } catch {
    return "world";
  }
}

export function readEarned(botName: string, serverDir = "server"): Set<string> {
  const file = path.join(serverDir, levelName(serverDir), "advancements", `${offlineUUID(botName)}.json`);
  const earned = new Set<string>();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // A bot that has never joined has no file. Not an error — it has earned nothing.
    return earned;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === "DataVersion") continue;
    const id = key.replace(/^minecraft:/, "");
    // Recipe unlocks share the file but are not advancements.
    if (id.startsWith("recipes/")) continue;
    if (typeof value === "object" && value !== null && (value as { done?: boolean }).done) {
      earned.add(id);
    }
  }
  return earned;
}

export function readTeamEarned(botNames: string[], serverDir = "server"): Set<string> {
  const union = new Set<string>();
  for (const name of botNames) for (const id of readEarned(name, serverDir)) union.add(id);
  return union;
}
