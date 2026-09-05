import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { baseMoves, safeGoto } from "../bot/navigation.js";

/**
 * breed_animals — earn "The Parrots and the Bats" (husbandry/breed_an_animal).
 *
 * The strategic model never assembles the two-adults-plus-food ritual on its
 * own. This skill does it deterministically: pick a species we hold food for,
 * feed two nearby adults, and let them breed. Food is stash-first so a farmer's
 * pooled wheat/seeds get used.
 */

// Food each species accepts, in order of what the swarm most reliably has.
const FEED: { food: string; species: string[] }[] = [
  { food: "wheat", species: ["cow", "sheep", "mooshroom", "goat"] },
  { food: "wheat_seeds", species: ["chicken"] },
  { food: "carrot", species: ["pig"] },
  { food: "potato", species: ["pig"] },
];

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
    if (Math.hypot(bot.entity.position.x - STASH_POS.x, bot.entity.position.z - STASH_POS.z) > 60) return;
    await Promise.race([withdrawStash(bot, STASH_POS, name, n), new Promise<void>((r) => setTimeout(r, 30_000))]).catch(
      () => {},
    );
  } catch {
    /* stash unavailable */
  }
}

export const breedAnimalsSkill: Skill = {
  name: "breed_animals",
  description:
    "Breed two farm animals (feed two cows/sheep wheat, or chickens seeds) to earn the breeding advancement. Uses held or stashed food.",
  params: {},
  timeoutMs: 300_000,

  estimateMaterials() {
    return {};
  },

  async execute(bot, _params, signal, onProgress): Promise<SkillResult> {
    const resumable = (msg: string) => `${msg} invoke_skill {"skill":"breed_animals"} again to continue from here.`;
    const step = (progress: number, message: string) =>
      onProgress({ skillName: "breed_animals", phase: "Breeding", progress, message, active: true });
    bot.pathfinder.setMovements(baseMoves(bot));

    // A bot only perceives entities the server streams to it — roughly an
    // 80-block tracking range — but this map's animals sit 128-256 blocks out
    // and fully dispersed, so bot.entities is usually EMPTY of them and the lure
    // below has nothing to work with (the skill returned "none nearby" every
    // run). Before luring, EXPLORE to pull a herd into perception range: walk
    // toward the nearest lone feedable animal we can see, or scout cardinally
    // when we see none, rescanning after each hop. Bounded so it cannot hang.
    for (const { food } of FEED) if (count(bot, food) < 2) await tryWithdraw(bot, food, 2);
    const feedableSpecies = FEED.filter((f) => count(bot, f.food) >= 2).flatMap((f) => f.species);
    const visiblePair = () => {
      const bySpec = new Map<string, number>();
      for (const e of Object.values(bot.entities))
        if (e.name && feedableSpecies.includes(e.name) && e.position.distanceTo(bot.entity.position) < 220)
          bySpec.set(e.name, (bySpec.get(e.name) ?? 0) + 1);
      return [...bySpec.values()].some((n) => n >= 2);
    };
    if (feedableSpecies.length && !visiblePair()) {
      // Commit to ONE outward direction for the whole scout, varied per run.
      // The first version cycled cardinals per hop (E, S, W), a zigzag whose net
      // displacement was near zero — Flora scouted three times and never left
      // the village, so the herds 128-256 blocks out stayed invisible. A single
      // heading covers ~210 blocks in three hops; a fresh random heading each
      // invocation sweeps the ring around the village across successive runs.
      const cardinals = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ];
      const [ddx, ddz] = cardinals[Math.floor(Math.random() * cardinals.length)];
      for (let hop = 0; hop < 3 && !visiblePair() && !signal.aborted; hop++) {
        const nearest = Object.values(bot.entities)
          .filter((e) => e.name && feedableSpecies.includes(e.name))
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
        const p = bot.entity.position;
        // Head to a lone animal if one is now visible (it pulls its neighbours
        // into range); otherwise keep pressing outward along the chosen heading.
        const destX = nearest ? nearest.position.x : p.x + ddx * 70;
        const destY = nearest ? nearest.position.y : p.y;
        const destZ = nearest ? nearest.position.z : p.z + ddz * 70;
        step(
          0.02 + hop * 0.02,
          nearest
            ? `Heading to a lone ${nearest.name} to gather a herd...`
            : `Scouting for a herd (hop ${hop + 1}/3)...`,
        );
        await safeGoto(bot, new goals.GoalNear(destX, destY, destZ, 3), 45_000, 12_000).catch(() => {});
      }
    }

    // Pick the first food we hold (or can withdraw) whose species has at least
    // two animals loaded. The map's animals are almost never in a natural
    // cluster — a census found zero same-species pairs within 32 blocks of each
    // other — so passively hoping for two-underfoot never fired. Instead we
    // LURE: an animal follows a player holding its food within ~10 blocks, so
    // Flora equips the food, walks to the nearest of the pair, then to the
    // second, and both trail her into feeding range.
    for (const { food, species } of FEED) {
      if (count(bot, food) < 2) await tryWithdraw(bot, food, 2);
      if (count(bot, food) < 2) continue;

      const loaded = Object.values(bot.entities).filter(
        (e) => e.name && species.includes(e.name) && e.position.distanceTo(bot.entity.position) < 220,
      );
      const bySpecies = new Map<string, typeof loaded>();
      for (const e of loaded) bySpecies.set(e.name!, [...(bySpecies.get(e.name!) ?? []), e]);

      // Choose the species+pair with the SMALLEST lure walk: distance from Flora
      // to the nearer animal plus the distance between the two. A tight pair
      // 150 blocks out beats a scattered pair 40 blocks out — the lure only has
      // to bridge the gap between the two once Flora reaches them.
      let best: { food: string; a: (typeof loaded)[number]; b: (typeof loaded)[number]; cost: number } | null = null;
      for (const [, group] of bySpecies) {
        if (group.length < 2) continue;
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const a =
              group[i].position.distanceTo(bot.entity.position) <= group[j].position.distanceTo(bot.entity.position)
                ? group[i]
                : group[j];
            const b = a === group[i] ? group[j] : group[i];
            const cost = a.position.distanceTo(bot.entity.position) + a.position.distanceTo(b.position);
            if (!best || cost < best.cost) best = { food, a, b, cost };
          }
        }
      }
      if (!best) continue;

      // Equip the food up front: this is what makes the animals follow.
      const equipFood = async () => {
        const item = bot.inventory.items().find((i) => i.name === best!.food);
        if (item) await bot.equip(item, "hand").catch(() => {});
        return !!item;
      };
      if (!(await equipFood())) continue;

      // Lead to the first animal, then to the second; the first trails on the
      // food. walkTo keeps re-issuing the goal because the target entity drifts.
      const walkTo = async (target: (typeof loaded)[number], deadlineMs: number) => {
        const end = Date.now() + deadlineMs;
        while (
          Date.now() < end &&
          target.isValid &&
          target.position.distanceTo(bot.entity.position) > 3 &&
          !signal.aborted
        ) {
          const p = target.position;
          await safeGoto(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 30_000, 12_000).catch(() => {});
          if (target.isValid && target.position.distanceTo(bot.entity.position) > 3)
            await new Promise((r) => setTimeout(r, 800));
        }
      };

      step(
        0.1,
        `Luring a ${best.a.name} pair (nearer ${best.a.position.distanceTo(bot.entity.position).toFixed(0)} away)...`,
      );
      await walkTo(best.a, 100_000);
      await equipFood();
      step(0.4, `Leading it to its mate (${best.a.position.distanceTo(best.b.position).toFixed(0)} apart)...`);
      await walkTo(best.b, 100_000);
      await equipFood();

      // Both should now be trailing within follow range. Give the first a moment
      // to close the gap, then feed the two nearest same-species adults.
      await new Promise((r) => setTimeout(r, 1500));
      const speciesName = best.a.name!;
      let fed = 0;
      for (let round = 0; round < 3 && fed < 2 && !signal.aborted; round++) {
        const nearby = Object.values(bot.entities)
          .filter((e) => e.name === speciesName && e.isValid && e.position.distanceTo(bot.entity.position) < 6)
          .sort((x, y) => x.position.distanceTo(bot.entity.position) - y.position.distanceTo(bot.entity.position));
        for (const animal of nearby) {
          if (fed >= 2) break;
          if (animal.position.distanceTo(bot.entity.position) > 4) {
            await safeGoto(
              bot,
              new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 2),
              12_000,
            ).catch(() => {});
          }
          if (!animal.isValid || animal.position.distanceTo(bot.entity.position) > 4) continue;
          if (!(await equipFood())) break;
          try {
            await bot.activateEntity(animal);
            fed++;
            step(0.6 + fed * 0.15, `Fed ${fed}/2 ${speciesName}s...`);
            await new Promise((r) => setTimeout(r, 600));
          } catch {
            /* moved or full — retry next round */
          }
        }
        if (fed < 2) await new Promise((r) => setTimeout(r, 1500));
      }

      if (fed >= 2) {
        await new Promise((r) => setTimeout(r, 2500));
        return {
          success: true,
          message: `Fed two ${speciesName}s ${best.food.replace("_", " ")} — they should breed (The Parrots and the Bats).`,
          stats: { fed },
        };
      }
      if (fed === 1) {
        return {
          success: false,
          message: resumable(`Fed one ${speciesName}; its mate drifted out of range before I could feed it.`),
        };
      }
    }

    return {
      success: false,
      message: resumable(
        "No two same-species animals I have food for are loaded nearby — explore toward a herd first.",
      ),
    };
  },
};
