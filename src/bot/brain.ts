/**
 * Event-driven decision engine — replaces the 500ms polling loop.
 *
 * Instead of asking the LLM every 500ms, the brain listens for game events
 * and routes them to the appropriate handler with a focused prompt:
 *
 * - HOSTILE detected  → reactive prompt (fast model, ~300 tokens)
 * - Damage taken      → reactive prompt
 * - Low health/hunger → reactive prompt
 * - Chat received     → chat response (fast model)
 * - Action completed  → critic check (fast model) → next step or re-plan
 * - Idle timeout      → strategic planning (strong model, ~1200 tokens)
 *
 * This cuts LLM calls from ~120/min/bot to ~6-10/min/bot and lets us use
 * the strong model (32b) for the decisions that matter.
 */

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import { config } from "../config.js";
import { BotRoleConfig, FARM_SITE, BOT_ROSTER } from "./role.js";
import { queryStrategic, queryReactive, queryCritic, chatWithLLM, type LLMMessage } from "../llm/index.js";
import type { RoleContext } from "../llm/prompts.js";
import { getWorldContext, isHostile } from "./perception.js";
import { executeAction } from "./actions.js";
import { digOutIfStuck, escapeWaterIfDrowning } from "./navigation.js";
import { isStallResult, shouldForceDigOut, pruneStalls } from "./stall-rescue.js";
import { isDeathTrap } from "./death-trap.js";
import { classifyResult } from "./action-result.js";
import { freshState, sampleMovement, isStuck } from "./stuck-detector.js";
import { blockDurationFor } from "./block-escalation.js";
import { isAtBase } from "./respawn.js";
import { updateOverlay, addChatMessage, speakThought, setCurrentBot } from "../stream/overlay.js";
import { generateSpeech } from "../stream/tts.js";
import { filterContent, filterChatMessage, filterViewerMessage } from "../safety/filter.js";
import { abortActiveSkill, isSkillRunning, getActiveSkillName, takeSkillOutcome } from "../skills/executor.js";
import { handsBusy } from "../skills/fluid.js";
import { skillRegistry } from "../skills/registry.js";
import { BotMemoryStore } from "./memory.js";
import { getAllMemoryStores } from "./memory-registry.js";
import { updateBulletin, formatTeamBulletin } from "./bulletin.js";
import { createLogger } from "../util/logger.js";
import { recordAction, recordSkillResult, checkInventoryMilestones } from "./scoreboard.js";
import { getTechTreeLine } from "./curriculum.js";
import { advancementLine } from "./advancement-line.js";
import { readTeamEarned } from "./advancement-progress.js";
import { recordTrajectory } from "./trajectory.js";
import { buildStrategicPrompt } from "../llm/prompts.js";

export interface ChatMessage {
  source: "minecraft" | "twitch" | "youtube";
  username: string;
  message: string;
  timestamp: number;
}

export interface BrainEvents {
  onThought: (thought: string) => void;
  onAction: (action: string, result: string) => void;
  onChat: (message: string) => void;
}

// ─── Event types ────────────────────────────────────────────────────────────

type EventType = "strategic" | "reactive" | "chat" | "critic";

interface BrainEvent {
  type: EventType;
  priority: number; // Lower = higher priority (0 = most urgent)
  data?: any;
  timestamp: number;
}

// ─── Brain ──────────────────────────────────────────────────────────────────

export class BotBrain {
  private bot: Bot;
  private roleConfig: BotRoleConfig;
  private events: BrainEvents;
  private memStore: BotMemoryStore;
  private log;

  // Processing state
  private processing = false;
  private stopped = false;
  private rescuingFromWater = false;
  private eventQueue: BrainEvent[] = [];

  // Timers
  private idleTimer: NodeJS.Timeout | null = null;
  private hostileScanner: NodeJS.Timeout | null = null;
  private overlayInterval: NodeJS.Timeout | null = null;

  // Decision state (migrated from the old decide() function)
  private currentGoal = "";
  private goalStepsLeft = 0;
  private lastAction = "";
  private lastResultSig = "";
  private sameResultCount = 0;
  private lastResult = "";
  private lastActionWasSuccess = false;
  private repeatCount = 0;
  private recentHistory: LLMMessage[] = [];
  private pendingChatMessages: ChatMessage[] = [];

  // Failure tracking
  private recentFailures = new Map<string, string>();
  // recentFailures entries EXPIRE. They used to live forever, and a blocked
  // action can never run again to clear itself — so over a long run the
  // blacklist saturated (eat/explore/go_to/mine_block all blocked) and all 5
  // bots stood frozen churning "Blocked:" x357/15min at hour ~20 of run 118.
  // Transient failures (no path, no food HERE, no mobs NOW) age out fast; the
  // world changes. Structural blocks (wrong-role action, retired skill,
  // hallucinated name) persist long.
  private failureExpiry = new Map<string, number>();
  private recentStalls: number[] = [];
  private static readonly FAILURE_TTL_TRANSIENT_MS = 120_000;
  private static readonly FAILURE_TTL_STRUCTURAL_MS = 3_600_000;

  /** How many times each key has been blocked, so repeat offenders escalate. */
  private readonly blockCounts = new Map<string, number>();

  /**
   * Suppress an action. With no explicit ttlMs the window ESCALATES with the
   * number of prior blocks, so a skill that can never succeed stops cycling
   * back every two minutes. See block-escalation.ts for why.
   */
  private blockAction(key: string, msg: string, ttlMs?: number): void {
    const times = (this.blockCounts.get(key) ?? 0) + 1;
    this.blockCounts.set(key, times);
    this.recentFailures.set(key, msg);
    this.failureExpiry.set(key, Date.now() + (ttlMs ?? blockDurationFor(times)));
  }

  /** An action that works again earns back a clean slate. */
  private clearBlockHistory(key: string): void {
    this.blockCounts.delete(key);
  }

  private purgeExpiredFailures(): void {
    const now = Date.now();
    for (const [k, exp] of this.failureExpiry.entries()) {
      if (now > exp) {
        this.failureExpiry.delete(k);
        this.recentFailures.delete(k);
        this.failureCounts.delete(k);
      }
    }
  }
  private failureCounts = new Map<string, number>();
  private successesSinceLastExpiry = 0;

  // Leash
  private homePos: { x: number; y: number; z: number } | null;

  // Farm override cooldown — a fast-failing skill must not thrash every cycle
  private lastFarmOverrideMs = 0;
  private lastIronOverrideMs = 0;
  private lastGearOverrideMs = 0;
  private lastLightOverrideMs = 0;
  private lastSmeltOverrideMs = 0;
  private lastPortalOverrideMs = 0;
  private lastEnchantOverrideMs = 0;
  private lastBreedOverrideMs = 0;
  private lastToolReturnMs = 0;

  // Chat dedup — the 8B anchors on its own last thought and re-sends the
  // same demand every strategic cycle ("Give me the logs!" x7 in 2 min)
  private lastChatSent = "";
  private lastChatSentMs = 0;

  // Cooldowns — prevent spamming the same event type
  private lastReactiveMs = 0;
  private lastStrategicMs = 0;
  private lastHostileSeen = "";

  // Configuration
  private IDLE_INTERVAL_MS: number;
  private HOSTILE_CHECK_MS = 2000;
  private REACTIVE_COOLDOWN_MS = 3000;
  private STRATEGIC_COOLDOWN_MS = 8000;
  private CRITIC_ENABLED = true;

  constructor(bot: Bot, roleConfig: BotRoleConfig, events: BrainEvents, memStore: BotMemoryStore) {
    this.bot = bot;
    this.roleConfig = roleConfig;
    this.events = events;
    this.memStore = memStore;
    this.log = createLogger(roleConfig.name);
    this.homePos = roleConfig.homePos ?? null;
    this.IDLE_INTERVAL_MS = config.bot.idleIntervalMs ?? 10_000;

    // Pre-populate failure blacklist from memory
    for (const [skill, msg] of memStore.getSessionPreconditionBlocks()) {
      this.blockAction(`skill:${skill}`, msg, BotBrain.FAILURE_TTL_STRUCTURAL_MS);
    }
    if (this.recentFailures.size > 0) {
      this.log.debug("Brain", `Pre-populated ${this.recentFailures.size} blacklist entries from memory`);
    }
  }

  /**
   * Auto-equip the best armor the bot is carrying. Bots had no behavior to
   * WEAR armor, so bootstrapped/crafted iron armor sat unworn in inventory
   * while they fought unprotected and died. Runs periodically; idempotent.
   */
  private async equipBestArmor(): Promise<void> {
    if (isSkillRunning(this.bot)) return;
    const TIER = ["netherite", "diamond", "iron", "chainmail", "golden", "leather"];
    const slots: [string, string, number][] = [
      ["head", "_helmet", 5],
      ["torso", "_chestplate", 6],
      ["legs", "_leggings", 7],
      ["feet", "_boots", 8],
    ];
    // (The old "attempting equip" diagnostic is gone: it fired every cycle
    // even when the armor was already WORN — inventory.items() includes the
    // armor slots — producing thousands of noise lines. The "equipped" /
    // "equip FAILED" lines below are the real signals, and they confirmed the
    // system works: Atlas, Forge, and Flora all equipped iron chestplates.)
    for (const [dest, suffix, slotIdx] of slots) {
      const cands = this.bot.inventory.items().filter((i) => i.name.endsWith(suffix));
      if (!cands.length) continue;
      cands.sort((a, b) => {
        const ta = TIER.findIndex((t) => a.name.includes(t));
        const tb = TIER.findIndex((t) => b.name.includes(t));
        return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb);
      });
      const best = cands[0];
      const worn = this.bot.inventory.slots[slotIdx];
      // Compare TIERS, not names: inventory.items() excludes worn armor, so a
      // bot wearing iron while carrying a leather spare sees best=leather,
      // fails the name check, and swaps — then swaps back next cycle. Flora
      // flip-flopped iron<->leather helmets 149 times in an hour this way.
      // Only equip when the carried candidate strictly beats what's worn.
      const tierOf = (n: string) => {
        const t = TIER.findIndex((tier) => n.includes(tier));
        return t < 0 ? 99 : t;
      };
      if (worn && tierOf(worn.name) <= tierOf(best.name)) continue; // worn is same or better
      try {
        await this.bot.equip(best, dest as any);
        this.log.info("Armor", `equipped ${best.name}`);
      } catch (e: any) {
        this.log.warn("Armor", `equip ${best.name} FAILED: ${e?.message || e}`);
      }
    }
  }

  /** Start the event-driven brain. Call after spawn safety completes. */
  start(): void {
    this.log.info("Brain", `Starting (idle interval: ${this.IDLE_INTERVAL_MS}ms)`);

    // 1. Idle timer — triggers strategic planning when nothing else is happening
    this.resetIdleTimer();

    // 0. Auto-equip armor on spawn and every 20s thereafter
    this.equipBestArmor().catch(() => {});
    const armorTimer = setInterval(() => this.equipBestArmor().catch(() => {}), 20_000);
    armorTimer.unref?.();

    // 0b. Self-unstick: if boxed into a hole, dig out (own hands, not a TP).
    //
    // This used to be gated on `!this.processing`, which disabled it exactly
    // when it was needed. A bot trapped in a FAILING ACTION LOOP is never idle:
    // Forge spent 1,181 consecutive deposit attempts stuck 18 blocks from the
    // stash, every one logging "moved 0 on first goto", and the rescue could not
    // run because the brain was always mid-action. 3,512 log lines from one bot
    // going nowhere.
    //
    // Same defect as the drowning rescue that swam at a stone ceiling: the
    // mechanism was fine, its precondition was wrong. The drown timer already
    // solved this correctly by overriding mid-action when air is critical.
    //
    // Key on real immobility instead of perceived idleness. A skill that
    // legitimately stays put (strip_mine digging down) still moves, so this does
    // not fight normal work.
    const STUCK_MS = 90_000;
    let stuckState = freshState(this.bot.entity?.position ?? { x: 0, y: 0, z: 0 }, Date.now());

    const unstickTimer = setInterval(() => {
      const pos = this.bot.entity?.position;
      if (!pos) return;

      // Compare against the PREVIOUS SAMPLE, not a stale anchor. The old rule
      // only advanced its reference on a >2-block jump, so a bot mining a vein
      // or smelting at a furnace looked motionless and was dug out mid-action
      // every 90s — 892 times across the swarm in one 5.5h session.
      stuckState = sampleMovement(stuckState, pos, Date.now());
      const stuck = isStuck(stuckState, Date.now(), STUCK_MS);
      const idle = !this.processing && !isSkillRunning(this.bot);

      // Idle bots get the original gentle treatment; genuinely immobile ones get
      // rescued whatever they believe they are doing.
      if (idle || stuck) {
        if (stuck) {
          const stuckFor = Date.now() - stuckState.lastMoveAt;
          console.log(
            `[Unstick] ${this.roleConfig.name} has not moved in ${Math.round(stuckFor / 1000)}s — digging out mid-action`,
          );
          stuckState = freshState(pos, Date.now()); // don't re-fire while it works
        }
        digOutIfStuck(this.bot).catch(() => {});
      }
    }, 25_000);
    unstickTimer.unref?.();

    // 0c. Anti-drown: ~90% of all deaths were bots drowning in the stash water
    // pit. Drowning kills in ~15s, so check often and swim out even mid-action
    // (this overrides whatever the bot is doing — staying alive comes first).
    const drownTimer = setInterval(() => {
      if (this.rescuingFromWater) return;
      this.rescuingFromWater = true;
      escapeWaterIfDrowning(this.bot)
        .catch(() => {})
        .finally(() => {
          this.rescuingFromWater = false;
        });
    }, 3000);
    drownTimer.unref?.();

    // 2. Hostile scanner — checks for nearby threats every 2s
    this.hostileScanner = setInterval(() => this.scanHostiles(), this.HOSTILE_CHECK_MS);

    // 3. Health/hunger monitoring via mineflayer events
    this.bot.on("health", () => this.checkVitals());

    // 4. Entity hurt — react when bot takes damage
    this.bot.on("entityHurt", (entity: Entity) => {
      if (entity === this.bot.entity) {
        this.pushEvent({
          type: "reactive",
          priority: 0,
          data: { reason: "took_damage", health: this.bot.health },
          timestamp: Date.now(),
        });
      }
    });

    // 5. Overlay updates every 2s
    this.overlayInterval = setInterval(() => {
      setCurrentBot(this.roleConfig.name);
      const overlayData: any = {
        health: this.bot.health,
        food: this.bot.food,
        position: {
          x: this.bot.entity.position.x,
          y: this.bot.entity.position.y,
          z: this.bot.entity.position.z,
        },
        time: this.bot.time.timeOfDay < 13000 || this.bot.time.timeOfDay > 23000 ? "Daytime" : "Nighttime",
        inventory: this.bot.inventory.items().map((i) => `${i.name}x${i.count}`),
        // Role mission outranks broadcast steering: specialists hold their
        // lane even when a chat-set goal sweeps the team.
        seasonGoal: this.roleConfig.seasonGoal ?? this.memStore.getSeasonGoal() ?? undefined,
      };
      if (isSkillRunning(this.bot)) {
        overlayData.action = `[SKILL] ${getActiveSkillName(this.bot)}`;
      }
      updateOverlay(overlayData);
    }, 2000);

    // Trigger first strategic decision immediately
    this.pushEvent({ type: "strategic", priority: 5, timestamp: Date.now() });
  }

  /** Stop the brain — clears all timers. */
  stop(): void {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hostileScanner) clearInterval(this.hostileScanner);
    if (this.overlayInterval) clearInterval(this.overlayInterval);
  }

  /** Queue a chat message for processing. */
  queueChat(msg: ChatMessage): void {
    const viewerFilter = filterViewerMessage(msg.message);
    if (!viewerFilter.safe) {
      this.log.debug("Brain", `Filtered viewer message from ${msg.username}: ${viewerFilter.reason}`);
      msg.message = viewerFilter.cleaned;
    }
    this.pendingChatMessages.push(msg);
    if (this.pendingChatMessages.length > 10) this.pendingChatMessages.shift();

    // Push chat event — paid messages are higher priority
    const isPaid = (msg as any).tier === "paid";
    this.pushEvent({
      type: isPaid ? "strategic" : "chat", // Paid messages trigger full re-planning
      priority: isPaid ? 1 : 4,
      data: msg,
      timestamp: Date.now(),
    });
  }

  /** Force immediate strategic re-evaluation. */
  triggerReplan(): void {
    this.pushEvent({ type: "strategic", priority: 5, timestamp: Date.now() });
  }

  // ─── Event queue management ─────────────────────────────────────────────

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.stopped) return;
    this.idleTimer = setTimeout(() => {
      this.pushEvent({ type: "strategic", priority: 5, timestamp: Date.now() });
      this.resetIdleTimer();
    }, this.IDLE_INTERVAL_MS);
  }

  private pushEvent(event: BrainEvent): void {
    if (this.stopped) return;

    // Deduplicate: don't queue same type if already pending with equal/higher priority
    const existingIdx = this.eventQueue.findIndex((e) => e.type === event.type);
    if (existingIdx !== -1) {
      if (event.priority < this.eventQueue[existingIdx].priority) {
        this.eventQueue.splice(existingIdx, 1); // Replace with higher priority
      } else {
        return; // Already have an equal/higher priority event of this type
      }
    }

    this.eventQueue.push(event);
    this.eventQueue.sort((a, b) => a.priority - b.priority);
    this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.stopped) return;
    const event = this.eventQueue.shift();
    if (!event) return;

    this.processing = true;
    setCurrentBot(this.roleConfig.name);

    try {
      // Skip if a skill is running (let it finish)
      if (isSkillRunning(this.bot) && event.type !== "reactive") {
        // Re-queue non-urgent events to process after skill completes
        if (event.type === "strategic") {
          setTimeout(() => this.pushEvent(event), 3000);
        }
        return;
      }

      switch (event.type) {
        case "reactive":
          // Survival reflexes may interrupt skills — but not the ~2s bucket
          // critical section. A "Flee from creeper" between equip and the use
          // packet dragged the caster off mid-scoop (probe-verified: same code
          // fills flawlessly with no brain attached). Deferred, not dropped:
          // the threat is still there two seconds later.
          if (handsBusy(this.bot)) {
            setTimeout(() => this.pushEvent(event), 2000);
            break;
          }
          await this.handleReactive(event);
          break;
        case "chat":
          await this.handleChat(event);
          break;
        case "strategic":
          await this.handleStrategic(event);
          break;
        case "critic":
          await this.handleCritic(event);
          break;
      }
    } catch (err) {
      this.log.error(`Brain:${event.type}`, "Error:", err);
    } finally {
      this.processing = false;
      this.resetIdleTimer();
      // Process next queued event
      if (this.eventQueue.length > 0 && !this.stopped) {
        setImmediate(() => this.processNext());
      }
    }
  }

  // ─── Hostile scanning ─────────────────────────────────────────────────────

  private scanHostiles(): void {
    if (this.processing || this.stopped) return;
    if (isSkillRunning(this.bot)) return; // Don't interrupt skills

    const myPos = this.bot.entity?.position;
    if (!myPos) return;

    const now = Date.now();
    if (now - this.lastReactiveMs < this.REACTIVE_COOLDOWN_MS) return;

    const hostiles = Object.values(this.bot.entities).filter(
      (e) => e !== this.bot.entity && !!e.position && isHostile(e) && e.position.distanceTo(myPos) < 16,
    );

    if (hostiles.length === 0) return;

    // A real threat is present — clear any stale "no mobs / attack failed"
    // blacklist so the bot can actually engage. Without this, the no-target
    // failures that pile up while safe (Peaceful, or just daytime) permanently
    // block attack/neural_combat, so Blade could never fight when mobs finally
    // appeared — he had 0 kills all session.
    for (const key of ["attack", "neural_combat", "skill:neural_combat"]) {
      this.recentFailures.delete(key);
      this.failureCounts.delete(key);
    }

    // Don't spam for the same hostile
    const hostileKey = hostiles.map((h) => `${h.name}:${Math.round(h.position.x)}`).join(",");
    if (hostileKey === this.lastHostileSeen && now - this.lastReactiveMs < 10_000) return;
    this.lastHostileSeen = hostileKey;

    this.pushEvent({
      type: "reactive",
      priority: 1,
      data: { reason: "hostile_nearby", entities: hostiles },
      timestamp: now,
    });
  }

  private checkVitals(): void {
    if (this.stopped) return;
    const now = Date.now();
    if (now - this.lastReactiveMs < this.REACTIVE_COOLDOWN_MS) return;

    if (this.bot.health <= 6) {
      this.pushEvent({
        type: "reactive",
        priority: 0,
        data: { reason: "low_health", health: this.bot.health },
        timestamp: now,
      });
    } else if (this.bot.food <= 6) {
      this.pushEvent({
        type: "reactive",
        priority: 2,
        data: { reason: "low_hunger", food: this.bot.food },
        timestamp: now,
      });
    }
  }

  // ─── Safety overrides ─────────────────────────────────────────────────────

  /** Check for water/underground and handle before LLM query. Returns true if override handled. */
  private async runSafetyOverrides(): Promise<boolean> {
    // Teleport-based water/buried escapes are interventions — off by default so
    // bots must swim/dig out themselves (or die; keepInventory protects progress).
    if (!config.bot.allowInterventions) return false;
    const pos = this.bot.entity.position;

    // Water escape
    const feetBlock = this.bot.blockAt(pos);
    const headBlock = this.bot.blockAt(pos.offset(0, 1, 0));
    if (feetBlock?.name === "water" || headBlock?.name === "water") {
      // Wait 3s for natural swim-out
      await new Promise((r) => setTimeout(r, 3000));
      const feetNow = this.bot.blockAt(this.bot.entity.position);
      const headNow = this.bot.blockAt(this.bot.entity.position.offset(0, 1, 0));
      if (feetNow?.name !== "water" && headNow?.name !== "water") return false;

      if (this.roleConfig.safeSpawn) {
        const { x, z } = this.roleConfig.safeSpawn;
        this.log.debug("Brain", `In water — TPing to safeSpawn (${x},80,${z})`);
        // spreadplayers lands on the topmost safe block — a raw /tp X 80 Z
        // materialized bots inside hills taller than Y=80 (suffocation deaths)
        this.bot.chat(`/spreadplayers ${x} ${z} 0 2 false ${this.bot.username}`);
        await new Promise((r) => setTimeout(r, 4000));
        return true;
      }
      return false;
    }

    // Underground/buried escape
    const isInsideSolid =
      feetBlock &&
      feetBlock.name !== "air" &&
      feetBlock.name !== "cave_air" &&
      feetBlock.name !== "water" &&
      feetBlock.diggable &&
      pos.y < 55;
    if (isInsideSolid) {
      const tx = Math.floor(pos.x);
      const tz = Math.floor(pos.z);
      this.log.debug("Brain", `Buried in ${feetBlock?.name} at Y=${pos.y.toFixed(1)} — escaping`);
      this.bot.chat(`/spreadplayers ${tx} ${tz} 0 2 false ${this.bot.username}`);
      await new Promise((r) => setTimeout(r, 2000));
      return true;
    }

    return false;
  }

  // ─── Context building ─────────────────────────────────────────────────────

  /** Build the world context string for strategic decisions. */
  private buildContext(): string {
    const worldContext = getWorldContext(this.bot, this.roleConfig.role);
    let ctx = `CURRENT STATE:\n${worldContext}`;

    // Pending chat messages
    if (this.pendingChatMessages.length > 0) {
      const chatStr = this.pendingChatMessages.map((m) => `[${m.source}] ${m.username}: ${m.message}`).join("\n");
      ctx += `\n\nMESSAGES FROM PLAYERS/VIEWERS:\n${chatStr}`;
      this.pendingChatMessages.length = 0;
    }

    // Tech-tree curriculum — deterministic "what's next" from inventory
    const techLine = getTechTreeLine(this.bot, this.roleConfig.role);
    if (techLine) ctx += `\n\n${techLine}`;

    // Ground truth from the server, not from the bot's own claims. Cached by
    // readTeamEarned's caller cadence — buildContext runs at most every ~10s.
    const advLine = advancementLine(this.roleConfig.role, readTeamEarned(BOT_ROSTER.map((b) => b.name)));
    if (advLine) ctx += `\n\n${advLine}`;

    // Current goal
    if (this.currentGoal && this.goalStepsLeft > 0) {
      ctx += `\n\nCURRENT GOAL: "${this.currentGoal}" (${this.goalStepsLeft} steps left). Continue.`;
    }

    // Last action result
    if (this.lastAction && this.lastResult) {
      ctx += `\n\nLAST ACTION: ${this.lastAction} → ${this.lastResult}`;
    }

    // Leash enforcement
    if (this.homePos && this.roleConfig.leashRadius > 0) {
      const dx = this.bot.entity.position.x - this.homePos.x;
      const dz = this.bot.entity.position.z - this.homePos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= this.roleConfig.leashRadius * 0.8) {
        ctx += `\n\nLEASH WARNING: ${dist.toFixed(0)} blocks from home (max: ${this.roleConfig.leashRadius}). Head back to (${this.homePos.x}, ${this.homePos.y}, ${this.homePos.z}).`;
      }
    }

    // Stash position
    if (this.roleConfig.stashPos) {
      const { x, y, z } = this.roleConfig.stashPos;
      ctx += `\n\nTHE STASH: Shared chest area at (${x}, ${y}, ${z}).`;
    }

    // Team bulletin
    const teamStatus = formatTeamBulletin(this.roleConfig.name);
    if (teamStatus) ctx += `\n${teamStatus}`;

    // Recent failures
    this.purgeExpiredFailures();
    if (this.recentFailures.size > 0) {
      const lines: string[] = [];
      for (const [k, v] of this.recentFailures.entries()) {
        lines.push(`- ${k.replace(/^skill:/, "")}: ${v}`);
      }
      ctx += `\n\nRECENTLY FAILED (do NOT retry):\n${lines.join("\n")}`;
    }

    ctx += "\n\nWhat should you do next? Respond with JSON.";
    return ctx;
  }

  // ─── Event handlers ───────────────────────────────────────────────────────

  private async handleReactive(event: BrainEvent): Promise<void> {
    this.lastReactiveMs = Date.now();
    const { reason, entities, health, food } = event.data ?? {};

    // Build a tiny situation description
    let situation: string;
    if (reason === "hostile_nearby" && entities?.length) {
      const hostileList = entities
        .slice(0, 3)
        .map((e: Entity) => `${e.name || "mob"} (${e.position.distanceTo(this.bot.entity.position).toFixed(0)} blocks)`)
        .join(", ");
      const equipment =
        this.bot.inventory
          .items()
          .filter((i) => i.name.includes("sword") || i.name.includes("shield") || i.name.includes("bow"))
          .map((i) => i.name)
          .join(", ") || "bare hands";
      const foodItems =
        this.bot.inventory
          .items()
          .filter((i) =>
            ["bread", "cooked_beef", "cooked_porkchop", "apple", "cooked_chicken", "baked_potato"].includes(i.name),
          )
          .map((i) => `${i.name}x${i.count}`)
          .join(", ") || "none";
      situation = `THREAT: ${hostileList}\nHealth: ${this.bot.health}/20, Food: ${this.bot.food}/20\nEquipment: ${equipment}\nFood items: ${foodItems}`;
    } else if (reason === "took_damage") {
      situation = `TOOK DAMAGE! Health: ${this.bot.health}/20. Check for nearby threats and react.`;
    } else if (reason === "low_health") {
      situation = `LOW HEALTH: ${this.bot.health}/20. Eat food or flee to safety.`;
    } else if (reason === "low_hunger") {
      situation = `LOW HUNGER: ${this.bot.food}/20. Eat something before starving.`;
    } else {
      situation = `Health: ${this.bot.health}/20, Food: ${this.bot.food}/20. Assess situation.`;
    }

    const decision = await queryReactive(this.roleConfig.name, situation, this.roleConfig.allowedActions);
    await this.executeDecision(decision);
  }

  private async handleChat(event: BrainEvent): Promise<void> {
    const msg = event.data as ChatMessage;
    if (!msg) return;

    const activity = `${this.lastAction || "exploring"} (${this.currentGoal || "no specific goal"})`;
    const response = await chatWithLLM(`[${msg.source}] ${msg.username}: ${msg.message}`, activity, {
      name: this.roleConfig.name,
    });

    const chatFilter = filterChatMessage(response);
    const safeResponse = chatFilter.safe ? response : chatFilter.cleaned;

    this.bot.chat(safeResponse);
    this.events.onChat(safeResponse);
    addChatMessage(this.roleConfig.name, safeResponse, "bot");
  }

  private async handleStrategic(event: BrainEvent): Promise<void> {
    const now = Date.now();
    if (now - this.lastStrategicMs < this.STRATEGIC_COOLDOWN_MS) return;
    this.lastStrategicMs = now;

    // Safety overrides first
    if (await this.runSafetyOverrides()) return;

    // NIGHT REFLEX. playersSleepingPercentage=1 (Jesse-approved 2026-08-27)
    // means ONE sleeping bot skips the night for the whole server — but across
    // the first full night with the rule live, the models chose sleep ZERO
    // times in 1,292 actions and the fleet spent the dark hours in flee/eat
    // churn (9% action success). Same doctrine as auto-eat: survival plumbing
    // is mechanical, the LLM plans on top of it. Only idle bots get here
    // (skills re-queue strategic events), so nobody abandons a job to nap.
    const timeOfDay = this.bot.time?.timeOfDay ?? 0;
    // 11800, before beds unlock at 12542: the sleep action walks FIRST and
    // clicks last, so a dusk invocation parks the bot beside its bed through
    // twilight and the click lands the moment it becomes legal — winning the
    // race against mob aggro that three straight 20-death nights kept losing
    // (the reflex used to start the 75s bed-walk only after the mobs were
    // already out).
    if (timeOfDay >= 11800 && timeOfDay <= 23458 && !(this.bot as any).isSleeping) {
      const slept = await executeAction(this.bot, "sleep", {});
      this.log.info("Brain", `Night reflex: sleep → ${slept}`);
      if (/zzz|sleeping/i.test(slept)) return; // in bed — skip the LLM turn
      // Sleep failed (no bed, hostiles nearby) — fall through to normal planning.
    }

    // Portal-breach override — RUNS FIRST among mission overrides. In run
    // 391 the village-lighting and mining pushes both outranked it in code
    // order: Mason marched 20 blocks toward the doorway, lost his turn to a
    // torch chore, wandered home, and the commute reset from 71 to 89 blocks.
    // While the doorway pick is in hand, the doorway IS the mission. Forge's
    // mission text stops at "craft a diamond_pickaxe" and no reflex sent the
    // finished pick anywhere: the doorway at 278,14,-243 would have waited on
    // the model to volunteer. Diamond pick + the portal skill = go clear it.
    // build_nether_portal handles the interior obsidian, ignition, and entry.
    // An empty allowedSkills list is permissive (Atlas ran this skill all
    // night on one), and the stranded-in-the-Nether rescue must reach every
    // bot that can fall through the doorway.
    if (
      config.bot.allowStrategyOverrides &&
      (this.roleConfig.allowedSkills.length === 0 || this.roleConfig.allowedSkills.includes("build_nether_portal")) &&
      !isSkillRunning(this.bot)
    ) {
      const holdsDoorwayPick = this.bot.inventory
        .items()
        .some((i) => i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe");
      // A full frame in the pack is a stronger signal than any pickaxe:
      // Atlas carried all ten blocks through an entire run while this
      // override ignored him because he never owned a diamond pick, and
      // placement waited on the strategic model's whims.
      const holdsFullFrame =
        this.bot.inventory
          .items()
          .filter((i) => i.name === "obsidian")
          .reduce((s, i) => s + i.count, 0) >= 10;
      // A bot stuck on the far side flails: Forge lost his whole kit to a
      // ghast while his strategic model hunted for trees in the Nether. The
      // portal skill starts with a return-home leg, so firing it IS the
      // rescue.
      const dimNow = String(this.bot.game.dimension);
      const strandedInNether = dimNow === "the_nether" || dimNow === "minecraft:the_nether";
      // With the village portal lit, a diamond pick alone is no reason to
      // run the builder — the skill returns "nothing to build" instantly and
      // the override was firing that no-op every five minutes forever. A
      // pick-holder only builds when no lit doorway stands nearby; the
      // full-pocket and stranded triggers are unaffected.
      const litPortalNearby =
        holdsDoorwayPick &&
        !strandedInNether &&
        !!this.bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 48 });
      const cooledDown = Date.now() - this.lastPortalOverrideMs > 300_000;
      if (((holdsDoorwayPick && !litPortalNearby) || holdsFullFrame || strandedInNether) && cooledDown) {
        this.lastPortalOverrideMs = Date.now();
        this.log.info(
          "Brain",
          `OVERRIDE: ${strandedInNether ? "stranded in the Nether" : holdsFullFrame ? "full portal frame in the pack" : "diamond pickaxe in hand"} — running build_nether_portal`,
        );
        this.events.onThought("The pick that opens the Nether is in my hand. To the doorway!");
        const result = await executeAction(this.bot, "invoke_skill", { skill: "build_nether_portal" });
        this.events.onAction("build_nether_portal", result);
        this.lastAction = "build_nether_portal";
        this.lastResult = result;
        this.trackFailure(
          "skill:build_nether_portal",
          { action: "build_nether_portal", params: {} },
          result,
          /lit|ignit|portal|cleared|complete/i.test(result),
        );
        return;
      }
    }

    // Survival override: starvation was killing the team (whole roster at
    // hunger 0, 286 failed "eat" attempts in one run). If hungry with no food
    // on hand, withdraw food from the stash so auto-eat has fuel — no waiting
    // on the LLM to figure out the farm→bake→eat loop.
    const FOOD_NAMES = [
      "bread",
      "cooked_beef",
      "cooked_porkchop",
      "cooked_chicken",
      "cooked_mutton",
      "apple",
      "carrot",
      "baked_potato",
    ];
    if (config.bot.allowInterventions && this.bot.food <= 10 && this.roleConfig.stashPos) {
      const hasFood = this.bot.inventory.items().some((i) => FOOD_NAMES.some((f) => i.name.includes(f)));
      if (!hasFood) {
        // Survival safety net. Routing starving bots to a chest proved
        // hopeless — withdraw_stash's pathfinding fails ("Path was stopped")
        // even after teleporting them onto the stash, so distant bots starved
        // to death on loop (Atlas repeatedly hit hunger 0). Like keepInventory
        // and the safety teleports, this is a survival floor, not a gameplay
        // mechanic: give a small ration directly (bots are ops) so auto-eat
        // has fuel. The farm/cooking economy still runs for real food.
        // Saturation EFFECT, not an item: /give depends on inventory + auto-eat
        // timing and left Forge stuck at hunger 4. The effect refills hunger
        // directly with zero dependencies — the bulletproof survival floor.
        // Also hand over a few cooked_beef so they have reserves to eat normally.
        this.log.info("Brain", `SURVIVAL: hungry (${this.bot.food}/20), no food — saturation ration`);
        this.bot.chat(`/effect give ${this.bot.username} minecraft:saturation 2 3 true`);
        this.bot.chat(`/give ${this.bot.username} minecraft:cooked_beef 4`);
        await new Promise((r) => setTimeout(r, 600));
        this.events.onAction("eat", "Survival ration — recovered hunger.");
        this.lastAction = "eat";
        this.lastResult = "Recovered hunger with a ration.";
        return;
      }
    }

    // Leash hard override — skip LLM entirely if way too far from home
    if (this.homePos && this.roleConfig.leashRadius > 0) {
      const dx = this.bot.entity.position.x - this.homePos.x;
      const dz = this.bot.entity.position.z - this.homePos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= this.roleConfig.leashRadius * 1.5) {
        this.log.info("Brain", `LEASH: ${dist.toFixed(0)} blocks away — forcing return home`);
        const result = await executeAction(this.bot, "go_to", this.homePos);
        this.events.onAction("go_to", result);
        return;
      }
    }

    // Stash bootstrap override — deterministic, like the leash. The LLM
    // reliably circles this goal (hand-placing chests, re-gathering wood)
    // without ever picking setup_stash, so when the preconditions are met
    // we just run it.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("setup_stash") &&
      this.roleConfig.stashPos &&
      !this.recentFailures.has("skill:setup_stash")
    ) {
      const { x, y, z } = this.roleConfig.stashPos;
      const nearStash = this.bot.entity.position.distanceTo(new Vec3(x, y, z)) < 64;
      const chestAtStash = this.bot.findBlock({
        matching: (b) => b.name === "chest" || b.name === "trapped_chest",
        maxDistance: 16,
        point: new Vec3(x, y, z),
      });
      const logsAndPlanks = this.bot.inventory
        .items()
        .reduce(
          (s, i) => s + (i.name.endsWith("_log") ? i.count * 4 : 0) + (i.name.endsWith("_planks") ? i.count : 0),
          0,
        );
      const chestsHeld = this.bot.inventory
        .items()
        .filter((i) => i.name === "chest")
        .reduce((s, i) => s + i.count, 0);
      if (nearStash && !chestAtStash && (logsAndPlanks >= 16 || chestsHeld >= 2)) {
        this.log.info("Brain", "OVERRIDE: materials ready and no stash chest — running setup_stash");
        this.events.onThought("The Stash must rise. I have the materials. No more excuses.");
        const result = await executeAction(this.bot, "invoke_skill", { skill: "setup_stash", x, y, z });
        this.events.onAction("setup_stash", result);
        this.lastAction = "setup_stash";
        this.lastResult = result;
        this.trackFailure(
          "skill:setup_stash",
          { action: "setup_stash", params: {} },
          result,
          /bootstrapped|already/i.test(result),
        );
        return;
      }
    }

    // Farm bootstrap override — deterministic, like the stash. Flora spent
    // 45 minutes in the wood-acquisition layer without once invoking
    // build_farm; the skill is now fully self-sufficient (travels to the
    // lake, chops its own logs, crafts the hoe), so when there's no farm
    // yet we just run it.
    // NOTE: deliberately NOT gated on recentFailures. The override's whole
    // job is to force the farm past the LLM's avoidance and past stale
    // precondition blocks (the chunk-load bug recorded many "No water found"
    // failures that pre-loaded as a blacklist entry every restart, which then
    // blocked the override from ever firing). Cooldown alone bounds retries.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("build_farm") &&
      !isSkillRunning(this.bot)
    ) {
      const hasFarm = getAllMemoryStores().some((st) =>
        st.hasStructureNearby(
          "farm",
          this.bot.entity.position.x,
          this.bot.entity.position.y,
          this.bot.entity.position.z,
          300,
        ),
      );
      // No day-gate: a Minecraft day is only ~20 real minutes, so day-gating
      // meant the farm rarely got a window — crops grow fine at night and the
      // skill handles its own safety. Cooldown alone prevents thrash.
      const cooledDown = Date.now() - this.lastFarmOverrideMs > 240_000;
      if (!hasFarm && cooledDown) {
        this.lastFarmOverrideMs = Date.now();
        this.log.info("Brain", "OVERRIDE: no farm exists — running build_farm (self-sufficient)");
        this.events.onThought("The fields call to me. Today the farm gets BUILT — no more excuses.");
        const result = await executeAction(this.bot, "invoke_skill", { skill: "build_farm", ...FARM_SITE });
        this.events.onAction("build_farm", result);
        this.lastAction = "build_farm";
        this.lastResult = result;
        this.trackFailure(
          "skill:build_farm",
          { action: "build_farm", params: {} },
          result,
          /complete|harvest|planted/i.test(result),
        );
        return;
      }
    }

    // Iron/strip-mine override — same deterministic pattern. The miner has
    // strip_mine (staircases to Y=11, mines for ore) but the LLM won't pick it
    // for the iron goal, so Forge mines surface dirt and the team never gets
    // iron. When the miner has a pickaxe and no iron yet, run strip_mine. This
    // both advances the iron-age goal AND generates the iron/ore trajectories
    // the v2 dataset is starved of.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("strip_mine") &&
      !isSkillRunning(this.bot)
    ) {
      // CRAFTABLE iron only: the old any-iron_* match counted the iron
      // shovels minted during the bad-budget era, so shovel-carrying miners
      // read as iron-rich and the push stood down for a full hour. Tools in
      // the hand are not ingots for the pickaxe.
      const hasIron = this.bot.inventory.items().some((i) => i.name === "iron_ingot" || i.name === "raw_iron");
      // No pickaxe requirement anymore: the skill self-supplies its pick
      // (withdraws stash cobble, crafts inline) — requiring one here meant
      // a toolless miner could never trigger the very push that would have
      // equipped him.
      // Diamond leg: once a miner owns an iron+ pick, having iron is no
      // longer a reason to stay home — the mission needs 3 diamonds and
      // strip_mine already dives to y=-58 with that pick. Run 371 proved the
      // gap: the iron push stood down (everyone had iron) and mining stopped
      // COLD — one strip_mine start all run while Blade "explored" for
      // diamonds on the surface.
      const holdsIronPick = this.bot.inventory
        .items()
        .some((i) => i.name === "iron_pickaxe" || i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe");
      const diamonds = this.bot.inventory
        .items()
        .filter((i) => i.name === "diamond")
        .reduce((s, i) => s + i.count, 0);
      const hasDiamondPick = this.bot.inventory
        .items()
        .some((i) => i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe");
      const wantsDive = holdsIronPick && !hasDiamondPick && diamonds < 3;
      const cooledDown = Date.now() - this.lastIronOverrideMs > 180_000;
      if ((!hasIron || wantsDive) && cooledDown) {
        this.lastIronOverrideMs = Date.now();
        this.log.info(
          "Brain",
          wantsDive
            ? `OVERRIDE: iron pick + ${diamonds}/3 diamonds — diving to diamond depth`
            : "OVERRIDE: no iron yet — running strip_mine for ore",
        );
        this.events.onThought(
          wantsDive
            ? "Iron pick in hand and diamonds waiting at the bottom of the world. DIVE."
            : "The deep calls. Time to carve for iron — pickaxe in hand, downward!",
        );
        const result = await executeAction(this.bot, "invoke_skill", { skill: "strip_mine" });
        this.events.onAction("strip_mine", result);
        this.lastAction = "strip_mine";
        this.lastResult = result;
        this.trackFailure(
          "skill:strip_mine",
          { action: "strip_mine", params: {} },
          result,
          /mined|ore|iron|complete/i.test(result),
        );
        return;
      }
    }

    // Village-lighting override. Mob spawns need block-light 0 and one torch
    // clears ~12 blocks (domain research), yet light_area was invoked ZERO
    // times in run 361 while the fleet logged 152 flees in an hour and both
    // hike attempts of every mining trip died to "goal was changed" — the
    // reactive layer seizing the pathfinder to run from mobs that spawned in
    // the unlit village. Torching the base is the standard human answer;
    // deterministic here because the model never chooses it. Daytime only
    // (torch-placing during a night flee storm is chaos), near the stash,
    // 40-minute cooldown — the grid is idempotent so repeats are cheap.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("light_area") &&
      !isSkillRunning(this.bot) &&
      this.roleConfig.stashPos
    ) {
      const tod = this.bot.time?.timeOfDay ?? 0;
      const p = this.bot.entity.position;
      const nearStash = Math.hypot(p.x - this.roleConfig.stashPos.x, p.z - this.roleConfig.stashPos.z) < 30;
      const cooledDown = Date.now() - this.lastLightOverrideMs > 2_400_000;
      if (tod < 12000 && nearStash && cooledDown) {
        this.lastLightOverrideMs = Date.now();
        this.log.info("Brain", "OVERRIDE: daylight at the unlit village — running light_area");
        this.events.onThought("Enough midnight ambushes. Today this village gets TORCHES.");
        const result = await executeAction(this.bot, "invoke_skill", {
          skill: "light_area",
          stashPos: this.roleConfig.stashPos,
        });
        this.events.onAction("light_area", result);
        this.lastAction = "light_area";
        this.lastResult = result;
        this.trackFailure(
          "skill:light_area",
          { action: "light_area", params: {} },
          result,
          /placed|torch/i.test(result),
        );
        return;
      }
    }

    // Tool-return reflex. The best-pickaxe deposit policy (c01bf0d) only
    // works if the holder ever visits the stash, and Blade — carrying the
    // team's only iron pickaxe he cannot swing — chose deposit_stash zero
    // times in run 375 (it isn't even in his action list, so the model
    // could not have picked it). A non-miner holding any pickaxe walks it
    // back; depositStash's canMine=false banks every pick he carries.
    if (config.bot.allowStrategyOverrides && !isSkillRunning(this.bot) && this.roleConfig.stashPos) {
      const canMine =
        this.roleConfig.allowedActions.includes("mine_block") || this.roleConfig.allowedSkills.includes("strip_mine");
      const roleCanCraft =
        this.roleConfig.allowedActions.includes("craft") || this.roleConfig.allowedSkills.includes("craft_gear");
      const holdsPick = this.bot.inventory.items().some((i) => i.name.endsWith("_pickaxe"));
      // Diamonds pool only in a crafter-miner's pocket. Blade's toss landed
      // the stone on ATLAS (run 381) — who can mine but not craft and has no
      // strip_mine, so it was just a different dead end; the old !canMine
      // guard never fired for him. A diamond leaves any bot that cannot
      // complete the set itself.
      const holdsDiamond = this.bot.inventory.items().some((i) => i.name === "diamond");
      const wantsReturn = (holdsPick && !canMine) || (holdsDiamond && !(canMine && roleCanCraft));
      // 5min, down from 10: every attempt is a lottery ticket on a quiet
      // window between mob waves — run 380 got five tickets and no winner.
      const cooledDown = Date.now() - this.lastToolReturnMs > 300_000;
      if (wantsReturn && cooledDown) {
        this.lastToolReturnMs = Date.now();
        // FAST PATH: toss to a visible miner. Blade's five stash errands in
        // run 380 all died to combat interruption (150s of walk plus chest
        // work never fits between pillager attacks) — but a hand-off to a
        // miner standing in the village is a 3-block walk and one throw.
        // Crafter-miners only: the first live toss went to Atlas, a plain
        // miner who can never craft the pickaxe — a different pocket, same
        // dead end. Forge and Mason are where a diamond becomes a tool.
        const minerNames = BOT_ROSTER.filter(
          (r) =>
            (r.allowedActions.includes("mine_block") || r.allowedSkills.includes("strip_mine")) &&
            (r.allowedActions.includes("craft") || r.allowedSkills.includes("craft_gear")),
        ).map((r) => r.name);
        const nearbyMiner = minerNames.find((n) => {
          const e = this.bot.players[n]?.entity;
          return e && this.bot.entity.position.distanceTo(e.position) < 24;
        });
        if (nearbyMiner) {
          const itemToGive = holdsDiamond
            ? "diamond"
            : (this.bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"))?.name ?? "diamond");
          this.log.info("Brain", `OVERRIDE: handing ${itemToGive} to ${nearbyMiner} (miner nearby)`);
          this.events.onThought(`${nearbyMiner} can actually use this. Here, catch!`);
          const result = await executeAction(this.bot, "give_item", { to: nearbyMiner, item: itemToGive, count: 64 });
          this.events.onAction("give_item", result);
          this.lastAction = "give_item";
          this.lastResult = result;
          return;
        }
        this.log.info("Brain", "OVERRIDE: carrying mining assets this role can't use — returning them to the stash");
        this.events.onThought("This belongs in a crafter-miner's hands. Back to the stash it goes.");
        // Honest capability flags: Atlas (a plain miner banking a diamond)
        // still keeps his best pickaxe; the reserve-zero override is what
        // sends the diamond to the chest.
        const result = await executeAction(this.bot, "deposit_stash", {
          stashPos: this.roleConfig.stashPos,
          keepItems: this.roleConfig.keepItems,
          ...(roleCanCraft && canMine ? {} : { materialReserve: 0 }),
          canMine,
        });
        this.events.onAction("deposit_stash", result);
        this.lastAction = "deposit_stash";
        this.lastResult = result;
        return;
      }
    }

    // Smelt override — the rung between mined and craftable. The first
    // end-to-end iron arrived in run 364, and in run 365 Forge stood holding
    // raw iron while the model tried to convert it with CRAFT twice ("Can't
    // craft iron_ingot — need: iron_nugget"); craft cannot smelt, and
    // smelt_ores was never chosen. Raw metal in hand plus the skill = smelt
    // now. smelt_ores already handles furnace, fuel, and stash withdrawal.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("smelt_ores") &&
      !isSkillRunning(this.bot)
    ) {
      const rawMetal = this.bot.inventory
        .items()
        .filter((i) => i.name === "raw_iron" || i.name === "raw_gold" || i.name === "raw_copper")
        .reduce((s, i) => s + i.count, 0);
      const cooledDown = Date.now() - this.lastSmeltOverrideMs > 300_000;
      if (rawMetal >= 1 && cooledDown) {
        this.lastSmeltOverrideMs = Date.now();
        this.log.info("Brain", `OVERRIDE: ${rawMetal} raw metal aboard — running smelt_ores`);
        this.events.onThought("Raw ore does nothing in a pocket. To the furnace!");
        // stashPos unlocks the skill's fuel withdrawal — without it the whole
        // Step 0 is skipped and a bot with ore but no coal loops "No fuel!"
        // beside a stash holding a full stack of it (run 389, 4x in a row).
        const result = await executeAction(this.bot, "invoke_skill", {
          skill: "smelt_ores",
          stashPos: this.roleConfig.stashPos,
        });
        this.events.onAction("smelt_ores", result);
        this.lastAction = "smelt_ores";
        this.lastResult = result;
        this.trackFailure(
          "skill:smelt_ores",
          { action: "smelt_ores", params: {} },
          result,
          /smelted|ingot/i.test(result),
        );
        return;
      }
    }

    // Enchanter override — RUNS BEFORE craft_gear so 2 diamonds route to an
    // enchanting table, not a third pickaxe. The strategic model is told
    // "enchant an item" every cycle and never assembles the table; this fires
    // the deterministic setup_enchanting skill for a crafter-miner holding the
    // diamonds while the team has not yet earned Enchanter. Gated on the
    // advancement itself so it stops the instant the point lands.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("setup_enchanting") &&
      !isSkillRunning(this.bot)
    ) {
      const diamonds = this.bot.inventory
        .items()
        .filter((i) => i.name === "diamond")
        .reduce((s, i) => s + i.count, 0);
      const earned = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const enchanterDone = earned.has("story/enchant_item") || earned.has("minecraft:story/enchant_item");
      const cooled = Date.now() - this.lastEnchantOverrideMs > 300_000;
      if (diamonds >= 2 && !enchanterDone && cooled) {
        this.lastEnchantOverrideMs = Date.now();
        this.log.info("Brain", `OVERRIDE: ${diamonds} diamonds and no Enchanter yet — running setup_enchanting`);
        this.events.onThought("Time to build an enchanting table and finally enchant something.");
        const result = await executeAction(this.bot, "invoke_skill", { skill: "setup_enchanting" });
        this.events.onAction("setup_enchanting", result);
        this.lastAction = "setup_enchanting";
        this.lastResult = result;
        this.trackFailure(
          "skill:setup_enchanting",
          { action: "setup_enchanting", params: {} },
          result,
          /enchant|Enchanter earned/i.test(result),
        );
        return;
      }
    }

    // Breeding override — cheap husbandry point the model never assembles.
    // Fires for a capable bot while "breed an animal" is unearned; the skill
    // itself checks for food + nearby animals and hands back gracefully when
    // either is missing, so a wrong-place firing costs one bounded attempt.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("breed_animals") &&
      !isSkillRunning(this.bot)
    ) {
      const earned = readTeamEarned(BOT_ROSTER.map((b) => b.name));
      const bred = earned.has("husbandry/breed_an_animal") || earned.has("minecraft:husbandry/breed_an_animal");
      const cooled = Date.now() - this.lastBreedOverrideMs > 600_000;
      if (!bred && cooled) {
        this.lastBreedOverrideMs = Date.now();
        this.log.info("Brain", "OVERRIDE: breeding advancement unearned — running breed_animals");
        this.events.onThought("Two of a kind and a handful of wheat. Time to make some babies.");
        const result = await executeAction(this.bot, "invoke_skill", { skill: "breed_animals" });
        this.events.onAction("breed_animals", result);
        this.lastAction = "breed_animals";
        this.lastResult = result;
        this.trackFailure(
          "skill:breed_animals",
          { action: "breed_animals", params: {} },
          result,
          /breed|Fed two/i.test(result),
        );
        return;
      }
    }

    // Iron-pickaxe override — the rung the other pushes stop short of. The
    // strip_mine push stands down as soon as a bot HOLDS iron (correctly), but
    // nothing then converts it: Mason carried 9-11 iron_ingot for a full run,
    // shuffling them between slots, while the model never chose craft_gear.
    // Ingots in hand + no iron pick = craft now. This is the gate to the
    // diamond depth (strip_mine only descends to -58 with an iron pick).
    // Diamond-reserve guard: while Enchanter is unearned and a crafter holds
    // exactly the 2 diamonds the table needs, do not let those become a third
    // pickaxe — the enchanting override above owns them.
    if (
      config.bot.allowStrategyOverrides &&
      this.roleConfig.allowedSkills.includes("craft_gear") &&
      !isSkillRunning(this.bot)
    ) {
      const ingots = this.bot.inventory
        .items()
        .filter((i) => i.name === "iron_ingot")
        .reduce((s, i) => s + i.count, 0);
      // Wear-aware: an iron pick with under 150 uses left dies mid-dive (250
      // total, a descent alone costs ~130 — run 376 lost its pick that way),
      // so a nearly-dead pick counts as no pick and the crafter re-mints.
      const PICK_MAX: Record<string, number> = { iron_pickaxe: 250, diamond_pickaxe: 1561 };
      const hasIronPick = this.bot.inventory
        .items()
        .some(
          (i) =>
            (i.name === "iron_pickaxe" || i.name === "diamond_pickaxe") &&
            (PICK_MAX[i.name] ?? 250) - (i.durabilityUsed ?? 0) >= 150,
        );
      // Diamond tier, same shape: 3 diamonds + 2 sticks = the pickaxe that
      // clears the portal doorway. craft_gear's tier loop prefers the best
      // affordable pick, so invoking it with diamonds aboard mints it.
      const diamondCount = this.bot.inventory
        .items()
        .filter((i) => i.name === "diamond")
        .reduce((s, i) => s + i.count, 0);
      const hasDiamondPickax = this.bot.inventory
        .items()
        .some((i) => i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe");
      const wantsIronPick = ingots >= 3 && !hasIronPick;
      // Reserve 2 diamonds for the enchanting table until Enchanter is earned:
      // a crafter with setup_enchanting only mints a diamond pick from a FIFTH
      // diamond (3 for the pick + 2 held for the table), so the table's stock
      // is never consumed. Bots without the skill keep the plain >=3 rule.
      const reservesForTable =
        this.roleConfig.allowedSkills.includes("setup_enchanting") &&
        !readTeamEarned(BOT_ROSTER.map((b) => b.name)).has("story/enchant_item");
      const diamondPickThreshold = reservesForTable ? 5 : 3;
      const wantsDiamondPick = diamondCount >= diamondPickThreshold && !hasDiamondPickax;
      const cooledDown = Date.now() - this.lastGearOverrideMs > 180_000;
      if ((wantsIronPick || wantsDiamondPick) && cooledDown) {
        this.lastGearOverrideMs = Date.now();
        this.log.info(
          "Brain",
          wantsDiamondPick
            ? `OVERRIDE: ${diamondCount} diamonds and no diamond pickaxe — running craft_gear`
            : `OVERRIDE: ${ingots} iron ingots and no iron pickaxe — running craft_gear`,
        );
        this.events.onThought(
          wantsDiamondPick
            ? "THREE DIAMONDS. The doorway-clearing pickaxe gets crafted RIGHT NOW."
            : "Enough iron in my pack for a REAL pickaxe. To the crafting table!",
        );
        const result = await executeAction(this.bot, "invoke_skill", {
          skill: "craft_gear",
          stashPos: this.roleConfig.stashPos,
        });
        this.events.onAction("craft_gear", result);
        this.lastAction = "craft_gear";
        this.lastResult = result;
        this.trackFailure(
          "skill:craft_gear",
          { action: "craft_gear", params: {} },
          result,
          /crafted|iron_pickaxe|complete/i.test(result),
        );
        return;
      }
    }

    const context = this.buildContext();
    const memoryCtx = this.memStore.getMemoryContext();
    const role: RoleContext = {
      name: this.roleConfig.name,
      personality: this.roleConfig.personality,
      role: this.roleConfig.role,
      seasonGoal: this.roleConfig.seasonGoal ?? this.memStore.getSeasonGoal(),
      allowedActions: this.roleConfig.allowedActions,
      allowedSkills: this.roleConfig.allowedSkills,
      priorities: this.roleConfig.priorities,
    };

    const decision = await queryStrategic(context, this.recentHistory, memoryCtx, role);
    await this.executeDecision(decision);

    // Capture the trajectory for fine-tuning: exact prompt -> decision -> outcome
    recordTrajectory({
      bot: this.roleConfig.name,
      system: buildStrategicPrompt(role),
      context: memoryCtx ? `YOUR MEMORY:\n${memoryCtx}\n${context}` : context,
      decision: { thought: decision.thought, action: decision.action, params: decision.params, goal: decision.goal },
      result: this.lastResult,
      success: this.lastActionWasSuccess,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleCritic(event: BrainEvent): Promise<void> {
    if (!this.CRITIC_ENABLED) return;
    const { action, result, goal } = event.data ?? {};
    if (!action || !result) return;

    // Skip critic for trivial actions
    if (["idle", "chat", "respond_to_chat"].includes(action)) return;

    const criticContext = [
      `Action: ${action}`,
      `Result: ${result}`,
      goal ? `Goal: ${goal} (${this.goalStepsLeft} steps left)` : "No active goal.",
      `Health: ${this.bot.health}/20, Food: ${this.bot.food}/20`,
      `Inventory: ${
        this.bot.inventory
          .items()
          .map((i) => `${i.name}x${i.count}`)
          .join(", ") || "empty"
      }`,
    ].join("\n");

    const verdict = await queryCritic(this.roleConfig.name, criticContext, this.roleConfig.allowedActions);

    // Update thought display
    if (verdict.thought) {
      this.events.onThought(`[critic] ${verdict.thought}`);
    }

    if (verdict.goalComplete) {
      this.log.info("Brain:critic", `Goal "${this.currentGoal}" complete. Re-planning.`);
      this.currentGoal = "";
      this.goalStepsLeft = 0;
      // Trigger strategic re-plan after a brief pause
      setTimeout(() => this.triggerReplan(), 1000);
    } else if (verdict.nextAction && verdict.success) {
      // Critic suggests next step — execute directly without full LLM call
      this.log.debug("Brain:critic", `Next step: ${verdict.nextAction}`);
      await this.executeDecision({
        thought: verdict.thought,
        action: verdict.nextAction,
        params: verdict.nextParams,
      });
    } else if (!verdict.success) {
      // Action failed — trigger strategic re-plan
      this.log.info("Brain:critic", "Action failed. Re-planning.");
      setTimeout(() => this.triggerReplan(), 500);
    }
  }

  // ─── Action execution ─────────────────────────────────────────────────────

  private async executeDecision(decision: {
    thought: string;
    action: string;
    params: Record<string, any>;
    goal?: string;
    goalSteps?: number;
  }): Promise<void> {
    // Filter thought for safety
    const thoughtFilter = filterContent(decision.thought);
    if (!thoughtFilter.safe) {
      decision.thought = thoughtFilter.cleaned;
    }

    // Filter chat actions
    if ((decision.action === "chat" || decision.action === "respond_to_chat") && decision.params?.message) {
      const chatFilter = filterChatMessage(decision.params.message);
      if (!chatFilter.safe) {
        decision.params.message = chatFilter.cleaned;
      }
    }

    // Display thought
    this.events.onThought(decision.thought);
    this.log.info("Brain", `"${decision.thought}" → ${decision.action}`);
    this.log.debug("Brain", "Decision params:", JSON.stringify(decision.params));

    // Update overlay
    updateOverlay({
      health: this.bot.health,
      food: this.bot.food,
      position: {
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z,
      },
      time: this.bot.time.timeOfDay < 13000 || this.bot.time.timeOfDay > 23000 ? "Daytime" : "Nighttime",
      thought: decision.thought,
      action: decision.action,
      actionResult: "...",
      inventory: this.bot.inventory.items().map((i) => `${i.name}x${i.count}`),
    });

    // TTS in background
    generateSpeech(decision.thought)
      .then((url) => {
        if (url) speakThought(url);
      })
      .catch(() => {});

    // Unwrap invoke_skill aliasing a built-in action (e.g. {"skill":"deposit_stash"})
    // so gating and param injection below see the real action.
    const BUILTIN_VIA_SKILL = new Set(["deposit_stash", "withdraw_stash", "gather_wood", "eat", "flee", "explore"]);
    if (decision.action === "invoke_skill" && BUILTIN_VIA_SKILL.has(decision.params?.skill)) {
      decision.action = decision.params.skill;
      delete decision.params.skill;
    }

    // ── Action gating ──
    const UNIVERSAL_ACTIONS = new Set([
      "give_item",
      "idle",
      "respond_to_chat",
      "invoke_skill",
      "deposit_stash",
      "withdraw_stash",
      "chat",
      "generate_skill",
      // Every bot must be able to MOVE and LOOK. Withholding "explore" from
      // non-scout roles meant the farmer/builder/guard fired thousands of
      // rejected look_around/scan/explore decisions (27% of Flora's actions
      // overnight) — looking like they were "standing around" when they were
      // actually stuck in a rejection loop. The alias family (scan,
      // look_around, search...) already normalizes to explore in parseDecision.
      "explore",
    ]);
    if (
      this.roleConfig.allowedActions.length > 0 &&
      !this.roleConfig.allowedActions.includes(decision.action) &&
      !UNIVERSAL_ACTIONS.has(decision.action) &&
      !this.roleConfig.allowedSkills.includes(decision.action)
    ) {
      const gateMsg = `Action "${decision.action}" not allowed for ${this.roleConfig.name}. Use: ${this.roleConfig.allowedActions.join(", ")}`;
      this.log.debug("Brain", `GATED: ${gateMsg}`);
      this.events.onAction(decision.action, gateMsg);
      this.lastResult = gateMsg;
      // Blacklist it so the RECENTLY FAILED prompt section stops the bot from
      // re-picking it — the fine-tuned model especially leaks other roles'
      // actions (trained on all five bots' decisions mixed together).
      this.blockAction(
        decision.action,
        `Not in YOUR toolkit — use: ${this.roleConfig.allowedActions.join(", ")}`,
        BotBrain.FAILURE_TTL_STRUCTURAL_MS,
      );
      return;
    }

    // ── Blacklist check ──
    this.purgeExpiredFailures();
    const actionKey = this.getActionKey(decision);
    if (this.recentFailures.has(actionKey)) {
      const blockMsg = `Blocked: "${actionKey}" recently failed. Try something else.`;
      this.log.debug("Brain", blockMsg);
      this.events.onAction(decision.action, blockMsg);
      this.lastResult = blockMsg;
      // Trigger re-plan since this action was blocked
      setTimeout(() => this.triggerReplan(), 500);
      return;
    }

    // ── Normalize params ──
    const normalizedParams = { ...(decision.params ?? {}) };
    const rawDecision = decision as Record<string, any>;
    for (const field of ["direction", "skill", "item", "block", "blockType", "count", "x", "y", "z", "message"]) {
      if (rawDecision[field] !== undefined && normalizedParams[field] === undefined) {
        normalizedParams[field] = rawDecision[field];
      }
    }

    // Chat dedup — refuse to re-broadcast a near-identical message
    if ((decision.action === "chat" || decision.action === "respond_to_chat") && normalizedParams.message) {
      const sig = String(normalizedParams.message).slice(0, 40);
      if (sig === this.lastChatSent && Date.now() - this.lastChatSentMs < 180_000) {
        const msg =
          "You already said that. Talking won't make it happen — ACT instead (check your inventory first; you may already have what you asked for).";
        this.events.onAction(decision.action, msg);
        this.lastResult = msg;
        return;
      }
      this.lastChatSent = sig;
      this.lastChatSentMs = Date.now();
    }

    // Inject stash config
    if ((decision.action === "deposit_stash" || decision.action === "withdraw_stash") && this.roleConfig.stashPos) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
      normalizedParams.keepItems = this.roleConfig.keepItems;
      // The ingot pocket-reserve assumes the holder can craft with it. A bot
      // with no craft action and no craft_gear skill (Atlas) just hoards:
      // he carried 9 iron ingots for a day while the toolsmith sat 1 ingot
      // short of the iron pickaxe. Non-crafters bank every ingot.
      // The ingot/diamond pocket reserve is for bots that can both craft AND
      // mine — they alone can complete a 3-diamond set on their own. Blade
      // (craft yes, mine no) kept 1 diamond as dead capital for five runs:
      // he can never dig the other two, and the divers can't use his one.
      const canCraft =
        this.roleConfig.allowedActions.includes("craft") || this.roleConfig.allowedSkills.includes("craft_gear");
      const canMine =
        this.roleConfig.allowedActions.includes("mine_block") || this.roleConfig.allowedSkills.includes("strip_mine");
      if (!(canCraft && canMine)) normalizedParams.materialReserve = 0;
      normalizedParams.canMine = canMine;
    }

    // Protect the village site from being strip-mined into bot-trapping pits
    if (decision.action === "mine_block" && this.roleConfig.stashPos) {
      normalizedParams.protectPos = this.roleConfig.stashPos;
    }

    // Inject the farm site (lake shore) into build_farm so the skill can
    // travel to water instead of failing "no water within 96 blocks"
    const isBuildFarm =
      decision.action === "build_farm" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "build_farm");
    if (isBuildFarm && normalizedParams.x === undefined) {
      normalizedParams.x = FARM_SITE.x;
      normalizedParams.y = FARM_SITE.y;
      normalizedParams.z = FARM_SITE.z;
    }
    // build_farm's bake step withdraws pooled wheat from the stash to bake a
    // real bread batch (harvests are too small/scattered to bake individually).
    if (isBuildFarm && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    // Inject stash coordinates into setup_stash — the LLM invents garbage coords otherwise
    const isSetupStash =
      decision.action === "setup_stash" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "setup_stash");
    if (isSetupStash && this.roleConfig.stashPos) {
      normalizedParams.x = this.roleConfig.stashPos.x;
      normalizedParams.y = this.roleConfig.stashPos.y;
      normalizedParams.z = this.roleConfig.stashPos.z;
    }

    // Give smelt_ores the stash position so it can withdraw ore/fuel the team
    // already mined. Bots kept invoking smelt empty-handed ("Nothing to smelt"
    // / "No fuel") because the miner deposits ore+coal and a different bot
    // smelts — this connects them via the shared stash.
    const isSmelt =
      decision.action === "smelt_ores" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "smelt_ores");
    if (isSmelt && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    // Give craft_gear the stash position so it can withdraw iron ingots the team
    // already smelted (the stash is the shared warehouse — use it, per design).
    const isCraftGear =
      decision.action === "craft_gear" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "craft_gear");
    if (isCraftGear && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    // build_house pulls planks/logs from the stash so the builder isn't blocked
    // chopping a whole house's worth of wood from scratch.
    const isBuildHouse =
      decision.action === "build_house" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "build_house");
    if (isBuildHouse && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    // light_area pulls torches from the stash (or crafts them) so it stops
    // failing "No torches" — lit caves cut the top death cause (cave mobs).
    const isLightArea =
      decision.action === "light_area" ||
      (decision.action === "invoke_skill" && normalizedParams.skill === "light_area");
    if (isLightArea && this.roleConfig.stashPos && normalizedParams.stashPos === undefined) {
      normalizedParams.stashPos = this.roleConfig.stashPos;
    }

    // ── Execute ──
    // Do not walk back into the place that keeps killing you.
    //
    // Forge died 31 times in under two hours, median gap 53 seconds, five inside
    // 94 seconds, wearing an iron chestplate for 16 of them. 13 of those deaths
    // are within 8 blocks of one tunnel. He respawns at base, walks back, dies.
    //
    // The respawn-loop breaker fired 7 times and did not help, because it resets
    // the SPAWN point and the danger is where he walks to. memory's
    // shouldAvoidLocation has existed all along with zero callers, and the
    // prompt already says "RECENT DEATHS at (x,y,z)" — the model read that and
    // went back thirteen times. Advice the model can ignore is not a guard.
    //
    // The base is exempt: deaths cluster at the stash too, and refusing to go
    // there would stop the swarm depositing, which is worse than the deaths.
    if (typeof normalizedParams.x === "number" && typeof normalizedParams.z === "number") {
      const target = { x: normalizedParams.x as number, z: normalizedParams.z as number };
      const atBase = isAtBase(
        { x: target.x, y: (normalizedParams.y as number) ?? this.roleConfig.stashPos?.y ?? 0, z: target.z },
        this.roleConfig.stashPos,
      );
      if (isDeathTrap(target, this.memStore.getDeaths(), Date.now(), atBase)) {
        const msg =
          `Refusing to go to ${target.x},${target.z} — you have died there repeatedly in the last 20 minutes. ` +
          `Pick somewhere else, or clear the threat first.`;
        this.log.info("Brain", `DEATH TRAP: ${this.roleConfig.name} blocked from ${target.x},${target.z}`);
        this.events.onAction(decision.action, msg);
        this.lastResult = msg;
        this.blockAction(decision.action, msg, BotBrain.FAILURE_TTL_TRANSIENT_MS);
        return;
      }
    }

    const result = await executeAction(this.bot, decision.action, normalizedParams);
    this.lastAction = decision.action;
    this.lastResult = result;
    this.events.onAction(decision.action, result);
    this.log.info("Brain", `Result: ${result}`);

    // A bot wedged in a pit is not immobile, so nothing rescued it.
    //
    // The dig-out already exists and the pit already qualifies for it, but it
    // only runs when the bot is idle or has not moved in 90 seconds. A bot
    // thrashing in a hole is neither: it is processing continuously, and each
    // failed path shuffles it enough to reset the movement clock.
    //
    // Measured in one 52 minute session: 204 navigation stalls, 111 of them at
    // a single spot four blocks from the stash and three blocks below it, walls
    // of cobblestone on three sides. maxDropDown=3 lets a bot walk INTO that,
    // and safeMoves forbids both digging and towers, so it cannot climb out.
    // Ore mined that hour: zero.
    //
    // Count consecutive stalls instead of watching the position. Repeated
    // failure to reach anything is the symptom that matters, whether or not the
    // bot is shuffling while it fails.
    if (isStallResult(result)) {
      const now = Date.now();
      this.recentStalls = pruneStalls([...this.recentStalls, now], now);
      if (shouldForceDigOut(this.recentStalls, now)) {
        this.log.info(
          "Brain",
          `${this.roleConfig.name} stalled ${this.recentStalls.length}x in 3min — forcing dig-out`,
        );
        this.recentStalls = [];
        // Log the OUTCOME, not just the call. digOutIfStuck returns false
        // immediately when fewer than three walls surround the bot, so 21
        // "forcing dig-out" lines could be 21 escapes or 21 no-ops and the log
        // reads the same. That ambiguity is why I could not explain why Forge
        // kept stalling at 4.5/min while the rescue appeared to be running.
        const dug = await digOutIfStuck(this.bot).catch(() => false);
        this.log.info(
          "Brain",
          `${this.roleConfig.name} dig-out ${dug ? "ATTEMPTED an escape" : "declined (not boxed in)"}`,
        );
      }
    }

    // Update team bulletin
    updateBulletin({
      name: this.roleConfig.name,
      action: decision.action,
      position: {
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z,
      },
      thought: decision.thought,
      health: this.bot.health,
      food: this.bot.food,
      timestamp: Date.now(),
      goal: this.currentGoal || decision.goal,
      lastResult: result.slice(0, 120),
    });

    // Update overlay with result
    updateOverlay({
      health: this.bot.health,
      food: this.bot.food,
      position: {
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z,
      },
      time: this.bot.time.timeOfDay < 13000 || this.bot.time.timeOfDay > 23000 ? "Daytime" : "Nighttime",
      actionResult: result,
      inventory: this.bot.inventory.items().map((i) => `${i.name}x${i.count}`),
    });

    // ── Track goal ──
    if (decision.goal) {
      this.currentGoal = decision.goal;
      this.goalStepsLeft = decision.goalSteps || 5;
    }

    // ── Scoreboard ──
    // (isSuccess computed below — record after it)
    // Skills know whether they worked; only prose has to be guessed at. Reading
    // the recorded boolean first is what stops "HOUSE BUILT!" scoring as a
    // failure and blacklisting a skill that works.
    const skillName = decision.action === "invoke_skill" ? (normalizedParams.skill as string) : decision.action;
    const isSuccess = takeSkillOutcome(this.bot, skillName) ?? classifyResult(result);
    this.lastActionWasSuccess = isSuccess;
    recordAction(this.roleConfig.name, decision.action, result, isSuccess);
    if (decision.action === "invoke_skill" || skillRegistry.has(decision.action)) {
      recordSkillResult(this.roleConfig.name, isSuccess);
    }
    checkInventoryMilestones(this.bot, this.roleConfig.name);

    // Track repeats
    if (decision.action !== "idle") {
      if (actionKey === this.lastAction) {
        this.repeatCount++;
      } else {
        this.repeatCount = 1;
      }
    }

    // "No food" is not transient: food appears only when someone works, so
    // the generic three-repeats-then-brief-block cycle let hungry bots burn
    // three hundred decisions an hour re-ordering from an empty kitchen.
    // Block eat immediately and for long enough that a real restock (a farm
    // harvest, a hunt, a stash run) can happen before the next attempt.
    if (result.startsWith("No food in inventory")) {
      this.blockAction("eat", "No food to eat — withdraw some or work your trade first.", 10 * 60_000);
    }

    // General repeat-breaker: the same action producing the SAME result 3x in
    // a row is a stuck loop — even if the action reports "success" (e.g. Flora
    // "withdrew" planks 6x that never arrived, or chat begging). Blacklist it
    // briefly and force a re-plan so no buggy effector can trap a bot forever.
    const resultSig = `${actionKey}|${result.slice(0, 60)}`;
    if (decision.action !== "idle" && resultSig === this.lastResultSig) {
      this.sameResultCount++;
      if (this.sameResultCount >= 2) {
        this.blockAction(actionKey, `Stuck repeating "${decision.action}" with no change — do something different.`);
        this.sameResultCount = 0;
        this.lastResultSig = "";
        setTimeout(() => this.triggerReplan(), 300);
      }
    } else {
      this.sameResultCount = 0;
      this.lastResultSig = resultSig;
    }

    // Failure tracking
    this.trackFailure(actionKey, decision, result, isSuccess);

    // Track goal steps
    if (isSuccess && this.goalStepsLeft > 0) {
      this.goalStepsLeft--;
    }

    // Lock home position when first house built
    if (isSuccess && decision.action === "build_house" && !this.homePos) {
      const p = this.bot.entity.position;
      this.homePos = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
      this.log.debug("Brain", `Home locked at ${this.homePos.x}, ${this.homePos.y}, ${this.homePos.z}`);
    }

    // Track history
    this.recentHistory.push({
      role: "assistant",
      content: `I decided to ${decision.action}: ${decision.thought}. Result: ${result}`,
    });
    if (this.recentHistory.length > 12) {
      this.recentHistory.splice(0, this.recentHistory.length - 8);
    }

    // ── Trigger critic ──
    if (this.CRITIC_ENABLED && !["idle", "chat", "respond_to_chat"].includes(decision.action)) {
      this.pushEvent({
        type: "critic",
        priority: 6,
        data: {
          action: decision.action,
          result,
          goal: this.currentGoal,
        },
        timestamp: Date.now(),
      });
    }
  }

  // ─── Failure tracking ─────────────────────────────────────────────────────

  private getActionKey(decision: { action: string; params: Record<string, any> }): string {
    if (decision.action === "invoke_skill" && decision.params?.skill) {
      return `skill:${decision.params.skill}`;
    }
    if (skillRegistry.has(decision.action)) {
      return `skill:${decision.action}`;
    }
    if (decision.action === "craft" && decision.params?.item) {
      return `craft:${decision.params.item}`;
    }
    return decision.action;
  }

  private trackFailure(
    actionKey: string,
    decision: { action: string; params: Record<string, any> },
    result: string,
    isSuccess: boolean,
  ): void {
    // Hallucinated action names
    if (result.startsWith("Unknown action:")) {
      this.blockAction(decision.action, "Unknown action", BotBrain.FAILURE_TTL_STRUCTURAL_MS);
      return;
    }

    // Retired skills — put them straight into the do-NOT-retry prompt list
    // so the LLM stops re-picking them from conversation history.
    if (result.includes("is RETIRED")) {
      this.blockAction(
        actionKey,
        "Retired — proven broken, use basic actions instead",
        BotBrain.FAILURE_TTL_STRUCTURAL_MS,
      );
      return;
    }

    const isSkillAction =
      skillRegistry.has(decision.action) ||
      decision.action === "invoke_skill" ||
      decision.action === "neural_combat" ||
      decision.action === "generate_skill" ||
      decision.action === "craft";

    if (!isSkillAction) {
      // Track "attack" no-target failures
      if (decision.action === "attack" && /no mobs to attack nearby/i.test(result)) {
        const prevCount = (this.failureCounts.get("attack") ?? 0) + 1;
        this.failureCounts.set("attack", prevCount);
        if (prevCount >= 3) {
          this.blockAction("attack", "No mobs nearby — explore first");
        }
      } else if (decision.action === "attack" && isSuccess) {
        this.failureCounts.delete("attack");
        this.recentFailures.delete("attack");
      }
    }

    if (isSkillAction) {
      if (!isSuccess) {
        const isAlreadyRunning = result.startsWith("Already running skill");
        const isPreconditionFailure =
          /missing:|need \d|no water|no trees|no coal|no iron|no pickaxe|Can't craft|could not find|not enough|need to (mine|craft|find|smelt)|Can't sleep|terrain too rough|not nighttime|already sleeping|zzz/i.test(
            result,
          );

        if (!isAlreadyRunning && !isPreconditionFailure) {
          const prevCount = (this.failureCounts.get(actionKey) ?? 0) + 1;
          this.failureCounts.set(actionKey, prevCount);
          if (prevCount >= 2) {
            this.blockAction(actionKey, result.slice(0, 120));
          }
        } else if (!isAlreadyRunning && /no trees/i.test(result)) {
          this.blockAction(actionKey, "No trees — explore first");
        } else if (!isAlreadyRunning && /no water/i.test(result)) {
          this.blockAction(actionKey, "No water — explore first");
        }
      } else {
        this.failureCounts.delete(actionKey);
        this.recentFailures.delete(actionKey);
        this.clearBlockHistory(actionKey);
      }
    }

    // Expire old failures every 8 successes
    if (isSuccess) {
      this.successesSinceLastExpiry++;
      if (this.successesSinceLastExpiry >= 8 && this.recentFailures.size > 0) {
        this.successesSinceLastExpiry = 0;
        for (const [firstKey, firstMsg] of this.recentFailures.entries()) {
          if (!/no water found/i.test(firstMsg) && !/need 3 wool/i.test(firstMsg)) {
            this.recentFailures.delete(firstKey);
            break;
          }
        }
      }
    }

    // Dynamic precondition clearing
    for (const [key, msg] of this.recentFailures.entries()) {
      if (/missing.*coal/i.test(msg)) {
        const count = this.bot.inventory
          .items()
          .filter((i) => i.name === "coal")
          .reduce((s, i) => s + i.count, 0);
        if (count > 0) {
          this.recentFailures.delete(key);
          this.failureCounts.delete(key);
        }
      } else if (/missing.*stick/i.test(msg)) {
        const count = this.bot.inventory
          .items()
          .filter((i) => i.name === "stick")
          .reduce((s, i) => s + i.count, 0);
        if (count > 0) {
          this.recentFailures.delete(key);
          this.failureCounts.delete(key);
        }
      } else if (/missing.*wood|missing.*log|missing.*plank/i.test(msg)) {
        const count = this.bot.inventory
          .items()
          .filter((i) => i.name.includes("log") || i.name.includes("planks"))
          .reduce((s, i) => s + i.count, 0);
        if (count > 0) {
          this.recentFailures.delete(key);
          this.failureCounts.delete(key);
        }
      } else if (/no torch/i.test(msg)) {
        const count = this.bot.inventory
          .items()
          .filter((i) => i.name === "torch")
          .reduce((s, i) => s + i.count, 0);
        if (count > 0) {
          this.recentFailures.delete(key);
          this.failureCounts.delete(key);
        }
      }
    }
  }
}
