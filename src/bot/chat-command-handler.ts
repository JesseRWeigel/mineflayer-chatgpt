import type { ChatCommand } from "./chat-commands.js";

export interface CommandBot {
  health: number;
  food: number;
  inventory: { items(): Array<{ name: string; count: number }> };
  chat(message: string): void;
}

export interface CommandBrain {
  pause(): void;
  resume(): void;
  triggerReplan(): void;
  getStatus(): { paused: boolean; action: string; goal: string };
}

export interface CommandMemory {
  getSeasonGoal(): string | undefined;
  setSeasonGoal(goal: string): void;
  clearSeasonGoal(): void;
}

export interface CommandContext {
  bot: CommandBot;
  brain: CommandBrain;
  memory: CommandMemory;
  abortActiveSkill(): void;
  stopMovement(): void;
  goToPlayer(username: string): Promise<void>;
}

function sendInventory(bot: CommandBot, items: string[]): void {
  if (!items.length) {
    bot.chat("Inventory: empty");
    return;
  }
  let page = "Inventory:";
  for (const item of items) {
    const addition = `${page === "Inventory:" ? " " : ", "}${item}`;
    if (page.length + addition.length > 220) {
      bot.chat(page);
      page = `Inventory: ${item}`;
    } else {
      page += addition;
    }
  }
  bot.chat(page.slice(0, 240));
}

/** Execute a previously authorized and safety-checked player command. */
export async function executeChatCommand(
  command: ChatCommand,
  username: string,
  context: CommandContext,
): Promise<void> {
  const { bot, brain, memory } = context;
  switch (command.name) {
    case "status": {
      const status = brain.getStatus();
      bot.chat(
        (
          `${status.paused ? "Paused" : "Active"} | action: ${status.action} | ` +
          `health: ${bot.health}/20 | food: ${bot.food}/20 | goal: ${status.goal}`
        ).slice(0, 240),
      );
      return;
    }
    case "come": {
      const wasPaused = brain.getStatus().paused;
      brain.pause();
      context.abortActiveSkill();
      context.stopMovement();
      try {
        await context.goToPlayer(username);
        bot.chat(`Arrived near ${username}.`);
      } catch (error) {
        bot.chat(`Could not reach ${username}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (!wasPaused) brain.resume();
      }
      return;
    }
    case "stay":
      brain.pause();
      context.abortActiveSkill();
      context.stopMovement();
      bot.chat("Paused. I will hold position until !resume.");
      return;
    case "resume":
      brain.resume();
      bot.chat("Autonomous behavior resumed.");
      return;
    case "inventory": {
      const contents = bot.inventory.items().map((item) => `${item.name} x${item.count}`);
      sendInventory(bot, contents);
      return;
    }
    case "goal":
      if (command.operation === "set") {
        memory.setSeasonGoal(command.text);
        brain.triggerReplan();
        bot.chat(`Mission accepted: "${command.text}"`.slice(0, 240));
      } else if (command.operation === "clear") {
        memory.clearSeasonGoal();
        brain.triggerReplan();
        bot.chat("Season goal cleared. Going freeform.");
      } else {
        const current = memory.getSeasonGoal();
        bot.chat(current ? `Current mission: "${current}"` : "No season goal set. Use !goal set <text>");
      }
  }
}
