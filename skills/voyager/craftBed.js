async function craftBed(bot) {
  // Bed recipe: 3 wool (any same color) + 3 planks = 1 bed (needs crafting table)
  const woolColors = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink",
    "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];

  // Find which color wool we have >= 3 of
  let woolName = null;
  for (const color of woolColors) {
    const count = bot.inventory.count(mcData.itemsByName[color + "_wool"]?.id);
    if (count >= 3) { woolName = color + "_wool"; break; }
  }
  if (!woolName) throw new Error("Need at least 3 wool of the same color to craft a bed. Kill sheep to get wool.");

  // Need at least 3 planks
  const plankTypes = ["oak_planks", "birch_planks", "spruce_planks", "jungle_planks", "acacia_planks", "dark_oak_planks"];
  let planksName = null;
  for (const p of plankTypes) {
    if ((mcData.itemsByName[p]?.id) && bot.inventory.count(mcData.itemsByName[p].id) >= 3) {
      planksName = p; break;
    }
  }
  if (!planksName) throw new Error("Need at least 3 wooden planks to craft a bed. Chop trees for wood.");

  // Place a crafting table nearby if not already there
  const craftingTablePosition = bot.entity.position.offset(1, 0, 0);
  await placeItem(bot, "crafting_table", craftingTablePosition);

  // Craft the bed using the color of wool we have
  const bedName = woolName.replace("_wool", "_bed");
  await craftItem(bot, bedName, 1);
  bot.chat("Crafted a " + bedName + "!");
}
