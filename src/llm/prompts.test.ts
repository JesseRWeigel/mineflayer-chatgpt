import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCriticPrompt, resolveAllowedActions, buildStrategicPrompt } from "./prompts.js";

// Role action lists as configured in src/bot/role.ts.
const ROLES: Record<string, string[]> = {
  Blade: ["attack", "flee", "go_to", "eat", "sleep", "chat"],
  Flora: ["explore", "go_to", "gather_wood", "mine_block", "chat", "eat", "sleep", "flee", "attack"],
  Forge: ["craft", "eat", "sleep", "go_to", "place_block", "chat", "flee"],
  Mason: ["go_to", "place_block", "craft", "gather_wood", "eat", "sleep", "chat", "flee"],
  Atlas: ["mine_block", "gather_wood", "go_to", "eat", "sleep", "craft", "chat", "flee"],
};

// Without these a specialised role has no legal way to gather, fetch from the
// stash, or run a learned skill, and the critic can only answer "idle".
const ESCAPE_HATCHES = ["invoke_skill", "withdraw_stash", "explore", "idle"];

// Regression: the critic prompt says "Only suggest actions from this list", so
// an action missing there is an action the bot can never be told to take. The
// critic used to receive raw role.allowedActions + "idle" while the planner
// merged in the universal actions, which idled bots mid-goal with reasons like
// "No action can actually gather logs, so we'll just idle for now".
for (const [name, roleActions] of Object.entries(ROLES)) {
  test(`critic prompt for ${name} exposes every escape hatch`, () => {
    const prompt = buildCriticPrompt(name, roleActions);

    for (const action of ESCAPE_HATCHES) {
      assert.ok(prompt.includes(action), `critic prompt for ${name} is missing "${action}"`);
    }
  });

  test(`critic prompt for ${name} still exposes its own role actions`, () => {
    const prompt = buildCriticPrompt(name, roleActions);

    for (const action of roleActions) {
      assert.ok(prompt.includes(action), `critic prompt for ${name} dropped role action "${action}"`);
    }
  });

  test(`critic and planner resolve the same actions for ${name}`, () => {
    const resolved = resolveAllowedActions(roleActions);
    const prompt = buildCriticPrompt(name, roleActions);

    for (const action of resolved) {
      assert.ok(prompt.includes(action), `critic cannot name planner action "${action}" for ${name}`);
    }
  });
}

test("resolveAllowedActions falls back to the full action list", () => {
  const full = resolveAllowedActions(undefined);

  assert.ok(full.includes("invoke_skill"));
  assert.ok(full.includes("withdraw_stash"));
  assert.ok(full.length > ESCAPE_HATCHES.length);
  assert.deepEqual(resolveAllowedActions([]), full, "empty list should behave like undefined");
});

test("resolveAllowedActions does not duplicate actions a role already declares", () => {
  // Flora already declares explore; it must not appear twice.
  const resolved = resolveAllowedActions(ROLES.Flora);
  const explores = resolved.filter((a) => a === "explore");

  assert.equal(explores.length, 1, "explore was duplicated");
  assert.equal(new Set(resolved).size, resolved.length, "resolved list contains duplicates");
});

test("critic prompt always constrains action choice", () => {
  // Previously an unconfigured role produced no action line at all, letting the
  // critic invent action names.
  const prompt = buildCriticPrompt("Nomad", undefined);

  assert.ok(prompt.includes("AVAILABLE ACTIONS"));
  assert.ok(prompt.includes("Only suggest actions from this list."));
});

// THE BUG THIS ADDITION EXISTS FOR.
//
// Measured 2026-08-15: Forge's context was perfect — goal "Hot Stuff"
// (story/lava_bucket), a HOW naming craft_bucket then fill_bucket, and
// fill_bucket present in its SKILLS list. It spent the hour on deposit_stash
// instead: 52 picks, 19 of them blocked as recently-failed and 19 returning
// "Banked nothing — everything I'm carrying is gear I'm keeping". Zero
// invoke_skill calls all hour.
//
// The role priorities are eight numbered prescriptive rules in the SYSTEM
// prompt; the advancement goal was one line of state in the user message. None
// of the eight mention lava or the nether. The model followed the numbered
// list, which is what a numbered list in a system prompt is for.
//
// Ranking them explicitly is cheaper than rewriting five roles' priorities.

test("the prompt subordinates maintenance priorities to the advancement goal", () => {
  const p = buildStrategicPrompt({
    name: "Forge",
    personality: "gruff",
    role: "Miner / Smelter",
    priorities: "FORGE PRIORITIES:\n1. mine\n6. When inventory is 30+ full: deposit_stash",
  });
  assert.match(p, /MAINTENANCE, NOT THE MISSION/);
  // The ranking has to come after the priorities, or it reads as a preamble to
  // them rather than a correction of them.
  assert.ok(p.indexOf("MAINTENANCE, NOT THE MISSION") > p.indexOf("FORGE PRIORITIES"));
});

test("the prompt tells the bot not to repeat a no-op action", () => {
  const p = buildStrategicPrompt({ name: "Forge", personality: "gruff", role: "Miner / Smelter" });
  assert.match(p, /Banked nothing/);
  assert.match(p, /do NOT\s*\n?repeat it|do NOT repeat it/);
});
