async function equipIronArmor(bot) {
  const ironLeggings = bot.inventory.findInventoryItem(mcData.itemsByName.iron_leggings.id);
  const ironBoots = bot.inventory.findInventoryItem(mcData.itemsByName.iron_boots.id);
  const ironHelmet = bot.inventory.findInventoryItem(mcData.itemsByName.iron_helmet.id);

  if (!ironLeggings && !ironBoots && !ironHelmet) {
    throw new Error("No iron armor in inventory — need to smelt iron ingots and craft armor first");
  }

  if (ironLeggings) await bot.equip(ironLeggings, "legs");
  if (ironBoots) await bot.equip(ironBoots, "feet");
  if (ironHelmet) await bot.equip(ironHelmet, "head");
}