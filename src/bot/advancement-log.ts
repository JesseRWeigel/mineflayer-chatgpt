// src/bot/advancement-log.ts
//
// An append-only record of what the swarm had achieved and when.
//
// Everything else here is a snapshot of the present. This is the only artifact
// that can answer "is it getting better?", which is the actual research
// question the project exists to answer.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { TOTAL_ADVANCEMENTS } from "./advancement-tree.js";
import { readTeamEarned } from "./advancement-progress.js";

const CATEGORIES = ["story", "nether", "end", "adventure", "husbandry"] as const;

export const CSV_HEADER = `timestamp,total,possible,${CATEGORIES.join(",")}`;

export function snapshotLine(earned: Set<string>, at: Date): string {
  const counts = CATEGORIES.map((c) => [...earned].filter((id) => id.startsWith(`${c}/`)).length);
  return `${at.toISOString()},${earned.size},${TOTAL_ADVANCEMENTS},${counts.join(",")}`;
}

export function appendSnapshot(botNames: string[], at: Date, file = "logs/advancement-progress.csv"): void {
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, CSV_HEADER + "\n");
  appendFileSync(file, snapshotLine(readTeamEarned(botNames), at) + "\n");
}
