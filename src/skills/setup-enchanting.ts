import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import mcDataLoader from "minecraft-data";
import { baseMoves, explorerMoves, safeGoto, collectNearbyDrops } from "../bot/navigation.js";

/**
 * setup_enchanting — earn the Enchanter advancement deterministically.
 *
 * The strategic model is told "enchant an item at a table" and wanders off,
 * exactly like it did with the portal until build_nether_portal did every step
 * in order. This skill is that same deterministic chain for enchanting:
 *
 *   obsidian x4 (stash)  +  diamond x2 (held)  +  book x1  ->  enchanting_table
 *   book  =  paper x3 (sugar cane)  +  leather x1 (cow)
 *   place the table  ->  put a spare tool + lapis + spend XP  ->  Enchanter.
 *
 * Every material is stash-first, then a bounded gather, then a resumable
 * hand-back so partial progress banks and the next invocation continues.
 */

const RUN_MS = 420_000;

function count(bot: Bot, name: string): number {
  return bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((s, i) => s + i.count, 0);
}

async function tryWithdraw(bot: Bot, name: string, n: number): Promise<void> {
  try {
    const { withdrawStash } = await import("./stash.js");
    const { STASH_POS } = await import("../bot/role.js");
    const near = Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z) < 60;
    if (!near) return;
    // No Promise.race here: losing the race did not CANCEL the withdrawal —
    // the abandoned scan kept walking chest to chest for another minute while
    // the skill moved on to the cow hunt, and the two fought over the
    // pathfinder ("goto interrupted externally" on every hunt leg). The
    // budget now travels INTO withdrawStash, which checks it between chests.
    await withdrawStash(bot, STASH_POS, name, n, 40_000).catch(() => {});
  } catch {
    /* stash unavailable */
  }
}

/** Craft `want` x`n` at a nearby table (or none for 2x2 recipes). Best-effort. */
async function craft(bot: Bot, want: string, n: number, needTable: boolean): Promise<boolean> {
  const mc = mcDataLoader(bot.version);
  const item = mc.itemsByName[want];
  if (!item) return false;
  let table = null;
  if (needTable) {
    table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 48 });
    if (!table) return false;
    try {
      await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20_000);
    } catch {
      /* craft still tries from where we are */
    }
  }
  const recipe = bot.recipesFor(item.id, null, n, table)[0];
  if (!recipe) return false;
  try {
    await bot.craft(recipe, n, table ?? undefined);
    return true;
  } catch {
    return false;
  }
}

export const setupEnchantingSkill: Skill = {
  name: "setup_enchanting",
  description:
    "Build an enchanting table (4 obsidian + 2 diamonds + 1 book) near the stash and enchant a spare tool — earns the Enchanter advancement. Gathers the book (paper from sugar cane, leather from cows) and lapis as needed.",
  params: {},
  timeoutMs: 480_000,

  estimateMaterials() {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const deadline = Date.now() + RUN_MS;
    const timeLeft = () => deadline - Date.now();
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"setup_enchanting"} again to continue from here.`;
    const step = (phase: string, progress: number, message: string) =>
      onProgress({ skillName: "setup_enchanting", phase, progress, message, active: true });

    const { STASH_POS } = await import("../bot/role.js");
    bot.pathfinder.setMovements(baseMoves(bot));

    // If the table already stands, jump straight to enchanting.
    let table = bot.findBlock({ matching: (b) => b.name === "enchanting_table", maxDistance: 24 });

    if (!table) {
      // Walk to the stash first — the banked obsidian, diamonds and book
      // parts all live there, and tryWithdraw only fires within 60 blocks.
      // The override can trigger from anywhere (Forge lands here from the
      // mine 300 blocks out), so the first pass would withdraw nothing.
      const homeGap = () => Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z);
      if (homeGap() > 55) {
        step("Home", 0.02, `Walking to the stash to gather materials (${homeGap().toFixed(0)} away)...`);
        const walkDeadline = Date.now() + 150_000;
        while (Date.now() < walkDeadline && homeGap() > 55) {
          if (timeLeft() < 90_000) break;
          await safeGoto(bot, new goals.GoalXZ(STASH_POS.x, STASH_POS.z), 45_000, 12_000).catch(() => {});
          if (homeGap() > 55) await new Promise((r) => setTimeout(r, 2000));
        }
        if (homeGap() > 55) {
          return {
            success: false,
            message: resumable(`Heading to the stash — still ${homeGap().toFixed(0)} blocks out.`),
          };
        }
      }

      // --- Obsidian: stash first, else mine the preserved deep-frame blocks ---
      // The 9 banked obsidian is gone, but two rogue deep frames were struck
      // from the registry back in the portal era specifically to keep their
      // cast obsidian as the enchanting-table stock. Mining it needs a
      // diamond-or-better pick, which is the real gate: the crafter needs 5
      // diamonds (3 for the pick, 2 reserved for the table). Until then this
      // hands back the honest prerequisite and the gear reflex mints the pick.
      step("Obsidian", 0.05, "Gathering 4 obsidian for the table...");
      if (count(bot, "obsidian") < 4) await tryWithdraw(bot, "obsidian", 4 - count(bot, "obsidian"));
      if (count(bot, "obsidian") < 4) {
        const hasDiamondPick = bot.inventory
          .items()
          .some((i) => i.name === "diamond_pickaxe" || i.name === "netherite_pickaxe");
        if (!hasDiamondPick) {
          return {
            success: false,
            message: resumable(
              `Need 4 obsidian and no diamond pickaxe to mine it — mine diamonds for a pick (5 total: 3 craft the pick, 2 stay for the table), then continue.`,
            ),
          };
        }
        // Commute to a preserved deep frame and mine its obsidian.
        const FRAMES: Vec3[] = [new Vec3(334, -53, -311), new Vec3(391, -54, -288)];
        const frame = FRAMES.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))[0];
        step("Obsidian", 0.08, `Mining obsidian from the deep frame at ${frame.x},${frame.y},${frame.z}...`);
        const marchDeadline = Date.now() + Math.min(180_000, timeLeft() - 60_000);
        while (Date.now() < marchDeadline && bot.entity.position.distanceTo(frame) > 26) {
          await safeGoto(bot, new goals.GoalNear(frame.x, frame.y, frame.z, 3), 45_000, 12_000).catch(() => {});
          if (bot.entity.position.distanceTo(frame) > 26) await new Promise((r) => setTimeout(r, 1500));
        }
        if (bot.entity.position.distanceTo(frame) > 26) {
          return {
            success: false,
            message: resumable(
              `Commuting to the obsidian at ${frame.x},${frame.y},${frame.z} — still ${bot.entity.position.distanceTo(frame).toFixed(0)} blocks out.`,
            ),
          };
        }
        const { mineObsidian } = await import("./obsidian.js");
        const mined = await mineObsidian(bot, 4 - count(bot, "obsidian"));
        step("Obsidian", 0.12, `Obsidian: ${mined}`);
      }
      if (count(bot, "obsidian") < 4) {
        return {
          success: false,
          message: resumable(`Still gathering obsidian for the table, have ${count(bot, "obsidian")}/4.`),
        };
      }

      step("Diamonds", 0.15, "Checking diamonds...");
      if (count(bot, "diamond") < 2) await tryWithdraw(bot, "diamond", 2 - count(bot, "diamond"));
      if (count(bot, "diamond") < 2) {
        return {
          success: false,
          message: resumable(`Need 2 diamonds for the enchanting table, have ${count(bot, "diamond")}.`),
        };
      }

      // --- Book: 3 paper + 1 leather ---
      if (count(bot, "book") < 1) {
        step("Book", 0.25, "Assembling a book (3 paper + 1 leather)...");
        await tryWithdraw(bot, "book", 1);
      }
      if (count(bot, "book") < 1) {
        // Paper from sugar cane.
        if (count(bot, "paper") < 3) {
          await tryWithdraw(bot, "paper", 3 - count(bot, "paper"));
          // The stash can hold CANE too — the ledger found 2 banked while this
          // step only ever asked for finished paper and then swept the map.
          if (count(bot, "paper") < 3 && count(bot, "sugar_cane") < 3) {
            await tryWithdraw(bot, "sugar_cane", 3 - count(bot, "sugar_cane"));
          }
          if (count(bot, "paper") < 3 && count(bot, "sugar_cane") >= 3) {
            await craft(bot, "paper", 1, true);
          }
          // 1-2 cane cannot craft (the recipe takes 3 at once) but they can
          // FARM: cane planted beside water regrows forever. Plant the
          // shortfall at the waterline and let the resumable refires harvest
          // the regrowth — turns a dead-end pair of stalks into a supply.
          // HARVEST BEFORE PLANTING: the PlantDebug tally exposed a live
          // 2-tall cane stalk already standing beside the water (ground
          // sugar_cane + above sugar_cane in the side verdicts) while this
          // step was busy failing to plant from a ridge 14 blocks above the
          // shore. One cut of an existing stalk beats all of that pathing —
          // with 2 held, a single harvested stalk completes the 3-cane paper
          // craft. Planting is the fallback when no live stalk is in reach.
          const liveStalk = bot.findBlock({ matching: (b) => b.name === "sugar_cane", maxDistance: 48 });
          if (count(bot, "paper") < 3 && count(bot, "sugar_cane") >= 1 && count(bot, "sugar_cane") < 3 && !liveStalk) {
            // Plant at the PROVEN waterline, never the nearest puddle: from
            // the village the nearest "water" is the cobble-rimmed well, where
            // every side fails the dirt/grass/sand test — the planting step
            // fired and the cane stayed dead in the pack. FARM_SITE is the
            // open shore the farm's clear-plot scan validated.
            step("Book", 0.29, "Planting spare sugar cane by the water to farm more...");
            const { FARM_SITE } = await import("../bot/role.js");
            // ARRIVE before planting — a single unverified walk left Forge
            // planting from the village stash, where the only waters are the
            // cobble-rimmed well and the old irrigation bed (PlantDebug:
            // cobblestone x8, chest x3, farmland x2 — zero plantable ground).
            const siteGap = () => Math.hypot(bot.entity.position.x - FARM_SITE.x, bot.entity.position.z - FARM_SITE.z);
            const plantMarch = Date.now() + 90_000;
            while (Date.now() < plantMarch && siteGap() > 10 && !signal.aborted && timeLeft() > 90_000) {
              await safeGoto(bot, new goals.GoalNearXZ(FARM_SITE.x, FARM_SITE.z, 6), 45_000, 12_000).catch(() => {});
              if (siteGap() > 10) await new Promise((r) => setTimeout(r, 1500));
            }
            if (siteGap() > 10) {
              return {
                success: false,
                message: resumable(`Carrying cane to the farm waterline — still ${siteGap().toFixed(0)} blocks out.`),
              };
            }
            const caneBefore = count(bot, "sugar_cane");
            const waters = bot.findBlocks({ matching: (b) => b.name === "water", maxDistance: 24, count: 8 });
            const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
            // INSTRUMENTATION: the plant step has failed silently twice — name
            // the reasons. Every side of every water gets a verdict so the log
            // says whether the shore is farmland, the walk failed, or no water
            // was found at all.
            const rejects = new Map<string, number>();
            const p0 = bot.entity.position;
            console.log(
              `[PlantDebug] at ${p0.x.toFixed(0)},${p0.y.toFixed(0)},${p0.z.toFixed(0)} — ${waters.length} waters within 24`,
            );
            planting: for (const wp of waters) {
              for (const d of sides) {
                if (count(bot, "sugar_cane") < 1) break planting;
                const groundPos = wp.plus(d);
                const ground = bot.blockAt(groundPos);
                const above = bot.blockAt(groundPos.offset(0, 1, 0));
                if (!ground || !/^(dirt|grass_block|sand)$/.test(ground.name)) {
                  rejects.set(ground?.name ?? "unloaded", (rejects.get(ground?.name ?? "unloaded") ?? 0) + 1);
                  continue;
                }
                if (!above || above.name !== "air") {
                  rejects.set(
                    `above:${above?.name ?? "unloaded"}`,
                    (rejects.get(`above:${above?.name ?? "unloaded"}`) ?? 0) + 1,
                  );
                  continue;
                }
                try {
                  await safeGoto(bot, new goals.GoalNear(groundPos.x, groundPos.y + 1, groundPos.z, 2), 20_000);
                  const caneItem = bot.inventory.items().find((i) => i.name === "sugar_cane");
                  if (!caneItem) break planting;
                  await bot.equip(caneItem, "hand");
                  await bot.placeBlock(ground, new Vec3(0, 1, 0)).catch(() => {});
                } catch {
                  /* next side */
                }
              }
            }
            const planted = caneBefore - count(bot, "sugar_cane");
            if (planted > 0) {
              console.log(`[Skill] setup_enchanting planted ${planted} sugar cane at the farm waterline`);
            } else {
              const why = [...rejects.entries()].map(([k, v]) => `${k}x${v}`).join(" ");
              console.log(`[PlantDebug] planted nothing — side verdicts: ${why || "no waters/sides examined"}`);
            }
          }
          if (count(bot, "paper") < 3) {
            // Harvest sugar cane if any is in reach.
            if (timeLeft() > 90_000) {
              let cane = bot.findBlock({ matching: (b) => b.name === "sugar_cane", maxDistance: 48 });
              // EXPLORE for cane when none is local: an RCON survey found zero
              // sugar cane on any waterline within ~120 blocks of the village,
              // so the 48-block search can never succeed from home. Hop
              // outward along a committed heading (the pattern that cracked
              // breeding) and rescan; the skill refires resumably every few
              // minutes, so each invocation's hops compound into a widening
              // sweep from wherever the last one ended.
              if (!cane && timeLeft() > 150_000) {
                const dirs = [
                  [1, 0],
                  [-1, 0],
                  [0, 1],
                  [0, -1],
                ] as const;
                const [dx, dz] = dirs[Math.floor(Math.random() * dirs.length)];
                for (let hop = 0; hop < 2 && !cane && !signal.aborted && timeLeft() > 120_000; hop++) {
                  step("Book", 0.28, `No sugar cane near — scouting for a riverbank (hop ${hop + 1}/2)...`);
                  const p = bot.entity.position;
                  await safeGoto(bot, new goals.GoalNearXZ(p.x + dx * 70, p.z + dz * 70, 8), 45_000, 12_000).catch(
                    () => {},
                  );
                  cane = bot.findBlock({ matching: (b) => b.name === "sugar_cane", maxDistance: 48 });
                }
              }
              if (cane) {
                step("Book", 0.3, "Harvesting sugar cane for paper...");
                try {
                  // MARCH to the stalk — a single 30s goto could not descend
                  // the ridge to the waterline, so the dig threw out-of-reach
                  // into an empty catch and the count never moved. Same
                  // arrival-verified loop as every other leg of this skill.
                  const gap = () => bot.entity.position.distanceTo(cane.position);
                  // Swim-capable movements: the march stalled at 5.3 blocks —
                  // just past dig reach — because the stalk sits across a
                  // water gap at the shore that the cautious move-set refuses
                  // to wade. Waterline harvesting means getting wet.
                  bot.pathfinder.setMovements(explorerMoves(bot));
                  const cutMarch = Date.now() + 90_000;
                  while (Date.now() < cutMarch && gap() > 3 && !signal.aborted && timeLeft() > 60_000) {
                    await safeGoto(
                      bot,
                      new goals.GoalNear(cane.position.x, cane.position.y, cane.position.z, 1),
                      30_000,
                      12_000,
                    ).catch(() => {});
                    if (gap() > 3) await new Promise((r) => setTimeout(r, 1500));
                  }
                  // Cut the STALK, never the base: a planted base regrows
                  // forever, and digging it kills the farm the planting step
                  // just made. If the found block sits on another cane it IS
                  // stalk — cut it; if it is a base, cut the growth above it,
                  // and leave a still-growing 1-tall base alone.
                  const below = bot.blockAt(cane.position.offset(0, -1, 0));
                  const above = bot.blockAt(cane.position.offset(0, 1, 0));
                  const target = below?.name === "sugar_cane" ? cane : above?.name === "sugar_cane" ? above : null;
                  const beforeCut = count(bot, "sugar_cane");
                  if (target) {
                    const b = bot.blockAt(target.position);
                    if (b) await bot.dig(b).catch(() => {});
                    await collectNearbyDrops(bot, 4, 3000);
                  }
                  console.log(
                    `[HarvestDebug] stalk at ${cane.position} dist=${gap().toFixed(1)} target=${target ? (target === cane ? "found-block" : "above") : "1-tall-left-growing"} cane ${beforeCut}->${count(bot, "sugar_cane")}`,
                  );
                } catch (e) {
                  console.log(`[HarvestDebug] harvest failed: ${(e as Error).message}`);
                } finally {
                  bot.pathfinder.setMovements(baseMoves(bot));
                }
                if (count(bot, "sugar_cane") >= 3) await craft(bot, "paper", 1, true);
              }
            }
          }
        }
        // Leather from a cow.
        if (count(bot, "paper") >= 3 && count(bot, "leather") < 1) {
          await tryWithdraw(bot, "leather", 1);
          if (count(bot, "leather") < 1 && timeLeft() > 90_000) {
            // Anything that drops leather is a valid hunt: the night a cow
            // finally grazed near the stash it wandered off before the skill
            // refired, while a horse stood 27 blocks away the entire time.
            const dropsLeather = (e: { name?: string }) =>
              e.name === "cow" ||
              e.name === "mooshroom" ||
              e.name === "horse" ||
              e.name === "donkey" ||
              e.name === "mule" ||
              e.name === "llama";
            let cow = bot.nearestEntity(dropsLeather);
            // EXPLORE for a cow when none is loaded: the herds graze 128-256
            // blocks out, past the ~80-block entity stream — the same
            // perception wall breeding hit. Hop outward and rescan; resumable
            // refires compound the sweep.
            if (!cow && timeLeft() > 150_000) {
              // Sweep all four compass directions from where we stand instead
              // of betting the whole scout on one random heading — Paper only
              // streams animals within ~48 blocks, and the herd that random
              // pick missed three runs straight was 57 blocks southwest.
              const home = bot.entity.position.clone();
              const dirs = [
                ["east", 1, 0],
                ["west", -1, 0],
                ["south", 0, 1],
                ["north", 0, -1],
                ["northwest", -0.7, -0.7],
                ["southeast", 0.7, 0.7],
                ["northeast", 0.7, -0.7],
                ["southwest", -0.7, 0.7],
              ] as const;
              for (const [label, dx, dz] of dirs) {
                if (cow || signal.aborted || timeLeft() < 90_000) break;
                step("Book", 0.33, `No cow in sight — scouting ${label}...`);
                await safeGoto(bot, new goals.GoalNearXZ(home.x + dx * 60, home.z + dz * 60, 8), 40_000, 12_000).catch(
                  () => {},
                );
                cow = bot.nearestEntity(dropsLeather);
              }
            }
            if (cow) {
              step("Book", 0.35, "Hunting a cow for leather...");
              // A hit cow bolts straight out of the 3-block attack reach, so a
              // single goto to its REMEMBERED position followed by blind swings
              // lands one hit at best. Chase the live entity between swings and
              // swing something with an edge.
              const weapon =
                bot.inventory.items().find((i) => i.name.endsWith("_sword")) ??
                bot.inventory.items().find((i) => i.name.endsWith("_axe")) ??
                bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
              if (weapon) await bot.equip(weapon, "hand").catch(() => {});
              const fightUntil = Date.now() + 35_000;
              try {
                while (cow.isValid && Date.now() < fightUntil && !signal.aborted) {
                  if (bot.entity.position.distanceTo(cow.position) > 2.5) {
                    await safeGoto(bot, new goals.GoalFollow(cow, 1.5), 8_000).catch(() => {});
                  }
                  if (!cow.isValid) break;
                  await bot.attack(cow);
                  await new Promise((r) => setTimeout(r, 600));
                }
                await collectNearbyDrops(bot, 5, 4000);
              } catch {
                /* best effort */
              }
            }
          }
        }
        // Craft the book if both parts are in hand.
        if (count(bot, "paper") >= 3 && count(bot, "leather") >= 1) {
          step("Book", 0.4, "Crafting the book...");
          await craft(bot, "book", 1, true);
        }
      }
      if (count(bot, "book") < 1) {
        const need: string[] = [];
        if (count(bot, "paper") < 3) need.push(`paper (${count(bot, "paper")}/3 — from sugar cane)`);
        if (count(bot, "leather") < 1) need.push("leather (from a cow)");
        return { success: false, message: resumable(`Still need for the book: ${need.join(", ") || "assembly"}.`) };
      }

      // --- Craft and place the table ---
      step("Table", 0.55, "Crafting the enchanting table...");
      if (!(await craft(bot, "enchanting_table", 1, true)) || count(bot, "enchanting_table") < 1) {
        return { success: false, message: resumable("Have the materials but couldn't craft the table near a table.") };
      }

      step("Table", 0.65, "Placing the enchanting table by the stash...");
      try {
        await safeGoto(bot, new goals.GoalNear(STASH_POS.x, STASH_POS.y, STASH_POS.z, 3), 45_000);
      } catch {
        /* place where we are */
      }
      const here = bot.entity.position.floored();
      const tableItem = bot.inventory.items().find((i) => i.name === "enchanting_table");
      const spots = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
      for (const d of spots) {
        const target = here.plus(d);
        const below = bot.blockAt(target.offset(0, -1, 0));
        const at = bot.blockAt(target);
        if (tableItem && below && below.name !== "air" && at && (at.name === "air" || at.name === "cave_air")) {
          try {
            await bot.equip(tableItem, "hand");
            await bot.placeBlock(below, new Vec3(0, 1, 0));
            break;
          } catch {
            /* try the next spot */
          }
        }
      }
      table = bot.findBlock({ matching: (b) => b.name === "enchanting_table", maxDistance: 8 });
      if (!table) {
        return {
          success: false,
          message: resumable("Crafted the table but couldn't place it — retry near open ground."),
        };
      }
    }

    // --- Enchant a spare tool ---
    step("Enchant", 0.8, "Enchanting a tool at the table...");

    // Lapis: at least one.
    if (count(bot, "lapis_lazuli") < 1) await tryWithdraw(bot, "lapis_lazuli", 3);
    if (count(bot, "lapis_lazuli") < 1) {
      return {
        success: false,
        message: resumable("Enchanting table is up but I have no lapis lazuli — mine or withdraw some, then continue."),
      };
    }

    // A spare, non-best enchantable tool: prefer a lesser pickaxe/tool so we
    // never enchant away the bot's working gear.
    const RANK: Record<string, number> = { wooden: 0, stone: 1, golden: 1, iron: 2, diamond: 3, netherite: 4 };
    const tools = bot.inventory
      .items()
      .filter((i) => /_pickaxe$|_axe$|_shovel$|_sword$|_hoe$/.test(i.name))
      .sort((a, b) => (RANK[a.name.split("_")[0]] ?? 0) - (RANK[b.name.split("_")[0]] ?? 0));
    const target = tools[0];
    if (!target) {
      return {
        success: false,
        message: resumable("No spare tool to enchant — craft any pickaxe first, then continue."),
      };
    }

    try {
      await safeGoto(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20_000);
    } catch {
      /* openBlock works from close range */
    }

    try {
      const et: any = await (bot as any).openEnchantmentTable(table);
      await et.putTargetItem(target);
      const lapis = bot.inventory.items().find((i) => i.name === "lapis_lazuli");
      if (lapis) await et.putLapis(lapis);
      // Wait for the enchant options to populate, then take the cheapest (0).
      await Promise.race([
        new Promise<void>((resolve) => et.once("ready", resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 8000)),
      ]);
      await et.enchant(0);
      await new Promise((r) => setTimeout(r, 600));
      try {
        await et.takeTargetItem();
      } catch {
        /* item auto-returned on some versions */
      }
      et.close();
      return {
        success: true,
        message: `Enchanted a ${target.name} at the enchanting table — Enchanter earned!`,
        stats: { enchanted: 1 },
      };
    } catch (e) {
      return {
        success: false,
        message: resumable(
          `Table is placed and I have lapis, but the enchant didn't complete (${(e as Error).message}).`,
        ),
      };
    }
  },
};
