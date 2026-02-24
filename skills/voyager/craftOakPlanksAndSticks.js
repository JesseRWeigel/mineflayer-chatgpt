async function craftOakPlanksAndSticks(bot) {
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
      throw new Error("Not enough wood to craft planks and sticks — gather wood first");
    }
  }

  const sticksCount = bot.inventory.count(mcData.itemsByName.stick.id);
  if (sticksCount < 4) {
    await craftItem(bot, "stick", 2);
    bot.chat("Crafted sticks.");
  }
}
