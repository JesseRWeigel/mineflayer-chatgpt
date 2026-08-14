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
//
// WHY THESE READ A FIXTURE AND NOT server/.
//
// They pointed at the live server directory, which is gitignored. On a fresh
// clone the reads returned empty, so half of them passed vacuously and the rest
// failed outright. Worse, "the team has not been to the nether" asserted on
// LIVE state -- it would start failing the moment the swarm succeeded at the
// exact thing this whole branch exists to make it do.
//
// The fixture is a copy of the five real files taken 2026-08-13, trimmed to the
// completed advancements plus two recipe entries so the exclusion path still
// has something to exclude.

const FIXTURE = "src/bot/__fixtures__/server";

test("offline UUIDs match what the server actually wrote", () => {
  // Verified against the live server/ai-world/advancements on 2026-08-13.
  assert.equal(offlineUUID("Atlas"), "1d4a9c61-6828-3517-9704-a0518eccaaa5");
  assert.equal(offlineUUID("Forge"), "2ddbb85b-90ad-320b-9e1f-c301c5383966");
  assert.equal(offlineUUID("Flora"), "fca4d5a4-b8c1-3fcc-8a0a-eb752019a2bb");
  assert.equal(offlineUUID("Mason"), "c12cc45b-0377-32a5-8fa0-d0f7cc95b22c");
  assert.equal(offlineUUID("Blade"), "a1c25b56-6d84-3914-8d8a-b6642a89c3fa");
});

test("the level name comes from server.properties, not a hardcoded 'world'", () => {
  assert.equal(levelName(FIXTURE), "ai-world");
});

test("a missing server.properties falls back to 'world' rather than throwing", () => {
  assert.equal(levelName("no/such/dir"), "world");
});

test("a bot with no progress file yields an empty set rather than throwing", () => {
  assert.deepEqual(readEarned("NoSuchBot", FIXTURE), new Set());
});

test("recipe unlocks are never counted as advancements", () => {
  // The fixture deliberately retains two recipe entries so this can fail.
  const earned = readEarned("Atlas", FIXTURE);
  assert.ok(![...earned].some((id) => id.startsWith("recipes/")));
});

test("ids are stored bare so they join against the tree", () => {
  const earned = readEarned("Atlas", FIXTURE);
  assert.ok(![...earned].some((id) => id.includes("minecraft:")));
});

test("Atlas has the diamond that made the old ladder terminal", () => {
  assert.ok(readEarned("Atlas", FIXTURE).has("story/mine_diamond"));
});

test("the team union is at least as large as any single member", () => {
  const roster = ["Atlas", "Flora", "Forge", "Mason", "Blade"];
  const team = readTeamEarned(roster, FIXTURE);
  for (const bot of roster) {
    for (const id of readEarned(bot, FIXTURE)) {
      assert.ok(team.has(id), `${id} earned by ${bot} missing from the union`);
    }
  }
});

test("the recorded 2026-08-13 baseline is 13 advancements, none nether or end", () => {
  // Pinned to the fixture, so this stays true after the swarm reaches the
  // nether. The live figure is what the CSV tracks; this is the baseline.
  const team = readTeamEarned(["Atlas", "Flora", "Forge", "Mason", "Blade"], FIXTURE);
  assert.equal(team.size, 13);
  assert.ok(![...team].some((id) => id.startsWith("nether/")));
  assert.ok(![...team].some((id) => id.startsWith("end/")));
});

// ── REGRESSION: a torn read is not amnesia ──
//
// Paper rewrites these 45KB files while the swarm runs, and readEarned runs on
// every decision cycle. Treating any failure as "earned nothing" meant one
// mid-write read could tell the model ADVANCEMENTS: 0/122 and, if it landed
// during appendSnapshot, write a spurious 0 row into the CSV that is the whole
// project's evidence of progress.

test("a missing file is genuinely zero, not a fallback", () => {
  assert.deepEqual(readEarned("NeverJoined", "server"), new Set());
});

test("a malformed file falls back to the last good read rather than to zero", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { offlineUUID } = await import("./advancement-progress.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-"));
  fs.writeFileSync(path.join(dir, "server.properties"), "level-name=w\n");
  const advDir = path.join(dir, "w", "advancements");
  fs.mkdirSync(advDir, { recursive: true });
  const file = path.join(advDir, `${offlineUUID("Torn")}.json`);

  fs.writeFileSync(file, JSON.stringify({ "minecraft:story/root": { done: true } }));
  assert.deepEqual(readEarned("Torn", dir), new Set(["story/root"]), "baseline good read");

  fs.writeFileSync(file, '{"minecraft:story/root": {"do');  // truncated mid-flush
  assert.deepEqual(
    readEarned("Torn", dir),
    new Set(["story/root"]),
    "a truncated read must not report zero progress",
  );

  fs.rmSync(dir, { recursive: true, force: true });
});
