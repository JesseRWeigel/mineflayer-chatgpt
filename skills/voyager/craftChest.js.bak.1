async function craftChest(bot) {
  const planksCount = bot.inventory.items()
    .filter(i => i.name.endsWith("_planks"))
    .reduce((s, i) => s + i.count, 0);

  if (planksCount < 8) {
    const logItem = bot.inventory.items().find(i => i.name.endsWith("_log"));
    const planksToCraft = Math.ceil((8 - planksCount) / 4);
    const logsCount = bot.inventory.items()
      .filter(i => i.name.endsWith("_log"))
      .reduce((s, i) => s + i.count, 0);
    if (logsCount >= planksToCraft) {
      await craftItem(bot, logItem.name.replace("_log", "_planks"), planksToCraft);
      bot.chat("Crafted planks.");
    } else {
      throw new Error("Not enough wood to craft planks for chest — gather wood first");
    }
  }

  const craftingTablePosition = bot.entity.position.offset(1, 0, 0);
  await placeItem(bot, "crafting_table", craftingTablePosition);

  await craftItem(bot, "chest", 1);
  bot.chat("Crafted a chest.");
}
