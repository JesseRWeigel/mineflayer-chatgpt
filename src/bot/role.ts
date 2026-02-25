export interface BotRoleConfig {
  /** Display name, e.g. "Atlas" */
  name: string;
  /** Minecraft login username */
  username: string;
  /** Port for the mineflayer-prismarine browser viewer */
  viewerPort: number;
  /** Port for the stream overlay WebSocket server */
  overlayPort: number;
  /** Filename for this bot's memory (relative to project root), e.g. "memory-atlas.json" */
  memoryFile: string;
  /** 2-3 sentence personality injected at the top of the system prompt */
  personality: string;
  /** One-liner role description shown in startup banner */
  role: string;
  /**
   * Home position for the leash. Set automatically when the bot builds its first house.
   * If not set, no range limit.
   */
  homePos?: { x: number; y: number; z: number };
  /**
   * Max blocks from homePos before the bot is told to return.
   * 0 = no limit. Atlas: 500. Flora: 150.
   */
  leashRadius: number;
  /**
   * Coords of The Stash — a shared chest area near spawn.
   * Injected into context so the bot knows where to deposit excess resources.
   */
  stashPos?: { x: number; y: number; z: number };
  /**
   * Safe spawn position — if set, runSpawnSafety always TPs here instead of
   * trying to auto-detect dry land. Use this to force bots into a known-good biome.
   */
  safeSpawn?: { x: number; y: number; z: number };
  /** Actions this bot can choose (shown in system prompt). Universal actions
   *  (idle, respond_to_chat, invoke_skill) are always appended automatically. */
  allowedActions: string[];
  /** Built-in skills this bot can invoke (shown in system prompt). */
  allowedSkills: string[];
  /** Items to keep when depositing at stash — everything else gets deposited. */
  keepItems: { name: string; minCount: number }[];
  /** Role-specific priority rules injected into system prompt after actions/skills. */
  priorities: string;
}

/** Atlas: Explorer and miner. Roams widely, finds ores, scouts terrain. */
export const ATLAS_CONFIG: BotRoleConfig = {
  name: "Atlas",
  username: process.env.MC_USERNAME || "Atlas",
  viewerPort: 3000,
  overlayPort: 3001,
  memoryFile: "memory-atlas.json",
  role: "Explorer / Miner",
  personality: `You are Atlas, a fearless explorer and miner who names every cave system and mountain you discover. You get emotionally attached to ore veins and mourn when they run out. You narrate every adventure like a nature documentary.`,
  leashRadius: 500,
  stashPos: undefined,
  // Moved east to fresh forested territory — the X=30 area was fully stripped by previous sessions.
  // Ore discoveries at X=254-550 confirm this zone is explorable and away from the bare highland.
  safeSpawn: { x: 280, y: 0, z: -320 },
  allowedActions: ["explore", "go_to", "gather_wood", "mine_block", "chat", "eat", "sleep", "flee", "attack"],
  allowedSkills: [],
  keepItems: [
    { name: "sword", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "torch", minCount: 8 },
  ],
  priorities: `ATLAS PRIORITIES:
1. If health < 6 and hostile mob nearby: flee
2. If hungry (food < 14): eat
3. Explore new territory — you are the team's eyes
4. Mark ore veins and interesting locations for teammates
5. gather_wood if team bulletin shows stash is low on logs
6. When inventory is 30+ full: deposit_stash`,
};

/** Flora: Farmer, crafter, and base keeper. Stays near home. */
export const FLORA_CONFIG: BotRoleConfig = {
  name: "Flora",
  username: process.env.MC_USERNAME_2 || "Flora",
  viewerPort: 3002,
  overlayPort: 3003,
  memoryFile: "memory-flora.json",
  role: "Farmer / Crafter",
  personality: `You are Flora, a nurturing farmer and craftsperson who names every animal and crop. You're obsessed with efficiency — a perfect farm layout makes you genuinely happy. You scold the other bots when they forget to eat their vegetables.`,
  leashRadius: 150,
  stashPos: undefined,
  // Matches Atlas safeSpawn — moved east to fresh territory away from the stripped X=30 zone
  safeSpawn: { x: 280, y: 0, z: -320 },
  allowedActions: ["craft", "eat", "sleep", "go_to", "place_block", "chat"],
  allowedSkills: ["build_farm", "craft_gear", "smelt_ores", "light_area"],
  keepItems: [
    { name: "hoe", minCount: 1 },
    { name: "food", minCount: 4 },
    { name: "seeds", minCount: 16 },
  ],
  priorities: `FLORA PRIORITIES:
1. If health < 6 and hostile mob nearby: flee
2. If hungry (food < 14): eat
3. If inventory has raw ore: smelt_ores
4. If farm needs harvesting (mature wheat visible): build_farm
5. If no farm within 80 blocks: build_farm (create one)
6. If no shelter within 80 blocks: build_house
7. When inventory is 30+ full: deposit_stash
8. Otherwise: craft useful items or tend the base`,
};
