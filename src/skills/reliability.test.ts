import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetired, checkRetiredWithParole } from "./reliability.js";
import { registerBotMemory } from "../bot/memory-registry.js";
import type { BotMemoryStore } from "../bot/memory.js";
import type { Bot } from "mineflayer";

// A store whose history has thoroughly proven one skill broken (8 real
// failures, no precondition excuses) and left another untouched.
const failures = Array.from({ length: 8 }, () => ({
  skill: "craftWoodenPickaxe",
  success: false,
  durationSeconds: 5,
  notes: "Crashed: portal frame collapsed",
  timestamp: "2026-08-16T00:00:00.000Z",
}));
const fakeStore = { getSkillHistory: () => failures } as unknown as BotMemoryStore;
registerBotMemory({} as Bot, fakeStore);

test("a 0/8 skill is retired", () => {
  assert.equal(isRetired("craftWoodenPickaxe"), true);
  assert.equal(isRetired("smelt_ores"), false);
});

test("the FIRST blocked invocation after process start is paroled", () => {
  // Restarts follow code changes here — a freshly-fixed skill must get one
  // attempt immediately, not after 10 refusals the model will never rack up
  // (it learns to stop choosing a skill that keeps answering RETIRED).
  assert.equal(checkRetiredWithParole("craftWoodenPickaxe"), false, "block #1 must let the attempt through");
  assert.equal(checkRetiredWithParole("craftWoodenPickaxe"), true, "block #2 is refused");
});

test("after the restart parole, every 10th block is paroled", () => {
  // Blocks #3-#9 refused, #10 paroled.
  for (let block = 3; block <= 9; block++) {
    assert.equal(checkRetiredWithParole("craftWoodenPickaxe"), true, `block #${block} is refused`);
  }
  assert.equal(checkRetiredWithParole("craftWoodenPickaxe"), false, "block #10 is paroled");
});

test("a healthy skill is never gated", () => {
  assert.equal(checkRetiredWithParole("smelt_ores"), false);
});

test("essential hand-written infra skills are exempt even at 0/8", () => {
  // A dark portal that cannot relight strands the whole Nether strategy —
  // build_nether_portal must never retire no matter how ugly its history.
  const portalFails = Array.from({ length: 20 }, () => ({
    skill: "build_nether_portal",
    success: false,
    durationSeconds: 5,
    notes: "Crashed: portal frame collapsed",
    timestamp: "2026-08-16T00:00:00.000Z",
  }));
  registerBotMemory({} as Bot, { getSkillHistory: () => portalFails } as unknown as BotMemoryStore);
  assert.equal(isRetired("build_nether_portal"), false, "infra skill must be exempt from retirement");
});
