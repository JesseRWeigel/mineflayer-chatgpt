async function craftCraftingTable(bot) {
  const planksCount = bot.inventory.items()
    .filter(i => i.name.endsWith("_planks"))
    .reduce((s, i) => s + i.count, 0);

  if (planksCount < 4) {
    const logItem = bot.inventory.items().find(i => i.name.endsWith("_log"));
    if (!logItem) {
      throw new Error("Not enough wood to craft a crafting table — gather wood first");
    }
    const planksToCraft = Math.ceil((4 - planksCount) / 4);
    await craftItem(bot, logItem.name.replace("_log", "_planks"), planksToCraft);
    bot.chat("Crafted planks.");
  }

  await craftItem(bot, "crafting_table", 1);
  bot.chat("Crafted a crafting table.");
}
