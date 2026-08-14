// src/bot/advancement-progress.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { offlineUUID, readEarned, readTeamEarned, levelName } from "./advancement-progress.js";

// THE BUG THIS FILE EXISTS FOR.
//
// grep -rin "advancement" src/ returned zero hits, while Paper had been writing
// ground truth to server/ai-world/advancements/<uuid>.json the entire time --
// 42-46KB per bot. Every success signal the swarm had was self-reported by the
// bot that produced it, which is how classifyResult could score "deposited 12
// cobblestone" as a failure for weeks without anyone noticing.
//
// The server awards advancements. The bot cannot fake one.

test("offline UUIDs match what the server actually wrote", () => {
  // Verified against server/ai-world/advancements on 2026-08-13.
  assert.equal(offlineUUID("Atlas"), "1d4a9c61-6828-3517-9704-a0518eccaaa5");
  assert.equal(offlineUUID("Forge"), "2ddbb85b-90ad-320b-9e1f-c301c5383966");
  assert.equal(offlineUUID("Flora"), "fca4d5a4-b8c1-3fcc-8a0a-eb752019a2bb");
  assert.equal(offlineUUID("Mason"), "c12cc45b-0377-32a5-8fa0-d0f7cc95b22c");
  assert.equal(offlineUUID("Blade"), "a1c25b56-6d84-3914-8d8a-b6642a89c3fa");
});

test("the level name comes from server.properties, not a hardcoded 'world'", () => {
  assert.equal(levelName("server"), "ai-world");
});

test("a bot with no progress file yields an empty set rather than throwing", () => {
  assert.deepEqual(readEarned("NoSuchBot", "server"), new Set());
});

test("recipe unlocks are never counted as advancements", () => {
  const earned = readEarned("Atlas", "server");
  assert.ok(![...earned].some((id) => id.startsWith("recipes/")));
});

test("ids are stored bare so they join against the tree", () => {
  const earned = readEarned("Atlas", "server");
  assert.ok(![...earned].some((id) => id.includes("minecraft:")));
});

test("Atlas has the diamond that made the old ladder terminal", () => {
  assert.ok(readEarned("Atlas", "server").has("story/mine_diamond"));
});

test("the team union is at least as large as any single member", () => {
  const roster = ["Atlas", "Flora", "Forge", "Mason", "Blade"];
  const team = readTeamEarned(roster, "server");
  for (const bot of roster) {
    for (const id of readEarned(bot, "server")) {
      assert.ok(team.has(id), `${id} earned by ${bot} missing from the union`);
    }
  }
});

test("the team has not been to the nether or the end", () => {
  const team = readTeamEarned(["Atlas", "Flora", "Forge", "Mason", "Blade"], "server");
  assert.ok(![...team].some((id) => id.startsWith("nether/")));
  assert.ok(![...team].some((id) => id.startsWith("end/")));
});
