async function craftWoodenPickaxe(bot) {
  // check if crafting table is in the inventory
  const craftingTableCount = bot.inventory.count(
    mcData.itemsByName.crafting_table.id
  );

  // If not, craft a crafting table (only needs planks, no logs)
  if (craftingTableCount === 0) {
    await craftCraftingTable(bot);
  }

  // Need at least 3 planks for the pickaxe head
  const oakPlanksCount = bot.inventory.count(mcData.itemsByName.oak_planks.id);

  if (oakPlanksCount < 3) {
    // Try to craft planks from logs in inventory first
    const oakLogsCount = bot.inventory.count(mcData.itemsByName.oak_log.id);
    if (oakLogsCount > 0) {
      await craftItem(bot, "oak_planks", 1);
      bot.chat("Crafted oak planks from logs.");
    } else {
      // No logs in inventory — try to mine some nearby
      try {
        await mineBlock(bot, "oak_log", 1);
        await craftItem(bot, "oak_planks", 1);
        bot.chat("Mined and crafted oak planks.");
      } catch (e) {
        throw new Error("Cannot find oak_log nearby — need wood to craft planks");
      }
    }
  }

  // Check if there are enough sticks in the inventory
  const sticksCount = bot.inventory.count(mcData.itemsByName.stick.id);

  // If not, craft sticks from oak planks
  if (sticksCount < 2) {
    await craftItem(bot, "stick", 1);
    bot.chat("Crafted sticks.");
  }

  // Place the crafting table near the bot
  const craftingTablePosition = bot.entity.position.offset(1, 0, 0);
  await placeItem(bot, "crafting_table", craftingTablePosition);

  // Craft a wooden pickaxe using the crafting table
  await craftItem(bot, "wooden_pickaxe", 1);
  bot.chat("Crafted a wooden pickaxe.");
}
