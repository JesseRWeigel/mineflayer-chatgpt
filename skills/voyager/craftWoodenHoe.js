async function craftWoodenHoe(bot) {
  const planksCount = bot.inventory.items()
    .filter(i => i.name.endsWith("_planks"))
    .reduce((s, i) => s + i.count, 0);

  if (planksCount < 2) {
    const logItem = bot.inventory.items().find(i => i.name.endsWith("_log"));
    const planksToCraft = Math.ceil((2 - planksCount) / 4);
    const logsCount = bot.inventory.items()
      .filter(i => i.name.endsWith("_log"))
      .reduce((s, i) => s + i.count, 0);
    if (logsCount >= planksToCraft) {
      await craftItem(bot, logItem.name.replace("_log", "_planks"), planksToCraft);
      bot.chat("Crafted planks.");
    } else {
      throw new Error("Not enough wood to craft planks for wooden hoe — gather wood first");
    }
  }

  const sticksCount = bot.inventory.count(mcData.itemsByName.stick.id);
  if (sticksCount < 2) {
    await craftItem(bot, "stick", 1);
    bot.chat("Crafted sticks.");
  }

  const craftingTablePosition = bot.entity.position.offset(1, 0, 0);
  await placeItem(bot, "crafting_table", craftingTablePosition);

  await craftItem(bot, "wooden_hoe", 1);
  bot.chat("Crafted a wooden hoe.");
}
