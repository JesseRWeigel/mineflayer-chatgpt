import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder } = pathfinderPkg;
import customPvpPkg from "@nxg-org/mineflayer-custom-pvp";
const customPvp = (customPvpPkg as any).default ?? customPvpPkg;
import { loader as autoEat } from "mineflayer-auto-eat";
import { config } from "../config.js";
import { registerBot as registerViewerBot, isUnifiedViewerStarted } from "../stream/unified-viewer.js";
import { startViewer } from "../stream/viewer.js";
import { addChatMessage, setCurrentBot } from "../stream/overlay.js";
import { abortActiveSkill } from "../skills/executor.js";
import { registerBotMemory } from "./memory-registry.js";
import { skillRegistry } from "../skills/registry.js";
import { BotMemoryStore } from "./memory.js";
import { BotRoleConfig, ATLAS_CONFIG } from "./role.js";
import { spawn } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { isNeuralServerRunning } from "../neural/bridge.js";
import { BotBrain, type ChatMessage, type BrainEvents } from "./brain.js";
import { recordDeath, startScoreboard } from "./scoreboard.js";
import { createFallTracker } from "./fall-tracker.js";
import { respawnTarget, isAtBase } from "./respawn.js";
import { shouldFleeOnRespawn } from "./respawn-safety.js";
import { isHostile } from "./perception.js";
import { executeAction } from "./actions.js";
import { Vec3 } from "vec3";

// Re-export types used by src/index.ts
export type { ChatMessage, BrainEvents as BotEvents };

async function ensureNeuralServer(): Promise<void> {
  if (await isNeuralServerRunning()) {
    console.log("[Bot] Neural server already running.");
    return;
  }
  console.log("[Bot] Starting neural server...");
  const proc = spawn("python3", [path.resolve(__dirname, "../../neural_server.py")], { stdio: "pipe" });
  proc.stdout?.on("data", (d) => console.log(`[Neural] ${d.toString().trim()}`));
  proc.stderr?.on("data", (d) => console.log(`[Neural] ${d.toString().trim()}`));
  proc.on("exit", (code) => console.log(`[Neural] Server exited (${code})`));

  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isNeuralServerRunning()) {
      console.log("[Bot] Neural server ready.");
      return;
    }
  }
  console.warn("[Bot] Neural server timed out — combat fallback active.");
}

export async function createBot(events: BrainEvents, roleConfig: BotRoleConfig = ATLAS_CONFIG) {
  startScoreboard();
  ensureNeuralServer().catch((e) => console.warn("[Bot] Neural spawn error:", e));

  // Load memory — register with executor so skill results go to this bot's file.
  const memStore = new BotMemoryStore(roleConfig.memoryFile);
  memStore.load();
  memStore.healBrokenSkillsFromRegistry(new Set(skillRegistry.keys()));

  console.log(`[Bot] Connecting to ${config.mc.host}:${config.mc.port} as ${roleConfig.username}...`);

  const bot = mineflayer.createBot({
    host: config.mc.host,
    port: config.mc.port,
    username: roleConfig.username,
    version: config.mc.version,
    auth: config.mc.auth,
    checkTimeoutInterval: 120_000,
  });

  registerBotMemory(bot, memStore);

  // Load plugins
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(customPvp);
  bot.loadPlugin(autoEat);

  // ── Create the event-driven brain ──
  const brain = new BotBrain(bot, roleConfig, events, memStore);

  // ── Spawn safety ──────────────────────────────────────────────────────────
  let spawnSafetyRunning = false;
  let resolveSpawnSafetyDone!: () => void;
  const spawnSafetyDone = new Promise<void>((r) => {
    resolveSpawnSafetyDone = r;
  });

  async function runSpawnSafety() {
    if (spawnSafetyRunning) return;
    spawnSafetyRunning = true;
    await new Promise((r) => setTimeout(r, 800));

    // Go straight home when there is a base to go to.
    //
    // safeSpawn resolves to terrain at y=117-121 — a mountain. spreadplayers put
    // the bot there on EVERY call, and c3c7808 then teleported it back down, so
    // the bot spent a live window standing on a peak 50 blocks above its base.
    // Across 33 relocations that window produced 13 fall deaths, all from y=119
    // and y=121, the exact altitudes in the "Landed at" lines.
    //
    // Correcting a hazard after deliberately creating it cannot beat not
    // creating it. The stash is proven standable — bots path to it and stand
    // there to deposit all day — so it is a better spawn than the topmost block
    // of whatever terrain safeSpawn happens to name.
    if (roleConfig.stashPos) {
      const s = roleConfig.stashPos;
      bot.chat(`/spawnpoint ${roleConfig.username} ${s.x} ${s.y} ${s.z}`);
      await new Promise((r) => setTimeout(r, 400));
      bot.chat(`/tp ${roleConfig.username} ${s.x} ${s.y + 1} ${s.z}`);
      await new Promise((r) => setTimeout(r, 1500));
      // Verify rather than assume. c3c7808 logged "bot moved to base" 33 times
      // while bots kept dying on the peak, and I read those lines as proof the
      // move had happened. A command that was sent is not a bot that arrived.
      const arrived = bot.entity.position.distanceTo(new Vec3(s.x, s.y, s.z));
      console.log(
        `[Bot] Spawn at base ${s.x},${s.y},${s.z} — bot is ${arrived.toFixed(1)} blocks away ` +
          `(y=${bot.entity.position.y.toFixed(0)}) ${arrived <= 8 ? "OK" : "TELEPORT DID NOT LAND"}`,
      );
      spawnSafetyRunning = false;
      resolveSpawnSafetyDone();
      return;
    }

    if (roleConfig.safeSpawn) {
      const { x, z } = roleConfig.safeSpawn;
      console.log(`[Bot] safeSpawn configured — teleporting to ${x},80,${z}`);
      const preTpX = bot.entity.position.x;
      const preTpZ = bot.entity.position.z;
      // spreadplayers lands on the topmost safe block (no suffocation, no falls)
      bot.chat(`/spreadplayers ${x} ${z} 0 2 false ${roleConfig.username}`);
      const moveDeadline = Date.now() + 5_000;
      while (Date.now() < moveDeadline) {
        await new Promise((r) => setTimeout(r, 200));
        const moved = Math.abs(bot.entity.position.x - preTpX) + Math.abs(bot.entity.position.z - preTpZ);
        if (moved > 5) break;
      }
      const landDeadline = Date.now() + 6_000;
      while (!bot.entity.onGround && Date.now() < landDeadline) {
        await new Promise((r) => setTimeout(r, 200));
        const feetBlock = bot.blockAt(bot.entity.position);
        if (feetBlock?.name === "water") break;
      }
      const feetCheck = bot.blockAt(bot.entity.position);
      if (feetCheck?.name === "water") {
        console.warn(`[Bot] safeSpawn landed in water — falling through to water handler`);
        spawnSafetyRunning = false;
        resolveSpawnSafetyDone();
        return;
      }
      const lx = Math.floor(bot.entity.position.x);
      const ly = Math.floor(bot.entity.position.y);
      const lz = Math.floor(bot.entity.position.z);
      // spreadplayers lands on the TOPMOST safe block, which on this terrain is
      // a mountain peak. See respawn.ts: 49 spawnpoints set at y=114-121 while
      // the stash sits at y=70, and Forge then died 29 times, 28 of them falls,
      // from exactly those heights. Safe against suffocation is not safe.
      const spawn = respawnTarget({ x: lx, y: ly, z: lz }, roleConfig.stashPos);
      bot.chat(`/spawnpoint ${roleConfig.username} ${spawn.x} ${spawn.y} ${spawn.z}`);
      if (spawn.y !== ly) {
        // ae5325a moved the SPAWNPOINT to base but left the bot standing where
        // spreadplayers had put it. That is the peak. The guard then fired 44
        // times in one hour while Forge died 24 more times falling from y=118
        // to y=121 — the same altitudes spreadplayers had just chosen for him.
        // Redirecting where a bot will respawn is useless while it is still
        // stranded on the cliff; move the body too.
        console.log(
          `[Bot] Landed at ${lx},${ly},${lz} — ${ly - spawn.y} above the stash, ` +
            `spawnpoint AND bot moved to base ${spawn.x},${spawn.y},${spawn.z}`,
        );
        bot.chat(`/tp ${roleConfig.username} ${spawn.x} ${spawn.y + 1} ${spawn.z}`);
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        console.log(`[Bot] Landed at ${lx},${ly},${lz} — setting spawnpoint`);
      }
      spawnSafetyRunning = false;
      resolveSpawnSafetyDone();
      return;
    }

    // If still falling, wait until onGround
    if (!bot.entity.onGround) {
      console.log(`[Bot] Spawn at Y=${bot.entity.position.y.toFixed(1)} — waiting for landing...`);
      const deadline = Date.now() + 60_000;
      while (!bot.entity.onGround && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!bot.entity.onGround) {
        const px = Math.floor(bot.entity.position.x);
        const pz = Math.floor(bot.entity.position.z);
        bot.chat(`/spreadplayers ${px} ${pz} 0 2 false ${roleConfig.username}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    const pos = bot.entity.position;
    const feet = bot.blockAt(pos);
    const below = bot.blockAt(pos.offset(0, -1, 0));

    // In water — find land
    if (feet?.name === "water" || below?.name === "water") {
      console.log("[Bot] In water — using /tp to find land");
      const sx = Math.floor(pos.x);
      const sz = Math.floor(pos.z);
      let foundLand = false;
      for (const [dx, dz] of [
        [0, 300],
        [300, 0],
        [0, -300],
        [-300, 0],
        [300, 300],
      ]) {
        bot.chat(`/spreadplayers ${sx + dx} ${sz + dz} 0 2 false ${roleConfig.username}`);
        await new Promise((r) => setTimeout(r, 3000));
        const fb = bot.blockAt(bot.entity.position);
        if (fb && fb.name !== "water" && fb.name !== "air") {
          const lx = Math.floor(bot.entity.position.x);
          const ly = Math.floor(bot.entity.position.y);
          const lz = Math.floor(bot.entity.position.z);
          bot.chat(`/spawnpoint ${roleConfig.username} ${lx} ${ly} ${lz}`);
          console.log(`[Bot] Spawnpoint set to land at ${lx},${ly},${lz}`);
          foundLand = true;
          break;
        }
      }
      if (!foundLand) console.warn("[Bot] Could not find dry land for spawnpoint");
      spawnSafetyRunning = false;
      resolveSpawnSafetyDone();
      return;
    }

    // Underground — TP to surface.
    //
    // Skipped at base. This check is an absolute height test that assumes the
    // base sits above y=100; ours is at y=70, so once respawns started coming
    // home every arriving bot was judged trapped, teleported to y=200, and
    // landed on a peak at y=118-121 — the heights it then fell 33 blocks from.
    // The respawn guard fired 44 times in an hour and Forge still died 24 times,
    // because this undid it seconds later.
    if (pos.y < 100 && !isAtBase(pos, roleConfig.stashPos)) {
      let hasCeiling = false;
      for (let dy = 1; dy <= 6; dy++) {
        const b = bot.blockAt(pos.offset(0, dy, 0));
        if (b && b.name !== "air" && b.name !== "cave_air") {
          hasCeiling = true;
          break;
        }
      }
      if (hasCeiling) {
        const sx = Math.floor(pos.x);
        const sz = Math.floor(pos.z);
        console.log(`[Bot] Underground at Y=${pos.y.toFixed(0)} — /tp to surface`);
        bot.chat(`/effect give ${roleConfig.username} slow_falling 60 1`);
        await new Promise((r) => setTimeout(r, 500));
        bot.chat(`/tp ${sx} 200 ${sz}`);
        const deadline = Date.now() + 60_000;
        while (!bot.entity.onGround && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }

    const lx = Math.floor(bot.entity.position.x);
    const ly = Math.floor(bot.entity.position.y);
    const lz = Math.floor(bot.entity.position.z);
    // No stash to aim at — the branch above returns whenever one is known — so
    // there is no base to compare this landing against and nothing to redirect
    // to. Lock in wherever the bot legitimately ended up.
    bot.chat(`/spawnpoint ${roleConfig.username} ${lx} ${ly} ${lz}`);
    console.log(`[Bot] Spawnpoint locked at ${lx},${ly},${lz} (no stash configured)`);
    spawnSafetyRunning = false;
    resolveSpawnSafetyDone();
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  // In-game chat — ignore self. Other bots are heard ONLY when they address this
  // bot by name, and at most once per sender per cooldown window. This enables
  // team coordination ("Mason! Craft a chest!") without runaway feedback loops.
  const BOT_USERNAMES = new Set(["Atlas", "Flora", "Forge", "Mason", "Blade"]);
  const BOT_CHAT_COOLDOWN_MS = 45_000;
  const lastBotChatHeard = new Map<string, number>();
  bot.on("chat", async (username, message) => {
    if (!username || username === bot.username) return;
    if (BOT_USERNAMES.has(username)) {
      const mentionsMe = message.toLowerCase().includes(roleConfig.name.toLowerCase());
      const last = lastBotChatHeard.get(username) ?? 0;
      if (!mentionsMe || Date.now() - last < BOT_CHAT_COOLDOWN_MS) return;
      lastBotChatHeard.set(username, Date.now());
      brain.queueChat({ source: "minecraft", username, message, timestamp: Date.now() });
      return;
    }
    // Ignore server system messages (gamerule results, TP confirmations, etc.)
    if (message.startsWith("Gamerule ") || message.startsWith("Set spawn") || message.startsWith("Teleported ")) return;
    console.log(`[MC Chat] ${username}: ${message}`);

    // Eval commands
    if (message.startsWith("/eval ") || message === "/eval") {
      const parts = message.trim().split(/\s+/);
      const { evalSkill, evalAll } = await import("../eval/runner.js");
      if (parts[1] === "all") {
        evalAll(bot, parts[2]).catch((e: any) => bot.chat(`[EVAL] Error: ${e.message}`));
      } else if (parts[1]) {
        evalSkill(bot, parts[1]).catch((e: any) => bot.chat(`[EVAL] Error: ${e.message}`));
      } else {
        bot.chat("[EVAL] Usage: /eval <skillname>  or  /eval all [filter]");
      }
      return;
    }

    // !goal commands
    if (message.startsWith("!goal")) {
      const parts = message.trim().split(/\s+/);
      const sub = parts[1]?.toLowerCase();
      if (sub === "set" && parts.length > 2) {
        const newGoal = parts.slice(2).join(" ");
        memStore.setSeasonGoal(newGoal);
        bot.chat(`Mission accepted: "${newGoal}"`);
      } else if (sub === "clear") {
        memStore.clearSeasonGoal();
        bot.chat("Season goal cleared. Going freeform.");
      } else if (sub === "show" || !sub) {
        const current = memStore.getSeasonGoal();
        bot.chat(current ? `Current mission: "${current}"` : "No season goal set. Use !goal set <text>");
      } else {
        bot.chat("Usage: !goal set <text> | !goal clear | !goal show");
      }
      return;
    }

    // Queue for the brain to process
    brain.queueChat({
      source: "minecraft",
      username,
      message,
      timestamp: Date.now(),
    });
    addChatMessage(username, message, "free");
  });

  // Death cause capture — the server's death message ("X drowned", "X
  // suffocated in a wall", "X fell from a high place"…) arrives as chat just
  // before/with the death event. Recording the real cause (was hardcoded
  // "unknown") lets us diagnose recurring death-traps and feeds the bots'
  // death-location avoidance.
  let lastDeathMessage = "";
  const DEATH_RE =
    /\b(drowned|suffocat|fell|hit the ground|tried to swim in lava|burned|went up in flames|walked into fire|was slain|was shot|was blown up|blew up|was killed|starv|was pricked|was squashed|was impaled|was struck|froze|magma|withered|didn'?t want to live)/i;
  bot.on("messagestr", (msg: string) => {
    if (msg.includes(roleConfig.username) && DEATH_RE.test(msg)) lastDeathMessage = msg.trim();
  });

  // Death
  //
  // RESPAWN-LOOP BREAKER. Spawn safety runs once at connect and sets
  // /spawnpoint wherever the bot lands. Nothing re-validates it afterwards, so a
  // bot that dies while on a ledge or self-built pillar gets that spot as its
  // PERMANENT respawn point — and then respawns into the same fatal drop
  // forever. Mason did exactly this: 55 falls in one hour, 58 of the swarm's 95
  // deaths, every one "fell from a high place. Respawning...".
  //
  // The loop is self-reinforcing and cannot break on its own, so detect it by
  // repetition and clear the spawnpoint back to a safe landing.
  let recentDeaths: number[] = [];
  let respawnFixing = false;
  // Sized against a measured loop, not a guess. Atlas died 460 times in three
  // days at a median of 235s between deaths — so a 4-in-180s window could never
  // close, and the breaker sat silent through the worst death loop the project
  // has had. 12 of 49 gaps were under 60s, so the old window caught only the
  // bursts and missed the steady bleed entirely.
  //
  // 4 deaths in 15 minutes is still far outside healthy (the whole swarm runs
  // 2-6/hr), and it catches a 235s cadence with room to spare.
  const LOOP_WINDOW_MS = 900_000;
  const LOOP_THRESHOLD = 4;

  // Highest ground the bot last stood on, and when. Falls are the top killer
  // (13 of 33 deaths this session, 9 of them Atlas) and every movement config
  // already caps maxDropDown at 3, so the pathfinder is not routing them off
  // ledges — two of the sampled falls happened right after `idle` and `eat`,
  // with no navigation running at all. Two hypotheses died against the source
  // before this: allowFreeMotion only engages for entity goals (pathfinder
  // index.js:421) so it never applies to explore's coordinate goals, and the
  // teleport fallback is gated off by default. Record the actual drop instead
  // of guessing a third time.
  //
  // The first version of this logged nothing across two real fall deaths: it
  // recorded ground height on every grounded tick, but a falling bot LANDS
  // before it dies, and that landing overwrote the height with the bottom of the
  // fall. See fall-tracker.ts — the origin is captured on the ground->airborne
  // transition so it survives the landing tick.
  const fallTracker = createFallTracker(bot.entity?.position.y ?? 0);
  bot.on("move", () => {
    if (!bot.entity) return;
    // Three mechanism hypotheses died against the source before this, each
    // plausible and each never actually firing: allowFreeMotion (only read for
    // entity goals), the teleport unstick (gated off), and neural combat's raw
    // sprint+strafe (0 runs all session). Atlas is 7-for-7 on fall deaths, three
    // from y=116. Stop guessing what moves him and record it: whatever holds the
    // controls at the instant he leaves the ground is the answer.
    const held = Object.entries(bot.controlState)
      .filter(([, on]) => on)
      .map(([k]) => k)
      .join("+");
    // What the bot was standing on, and where.
    //
    // Atlas has died 460 times in three days, every ~4 minutes, clustered 2-10
    // blocks from the stash between y=71 and y=95, alternating "fell from a high
    // place" and "fell off a ladder". Every sample says controls=none
    // pathing=false, so he is not climbing when he comes off — but nothing
    // records WHAT he leaves or WHERE, so the mechanism is still guesswork after
    // three dead hypotheses. Position plus footing is the missing fact.
    const p = bot.entity.position;
    const at = bot.blockAt(p)?.name ?? "?";
    const below = bot.blockAt(p.offset(0, -1, 0))?.name ?? "?";
    const ctx =
      `controls=${held || "none"} pathing=${bot.pathfinder?.isMoving?.() ?? "?"} ` +
      `vel=${bot.entity.velocity.y.toFixed(2)} at=${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)} ` +
      `in=${at} on=${below}`;
    fallTracker.update(bot.entity.position.y, bot.entity.onGround, Date.now(), ctx);
  });

  // Run before resuming, if something lethal is standing where you woke up.
  //
  // The first action after a death was explore 23 times, go_to 13, mine_block 5
  // and flee ZERO times across one 9h session. Bots respawn at the base and walk
  // straight back into whatever killed them. Flora died three times in 76
  // seconds that way at y=69, two blocks from the stash, and her role has flee
  // but no attack, so running is her only defence and nothing ever chose it.
  //
  // Fleeing works when picked (119 successful flees in the same session). The
  // gap was that nothing looked for danger at the instant a bot is most exposed:
  // freshly respawned, unarmoured, unarmed.
  bot.on("respawn", () => {
    setTimeout(() => {
      try {
        if (!bot.entity) return;
        const hostile = bot.nearestEntity((e) => e !== bot.entity && isHostile(e));
        const dist = hostile ? hostile.position.distanceTo(bot.entity.position) : null;
        if (!shouldFleeOnRespawn(dist)) return;
        console.log(
          `[Respawn] ${roleConfig.name} woke up ${dist!.toFixed(1)} blocks from ${hostile!.name ?? "a hostile"} — fleeing before resuming`,
        );
        executeAction(bot, "flee", {}).catch(() => {});
      } catch {
        /* best effort — never let the safety check itself break a respawn */
      }
    }, 1200); // let the spawn settle so position and entities are current
  });

  bot.on("death", () => {
    const pos = bot.entity.position;
    const cause = lastDeathMessage || "unknown";
    memStore.recordDeath(pos.x, pos.y, pos.z, cause);
    recordDeath(roleConfig.name);

    // What was it WEARING when it died?
    //
    // Deaths ran 19-22/hr with "was shot by" dominant, and I could not tell from
    // the log whether bots were armoured: grepping for "armor" only matched the
    // LLM's own chatter about hunting iron, not the equipment state. equipBestArmor
    // logs when it equips something, which says nothing about what is worn at the
    // moment of death — an unarmoured bot that never found armour logs nothing at
    // all. Record the slots directly so the next spike is answerable.
    const worn = [5, 6, 7, 8].map((slot) => bot.inventory.slots[slot]?.name ?? "-").join(",");
    const drop = fallTracker.dropFrom(pos.y);
    const fallInfo =
      drop > 1
        ? ` Fell ${drop.toFixed(1)} blocks from y=${fallTracker.originY().toFixed(0)} ` +
          `(airborne ${(fallTracker.airborneMs(Date.now()) / 1000).toFixed(1)}s, ${fallTracker.originContext()})`
        : "";
    console.log(`[Bot] I died! Cause: ${cause}. Armor: ${worn}.${fallInfo} Respawning...`);
    lastDeathMessage = "";
    abortActiveSkill(bot);

    const now = Date.now();
    recentDeaths = recentDeaths.filter((t) => now - t < LOOP_WINDOW_MS);
    recentDeaths.push(now);

    if (recentDeaths.length >= LOOP_THRESHOLD && !respawnFixing) {
      respawnFixing = true;
      console.warn(
        `[Bot] ${roleConfig.name} died ${recentDeaths.length}x in ${LOOP_WINDOW_MS / 1000}s — respawn point looks lethal, resetting it`,
      );
      recentDeaths = [];
      // Re-run the same landing routine used at connect: spreadplayers to a
      // topmost safe block, then set the spawnpoint where it actually lands.
      setTimeout(() => {
        runSpawnSafety()
          .catch((e) => console.warn(`[Bot] respawn reset failed:`, e))
          .finally(() => {
            respawnFixing = false;
          });
      }, 2000);
    }
  });

  // Kicked
  bot.on("kicked", (reason) => {
    console.log(`[Bot] Kicked: ${JSON.stringify(reason)}`);
    brain.stop();
  });

  // Errors
  bot.on("error", (err) => {
    console.error("[Bot] Error:", err);
  });

  // Re-run spawn safety on every respawn
  // Only the first bot (Atlas) sends gamerule commands to avoid disconnect.spam kicks
  bot.on("spawn", async () => {
    if (roleConfig.username === "Atlas") {
      bot.chat("/gamerule keepInventory true");
      await new Promise((r) => setTimeout(r, 500));
      bot.chat("/gamerule doMobSpawning true");
      await new Promise((r) => setTimeout(r, 500));
    }
    runSpawnSafety().catch((e) => console.warn("[Bot] Spawn safety error:", e));
  });

  // One-time setup on first spawn
  bot.once("spawn", () => {
    console.log("[Bot] Spawned! Starting event-driven brain...");

    // Start browser viewer — use unified viewer if available, fall back to per-bot viewer
    if (isUnifiedViewerStarted()) {
      registerViewerBot(roleConfig.name, bot);
    } else {
      startViewer(bot, roleConfig.viewerPort);
    }

    // Pathfinder config
    bot.pathfinder.thinkTimeout = 10000;

    // BOUND THE SEARCH. This is the fourth OOM crash's root cause.
    //
    // mineflayer-pathfinder defaults to searchRadius = -1, documented in the
    // library as "don't limit the search", and nothing here ever set it. A*
    // then expands in every direction with only a timer to stop it, while
    // closedDataSet and openDataMap accumulate for the whole thinkTimeout.
    // gatherWood raises that to 30s, so an unreachable target means 30 seconds
    // of unbounded node growth.
    //
    // That is why raising the heap ceiling from 4GB to 8GB did not help: with no
    // spatial bound the search simply fills whatever memory exists and dies at
    // the new limit. The crash reached 8,185MB of an 8,192MB ceiling.
    //
    // It also explains the profile — heap flat at ~300MB, then instant death.
    // Nothing accumulates until one pathfind targets somewhere unreachable, and
    // that search never converges.
    //
    // 96. The progression here was measured, not guessed:
    //   128  OOMed at 8,184MB within minutes (volume ~8.5M positions)
    //    64  memory solved (heap max 285MB) but starved navigation:
    //        ACTION_SUCCESS_PCT 63 -> 38, "No path to the goal" 15/hr -> 80/hr,
    //        stuck 15/hr -> 166/hr, items 300/hr -> 154/hr
    //    96  ~3.4x the node budget of 64, so roughly 970MB worst case against
    //        an 8GB ceiling, while restoring reach for bots that explore ~119
    //        blocks per hop against a 200-block wood leash.
    //
    // A* only exhausts its bound when the goal is UNREACHABLE,
    // and then it explores the whole permitted volume. Node count scales with
    // the cube of the radius, so 128 blocks is roughly 8.5M candidate positions
    // (~850MB of nodes) per search, times five bots searching at once. That is
    // why searchRadius=128 still OOMed at 8,184MB within minutes.
    //
    // I sized the first bound like a travel distance instead of a memory
    // budget, then over-corrected into one too tight to navigate with. Node
    // count scales with the cube of radius, so the safe window is wide: 96 buys
    // back reach at a fraction of the ceiling.
    // Cast: the bundled @types/mineflayer-pathfinder predates searchRadius, but
    // the runtime reads it (index.js:41 sets the -1 default, :75 consumes it).
    (bot.pathfinder as unknown as { searchRadius: number }).searchRadius = 96;
    console.log(`[Pathfinder] ${roleConfig.name}: searchRadius=96 thinkTimeout=${bot.pathfinder.thinkTimeout}ms`);

    // Auto-eat config
    bot.autoEat.opts = {
      priority: "foodPoints",
      minHunger: 14,
      minHealth: 6,
      bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato"],
      returnToLastItem: true,
      offhand: false,
      eatingTimeout: 3000,
      strictErrors: false,
    };

    // Start the brain after spawn safety completes
    spawnSafetyDone
      .then(() => {
        brain.start();
      })
      .catch((e) => {
        console.error("[Bot] Brain start failed:", e);
      });
  });

  return {
    bot,
    queueChat: (msg: ChatMessage) => brain.queueChat(msg),
    stop: () => {
      brain.stop();
      bot.quit();
    },
  };
}
