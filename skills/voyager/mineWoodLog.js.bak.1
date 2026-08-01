async function mineWoodLog(bot) {
  const woodLogNames = ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log"];

  // Static search — no exploration, fail fast if trees aren't nearby
  const woodLogBlock = bot.findBlock({
    matching: block => woodLogNames.includes(block.name),
    maxDistance: 32
  });

  if (!woodLogBlock) {
    throw new Error("Could not find a wood log nearby — no trees within range");
  }

  await mineBlock(bot, woodLogBlock.name, 1);
  bot.chat("Wood log mined.");
}
