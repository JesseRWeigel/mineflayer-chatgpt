// scripts/advancement-report.ts
//
// Emit the swarm's advancement ledger as JSON, from the server's own files.
//
// The one rule: nothing in this report is self-reported by a bot. Paper writes
// advancement completion to disk as the authority, and this reads those files
// directly — the same ground truth the curriculum uses. Timestamps are the
// earliest criterion time across the team; credit goes to every bot that has
// the advancement, with the earliest earner(s) listed first.
//
// Usage:
//   npx tsx scripts/advancement-report.ts            # JSON to stdout
//   npx tsx scripts/advancement-report.ts --out FILE # write to FILE

import fs from "node:fs";
import { offlineUUID, levelName } from "../src/bot/advancement-progress.js";
import { ALL_ADVANCEMENTS, TOTAL_ADVANCEMENTS, getAdvancement } from "../src/bot/advancement-tree.js";
import { BOT_ROSTER } from "../src/bot/role.js";

interface Entry {
  id: string;
  title: string;
  description: string;
  category: string;
  earnedAt: string; // ISO date of the earliest criterion across the team
  by: string[]; // bots holding it, earliest first
}

const lvl = levelName("server");
const perBot = new Map<string, Map<string, string>>(); // bot -> id -> earliest time

for (const b of BOT_ROSTER.map((r) => r.name)) {
  const file = `server/${lvl}/advancements/${offlineUUID(b)}.json`;
  if (!fs.existsSync(file)) continue;
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
    string,
    { done?: boolean; criteria?: Record<string, string> }
  >;
  const mine = new Map<string, string>();
  for (const [rawId, v] of Object.entries(data)) {
    if (!rawId.startsWith("minecraft:") || rawId.includes("recipes/")) continue;
    if (!v.done) continue;
    const when = Object.values(v.criteria ?? {}).sort()[0] ?? "";
    mine.set(rawId.replace("minecraft:", ""), when);
  }
  perBot.set(b, mine);
}

const entries = new Map<string, Entry>();
for (const [bot, mine] of perBot) {
  for (const [id, when] of mine) {
    const node = getAdvancement(id);
    const cur = entries.get(id);
    if (!cur) {
      entries.set(id, {
        id,
        title: node?.title ?? id,
        description: node?.description ?? "",
        category: id.split("/")[0],
        earnedAt: when,
        by: [bot],
      });
    } else {
      cur.by.push(bot);
      if (when < cur.earnedAt) {
        cur.earnedAt = when;
        cur.by = [bot, ...cur.by.filter((x) => x !== bot)];
      }
    }
  }
}

const sorted = [...entries.values()].sort((a, b) => a.earnedAt.localeCompare(b.earnedAt));

const categories: Record<string, { earned: number; total: number }> = {};
for (const a of ALL_ADVANCEMENTS) {
  const c = (categories[a.category] ??= { earned: 0, total: 0 });
  c.total++;
}
for (const e of sorted) categories[e.category].earned++;

const report = {
  generatedAt: new Date().toISOString(),
  earned: sorted.length,
  total: TOTAL_ADVANCEMENTS,
  categories,
  entries: sorted,
};

const outFlag = process.argv.indexOf("--out");
const json = JSON.stringify(report, null, 2);
if (outFlag !== -1 && process.argv[outFlag + 1]) {
  fs.writeFileSync(process.argv[outFlag + 1], json);
  console.log(`Wrote ${sorted.length}/${TOTAL_ADVANCEMENTS} advancements to ${process.argv[outFlag + 1]}`);
} else {
  console.log(json);
}
