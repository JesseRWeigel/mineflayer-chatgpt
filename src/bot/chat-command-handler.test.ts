import assert from "node:assert/strict";
import { test } from "node:test";
import { executeChatCommand, type CommandContext } from "./chat-command-handler.js";

function setup() {
  const messages: string[] = [];
  const calls: string[] = [];
  let goal: string | undefined = "build";
  const context: CommandContext = {
    bot: {
      health: 17,
      food: 12,
      inventory: { items: () => [{ name: "iron_pickaxe", count: 1 }] },
      chat: (message) => messages.push(message),
    },
    brain: {
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
      triggerReplan: () => calls.push("replan"),
      getStatus: () => ({ paused: false, action: "mining", goal: goal ?? "none" }),
    },
    memory: {
      getSeasonGoal: () => goal,
      setSeasonGoal: (value) => {
        goal = value;
        calls.push("set-goal");
      },
      clearSeasonGoal: () => {
        goal = undefined;
        calls.push("clear-goal");
      },
    },
    abortActiveSkill: () => calls.push("abort"),
    stopMovement: () => calls.push("stop"),
    goToPlayer: async (username) => calls.push(`goto:${username}`),
  };
  return { context, messages, calls, getGoal: () => goal };
}

test("status and inventory report live bot state", async () => {
  const state = setup();
  await executeChatCommand({ name: "status" }, "Owner", state.context);
  await executeChatCommand({ name: "inventory" }, "Owner", state.context);
  assert.deepEqual(state.messages, [
    "Active | action: mining | health: 17/20 | food: 12/20 | goal: build",
    "Inventory: iron_pickaxe x1",
  ]);
});

test("inventory is split into bounded chat messages without dropping items", async () => {
  const state = setup();
  state.context.bot.inventory.items = () =>
    Array.from({ length: 24 }, (_, index) => ({ name: `item_${index.toString().padStart(2, "0")}`, count: index + 1 }));
  await executeChatCommand({ name: "inventory" }, "Owner", state.context);
  assert.ok(state.messages.length > 1);
  assert.ok(state.messages.every((message) => message.length <= 240));
  for (let index = 0; index < 24; index++) {
    assert.ok(
      state.messages.some((message) => message.includes(`item_${index.toString().padStart(2, "0")} x${index + 1}`)),
    );
  }
});

test("come reports both navigation success and failure", async () => {
  const success = setup();
  await executeChatCommand({ name: "come" }, "Owner", success.context);
  assert.deepEqual(success.calls, ["pause", "abort", "stop", "goto:Owner", "resume"]);
  assert.deepEqual(success.messages, ["Arrived near Owner."]);

  const failure = setup();
  failure.context.goToPlayer = async () => {
    throw new Error("player is not visible");
  };
  await executeChatCommand({ name: "come" }, "Owner", failure.context);
  assert.deepEqual(failure.messages, ["Could not reach Owner: player is not visible"]);
  assert.deepEqual(failure.calls, ["pause", "abort", "stop", "resume"]);

  const alreadyPaused = setup();
  alreadyPaused.context.brain.getStatus = () => ({ paused: true, action: "idle", goal: "build" });
  await executeChatCommand({ name: "come" }, "Owner", alreadyPaused.context);
  assert.deepEqual(alreadyPaused.calls, ["pause", "abort", "stop", "goto:Owner"]);
});

test("stay pauses before aborting movement and resume restarts autonomy", async () => {
  const state = setup();
  await executeChatCommand({ name: "stay" }, "Owner", state.context);
  await executeChatCommand({ name: "resume" }, "Owner", state.context);
  assert.deepEqual(state.calls, ["pause", "abort", "stop", "resume"]);
});

test("goal commands update memory and request a fresh plan", async () => {
  const state = setup();
  await executeChatCommand({ name: "goal", operation: "set", text: "find diamonds" }, "Owner", state.context);
  assert.equal(state.getGoal(), "find diamonds");
  await executeChatCommand({ name: "goal", operation: "show" }, "Owner", state.context);
  await executeChatCommand({ name: "goal", operation: "clear" }, "Owner", state.context);
  assert.equal(state.getGoal(), undefined);
  assert.deepEqual(state.calls, ["set-goal", "replan", "clear-goal", "replan"]);
});
