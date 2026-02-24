async function craftTorch(bot) {
  // Torch recipe: 1 coal (or charcoal) + 1 stick = 4 torches (no crafting table needed)
  const coal = bot.inventory.items().find(i => i.name === "coal" || i.name === "charcoal");
  if (!coal) throw new Error("Could not find coal or charcoal — mine coal_ore with a pickaxe first");

  const stick = bot.inventory.items().find(i => i.name === "stick");
  if (!stick) throw new Error("Need sticks — craft 2 planks into 4 sticks first");

  // Use charcoal name if that's what we have
  const fuelName = coal.name;
  await craftItem(bot, "torch", 4);
  bot.chat("Crafted 4 torches!");
}
