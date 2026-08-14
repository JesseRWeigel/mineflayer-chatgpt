# Nether Breach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the swarm the fluid handling, obsidian acquisition, portal construction and ignition it needs to build a Nether portal, step through it, and come back — unlocking `story/lava_bucket`, `story/enter_the_nether`, `nether/root` and, when a diamond pickaxe is available, `story/form_obsidian`.

**Architecture:** Five first-class TypeScript skills under `src/skills/`, not generated ones. The pure decision layers — portal geometry, strategy selection, material accounting — live in separate modules with unit tests; the bot-driving layers call mineflayer directly and are proven by a live run. Obsidian acquisition has two interchangeable strategies behind one chooser, so the swarm is never blocked on diamonds but earns the advancement when it has them.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), mineflayer 4.34, mineflayer-pathfinder 2.4, `node:test` + `node:assert/strict` via `tsx`.

## Global Constraints

- Minecraft 1.21.4, Paper server, `level-name=ai-world`.
- The swarm is at **iron tier with 1 diamond mined**. Nothing in this plan may hard-require a diamond pickaxe.
- **Never do the bots' in-game work.** No RCON item grants, no `/give`, no placing blocks on their behalf. This plan ships capability; the bots acquire materials themselves. (Standing directive, 2026-07-22.)
- ESM TypeScript (`"type": "module"`); imports use `.js` extensions even for `.ts` sources.
- New test files carry a `// THE BUG THIS FILE EXISTS FOR.` header, or where the code is new capability rather than a bug fix, a `// WHAT THIS FILE PINS DOWN.` header explaining the failure it prevents.
- Run the full suite with `npm test`. It takes ~2 minutes and is **425/425** before this plan. Do not re-add `--test-force-exit`; it silently discards tests.
- Skills are registered in `src/skills/registry.ts` and must appear in a role's `allowedSkills` in `src/bot/role.ts` to be invokable.
- **A registered skill is a `Skill` OBJECT, not a bare function.** Copy the shape from `src/skills/smelt-ores.ts:46`:

```ts
export const someSkill: Skill = {
  name: "snake_case_name",
  description: "One sentence the LLM reads when choosing.",
  params: {},
  estimateMaterials(_bot, _params) { return {}; },
  async execute(bot, params, signal, onProgress): Promise<SkillResult> {
    return { success: true, message: "..." };
  },
};
```

  `SkillResult` is `{ success: boolean; message: string; stats?: Record<string, number> }`. **Set `success` truthfully** — it is the boolean `takeSkillOutcome()` threads to the brain, and it is what decides whether the skill gets blacklisted. A precondition (missing materials) is `success: false` with a message that does NOT begin `"<name> failed:"`, since that prefix marks a crash and always counts against the skill.
- Standard imports in this repo (from `src/skills/smelt-ores.ts:1-9`):

```ts
import type { Bot } from "mineflayer";
import type { Skill, SkillResult } from "./types.js";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
const { goals, Movements } = pkg;
import mcDataLoader from "minecraft-data";
import { baseMoves } from "../bot/navigation.js";
```

- **There is no `voyager-helpers.ts` or `voyager-bridge.ts`.** `placeItem`, `smeltItem` and friends are sandbox globals for GENERATED skills only and are not importable from TypeScript. Place blocks with `bot.placeBlock(refBlock, faceVector)` as `src/skills/build-bridge.ts:95` does; smelt by reusing the approach in `src/skills/smelt-ores.ts`.
- Verified mineflayer APIs available: `bot.activateItem()`, `bot.activateBlock(block)`, `bot.lookAt(vec3, force)`, `bot.equip(item, 'hand')`, `bot.placeBlock(ref, faceVec)`, `bot.dig(block)`, `bot.game.dimension`.
- Sandbox/Voyager helpers available to skills: `mineBlock`, `placeItem`, `craftItem`, `smeltItem`, `exploreUntil`, `killMob`.

## Domain facts verified against the 1.21.4 server jar (2026-08-14)

- `story/lava_bucket` — trigger `inventory_changed`, requires `minecraft:lava_bucket` **in inventory**.
- `story/form_obsidian` — trigger `inventory_changed`, requires `minecraft:obsidian` **in inventory**. Casting obsidian in place does NOT earn it; the bot must pick a block up, which needs a diamond pickaxe.
- `story/enter_the_nether` and `nether/root` — both trigger `changed_dimension` to `minecraft:the_nether`. Neither requires the obsidian advancement, because Minecraft advancement parents are a display tree, not a prerequisite graph.
- Minimum portal: 4 wide × 5 tall with corners omitted = **10 obsidian blocks**, interior 2 wide × 3 tall.
- Obsidian forms when water contacts a lava **source** block. Flowing lava becomes cobblestone instead, which is the most common way a cast silently fails.

---

### Task 1: Fluid primitives

**Files:**
- Create: `src/skills/fluid.ts`
- Test: `src/skills/fluid.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isSourceBlock(block: { name: string; metadata?: number } | null): boolean`
  - `pickApproach(botPos: Vec3Like, source: Vec3Like): Vec3Like | null` — an adjacent stand position that is not the fluid itself and not directly above it
  - `fillBucket(bot: Bot, fluid: "water" | "lava"): Promise<string>`
  - `emptyBucket(bot: Bot, at: Vec3Like): Promise<string>`
  - `type Vec3Like = { x: number; y: number; z: number }`

- [ ] **Step 1: Write the failing test**

```ts
// src/skills/fluid.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { isSourceBlock, pickApproach } from "./fluid.js";

// WHAT THIS FILE PINS DOWN.
//
// The swarm had zero fluid handling: no bucket, no lava, no obsidian, no
// ignition anywhere in src/. The one generated craftBucket.js imported
// `require('mineflayer-collectblock').mcData`, which is not a real export, and
// had never been attempted.
//
// Two things kill a cast silently and are worth pinning:
//
//   1. Only a SOURCE block makes obsidian. Water hitting FLOWING lava produces
//      cobblestone. In Minecraft a fluid block's metadata is 0 when it is a
//      source and non-zero when it is flowing, so a bot that ignores metadata
//      builds a cobblestone rectangle and never understands why.
//
//   2. Standing on or above the lava you are about to scoop is how a bot dies
//      holding the team's only iron bucket.

test("a source block is metadata 0", () => {
  assert.equal(isSourceBlock({ name: "lava", metadata: 0 }), true);
  assert.equal(isSourceBlock({ name: "water", metadata: 0 }), true);
});

test("flowing fluid is not a source and must never be scooped for a cast", () => {
  assert.equal(isSourceBlock({ name: "lava", metadata: 1 }), false);
  assert.equal(isSourceBlock({ name: "lava", metadata: 7 }), false);
});

test("a missing block is not a source", () => {
  assert.equal(isSourceBlock(null), false);
});

test("a non-fluid block is not a source however its metadata reads", () => {
  assert.equal(isSourceBlock({ name: "stone", metadata: 0 }), false);
});

test("the approach position is adjacent, level, and never the fluid itself", () => {
  const source = { x: 10, y: 40, z: 10 };
  const stand = pickApproach({ x: 14, y: 40, z: 10 }, source);
  assert.ok(stand, "an approach must be found for an open source");
  const dx = Math.abs(stand.x - source.x);
  const dz = Math.abs(stand.z - source.z);
  assert.equal(stand.y, source.y, "stand level with the source, not above it");
  assert.ok(dx + dz === 1, `must be orthogonally adjacent, got dx=${dx} dz=${dz}`);
});

test("the approach is the side nearest the bot so it does not cross the pool", () => {
  const source = { x: 0, y: 40, z: 0 };
  assert.deepEqual(pickApproach({ x: 9, y: 40, z: 0 }, source), { x: 1, y: 40, z: 0 });
  assert.deepEqual(pickApproach({ x: -9, y: 40, z: 0 }, source), { x: -1, y: 40, z: 0 });
  assert.deepEqual(pickApproach({ x: 0, y: 40, z: 9 }, source), { x: 0, y: 40, z: 1 });
});

test("a bot already standing on the source is moved off it, not left there", () => {
  const source = { x: 5, y: 40, z: 5 };
  const stand = pickApproach(source, source);
  assert.ok(stand);
  assert.notDeepEqual(stand, source);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/skills/fluid.test.ts`
Expected: FAIL — `Cannot find module './fluid.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/skills/fluid.ts
//
// Bucket handling. The swarm had none, which is why story/lava_bucket sat on
// the frontier untouched while it was the first rung of the only route to the
// Nether's 24 advancements.
//
// The geometry helpers are pure so they can be tested without a server; the
// bot-driving functions are thin wrappers over mineflayer and are proven by a
// live run.

import type { Bot } from "mineflayer";

export type Vec3Like = { x: number; y: number; z: number };

const FLUIDS = new Set(["water", "lava", "flowing_water", "flowing_lava"]);

/**
 * Source blocks have metadata 0; flowing fluid is 1-7 (and 8+ for falling).
 *
 * This matters more than it looks: water poured onto FLOWING lava makes
 * cobblestone, and onto a SOURCE makes obsidian. A caster that ignores this
 * builds a cobblestone rectangle and reports success.
 */
export function isSourceBlock(block: { name: string; metadata?: number } | null): boolean {
  if (!block || !FLUIDS.has(block.name)) return false;
  if (block.name.startsWith("flowing_")) return false;
  return (block.metadata ?? 0) === 0;
}

/**
 * A square to stand on while scooping: orthogonally adjacent, level with the
 * source, on the side the bot is already nearest.
 *
 * Never the source square itself and never directly above it — a bot that
 * approaches lava from on top falls in holding the team's only iron bucket.
 */
export function pickApproach(botPos: Vec3Like, source: Vec3Like): Vec3Like | null {
  const dx = botPos.x - source.x;
  const dz = botPos.z - source.z;
  // Favour the dominant axis so the bot does not walk around the pool.
  if (Math.abs(dx) >= Math.abs(dz)) {
    return { x: source.x + (dx >= 0 ? 1 : -1), y: source.y, z: source.z };
  }
  return { x: source.x, y: source.y, z: source.z + (dz >= 0 ? 1 : -1) };
}

/** Equip a bucket, face the fluid, and scoop. Returns a result sentence. */
export async function fillBucket(bot: Bot, fluid: "water" | "lava"): Promise<string> {
  const bucket = bot.inventory.items().find((i) => i.name === "bucket");
  if (!bucket) return `No empty bucket to fill with ${fluid}.`;

  const source = bot.findBlock({
    matching: (b) => isSourceBlock(b as unknown as { name: string; metadata?: number }) && b.name === fluid,
    maxDistance: 32,
  });
  if (!source) return `Cannot find a ${fluid} source within 32 blocks.`;

  const stand = pickApproach(bot.entity.position, source.position);
  if (stand) {
    const { goals, Movements } = await import("mineflayer-pathfinder");
    bot.pathfinder.setMovements(new Movements(bot));
    await bot.pathfinder.goto(new goals.GoalBlock(stand.x, stand.y, stand.z));
  }

  await bot.equip(bucket, "hand");
  await bot.lookAt(source.position.offset(0.5, 0.5, 0.5), true);
  bot.activateItem();
  await new Promise((r) => setTimeout(r, 500));

  const filled = bot.inventory.items().some((i) => i.name === `${fluid}_bucket`);
  return filled ? `Filled a bucket with ${fluid}.` : `Bucket did not fill from the ${fluid} source.`;
}

/** Pour a full bucket at a position. Returns a result sentence. */
export async function emptyBucket(bot: Bot, at: Vec3Like): Promise<string> {
  const full = bot.inventory.items().find((i) => i.name === "water_bucket" || i.name === "lava_bucket");
  if (!full) return "No full bucket to empty.";

  const target = bot.blockAt(new (await import("vec3")).Vec3(at.x, at.y - 1, at.z));
  if (!target) return `Nothing to pour against at ${at.x},${at.y},${at.z}.`;

  await bot.equip(full, "hand");
  await bot.lookAt(target.position.offset(0.5, 1.0, 0.5), true);
  bot.activateItem();
  await new Promise((r) => setTimeout(r, 500));

  const emptied = bot.inventory.items().some((i) => i.name === "bucket");
  return emptied ? `Poured ${full.name.replace("_bucket", "")} at ${at.x},${at.y},${at.z}.` : "Bucket did not empty.";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/skills/fluid.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/skills/fluid.ts src/skills/fluid.test.ts
git commit -m "Give the swarm hands for fluids"
```

---

### Task 2: Craft a bucket, properly

**Files:**
- Create: `src/skills/craft-bucket.ts`
- Test: `src/skills/craft-bucket.test.ts`
- Modify: `src/skills/registry.ts` (register `craft_bucket`)
- Delete: `skills/generated/craftBucket.js` and `skills/generated/craftBucket.js.bak.1`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `ironNeededFor(have: { iron_ingot?: number; raw_iron?: number }): { smelt: number; short: number }` — how many raw_iron to smelt and how many ingots the team is still short
  - `craftBucket(bot: Bot): Promise<string>` (the registered skill)

- [ ] **Step 1: Write the failing test**

```ts
// src/skills/craft-bucket.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { ironNeededFor } from "./craft-bucket.js";

// THE BUG THIS FILE EXISTS FOR.
//
// skills/generated/craftBucket.js opened with
//
//   const mcData = require('mineflayer-collectblock').mcData;
//
// which is not an export of that package, so mcData was undefined and the
// skill threw on its first line. It had never been attempted, and a bucket is
// the first rung of the only route to the Nether's 24 advancements.
//
// It also failed with "Cannot find crafting_table nearby" -- the same shape
// that let craftChest fail 85 times without ever retiring, because the crash
// text matched a precondition keyword.
//
// A bucket is 3 iron ingots. The arithmetic is pinned here so the skill can be
// asked "can I do this yet?" without touching a server.

test("three ingots in hand needs no smelting", () => {
  assert.deepEqual(ironNeededFor({ iron_ingot: 3 }), { smelt: 0, short: 0 });
});

test("raw iron is smelted to make up the difference", () => {
  assert.deepEqual(ironNeededFor({ iron_ingot: 1, raw_iron: 5 }), { smelt: 2, short: 0 });
});

test("not enough of either reports the shortfall rather than smelting blind", () => {
  assert.deepEqual(ironNeededFor({ iron_ingot: 0, raw_iron: 1 }), { smelt: 1, short: 2 });
});

test("an empty inventory is short the whole three", () => {
  assert.deepEqual(ironNeededFor({}), { smelt: 0, short: 3 });
});

test("surplus ingots are never smelted away", () => {
  assert.deepEqual(ironNeededFor({ iron_ingot: 9, raw_iron: 4 }), { smelt: 0, short: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/skills/craft-bucket.test.ts`
Expected: FAIL — `Cannot find module './craft-bucket.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/skills/craft-bucket.ts
//
// A bucket is 3 iron ingots and the first rung of the nether chain.
//
// This replaces skills/generated/craftBucket.js, which imported mcData from a
// package that does not export it and therefore threw on line one. Written as
// a first-class skill rather than a generated one because everything downstream
// -- lava, obsidian, the portal -- is blocked until it works.

import type { Bot } from "mineflayer";

const BUCKET_IRON = 3;

/**
 * Ledger for the bucket recipe: what to smelt, and what is still missing.
 *
 * Kept separate from the bot so the brain can ask "is this worth trying?"
 * without a server, and so the arithmetic is testable.
 */
export function ironNeededFor(have: { iron_ingot?: number; raw_iron?: number }): {
  smelt: number;
  short: number;
} {
  const ingots = have.iron_ingot ?? 0;
  const raw = have.raw_iron ?? 0;
  const deficit = Math.max(0, BUCKET_IRON - ingots);
  const smelt = Math.min(deficit, raw);
  return { smelt, short: deficit - smelt };
}

function counts(bot: Bot): { iron_ingot: number; raw_iron: number } {
  const tally = { iron_ingot: 0, raw_iron: 0 };
  for (const item of bot.inventory.items()) {
    if (item.name === "iron_ingot") tally.iron_ingot += item.count;
    if (item.name === "raw_iron") tally.raw_iron += item.count;
  }
  return tally;
}

export async function craftBucket(bot: Bot): Promise<string> {
  if (bot.inventory.items().some((i) => i.name === "bucket")) return "Already have a bucket.";

  const { smelt, short } = ironNeededFor(counts(bot));
  if (short > 0) {
    // A precondition, not a bug: say so in wording that does NOT start with
    // "<name> failed:", so the reliability layer treats it as an environment
    // problem rather than a crash.
    return `Need ${short} more iron for a bucket. Mine iron_ore, then smelt_ores.`;
  }

  if (smelt > 0) {
    // Do NOT smelt here. smelt_ores is an existing registered skill that already
    // builds a furnace, finds fuel, and reports precondition failures properly.
    // Duplicating it would give the swarm two smelting paths with different bugs.
    return `Have raw_iron but only ${BUCKET_IRON - smelt} ingots. Run smelt_ores first, then retry craft_bucket.`;
  }

  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  if (!table) return "No crafting_table within 32 blocks. Place one, then retry.";

  const mcData = (await import("minecraft-data")).default(bot.version);
  const recipe = bot.recipesFor(mcData.itemsByName.bucket.id, null, 1, table)[0];
  if (!recipe) return "No bucket recipe available with the materials on hand.";

  await bot.craft(recipe, 1, table);
  return bot.inventory.items().some((i) => i.name === "bucket")
    ? "Crafted a bucket."
    : "Bucket craft did not produce a bucket.";
}
```

Then wrap it as a `Skill` object exactly like `src/skills/smelt-ores.ts:46`, exporting `craftBucketSkill` with `name: "craft_bucket"`, and have `execute` return `{ success, message }` where `success` is `true` only when a bucket is actually in the inventory afterwards.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/skills/craft-bucket.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Register the skill and remove the broken generated one**

Read `src/skills/registry.ts` and follow its existing registration shape exactly. Then:

```bash
git rm skills/generated/craftBucket.js skills/generated/craftBucket.js.bak.1
```

Add `craft_bucket` to Forge's `allowedSkills` in `src/bot/role.ts` — Forge is the Miner/Smelter and is already routed to `story/lava_bucket` by `advancement-routing.ts`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — 425 before this plan, plus 7 (Task 1) plus 5 (Task 2) = 437.

- [ ] **Step 7: Commit**

```bash
git add src/skills/craft-bucket.ts src/skills/craft-bucket.test.ts src/skills/registry.ts src/bot/role.ts
git commit -m "Replace a bucket skill that threw on its first line"
```

---

### Task 3: Portal geometry

**Files:**
- Create: `src/skills/portal-geometry.ts`
- Test: `src/skills/portal-geometry.test.ts`

**Interfaces:**
- Consumes: `Vec3Like` from Task 1.
- Produces:
  - `framePositions(origin: Vec3Like, axis: "x" | "z"): Vec3Like[]` — the 10 obsidian positions, corners omitted
  - `interiorPositions(origin: Vec3Like, axis: "x" | "z"): Vec3Like[]` — the 6 air positions the portal fills
  - `ignitionTarget(origin: Vec3Like, axis: "x" | "z"): Vec3Like` — the block to strike with flint and steel
  - `PORTAL_OBSIDIAN = 10`

`origin` is the bottom-left **interior** block. For axis `"x"` the portal's width runs along x; for `"z"` along z.

- [ ] **Step 1: Write the failing test**

```ts
// src/skills/portal-geometry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { framePositions, interiorPositions, ignitionTarget, PORTAL_OBSIDIAN } from "./portal-geometry.js";

// WHAT THIS FILE PINS DOWN.
//
// A Nether portal is 4 wide by 5 tall with the four corners optional, so the
// cheapest legal frame is 10 obsidian around a 2x3 interior. Getting this wrong
// costs the swarm 10 round trips to a lava pool per attempt, which at iron tier
// with one bucket is the most expensive mistake available to it.
//
// Corners are deliberately excluded: including them would make the frame 14
// blocks, a 40% increase in casting trips for no gameplay benefit.

const origin = { x: 100, y: 64, z: 200 };

test("the cheapest legal frame is ten blocks", () => {
  assert.equal(PORTAL_OBSIDIAN, 10);
  assert.equal(framePositions(origin, "x").length, 10);
  assert.equal(framePositions(origin, "z").length, 10);
});

test("the interior is two wide and three tall", () => {
  const inner = interiorPositions(origin, "x");
  assert.equal(inner.length, 6);
  assert.equal(new Set(inner.map((p) => p.y)).size, 3, "three distinct heights");
});

test("no corner is included in the frame", () => {
  const frame = framePositions(origin, "x");
  // Corners sit diagonally out from the interior at both bottom and top.
  for (const corner of [
    { x: origin.x - 1, y: origin.y - 1, z: origin.z },
    { x: origin.x + 2, y: origin.y - 1, z: origin.z },
    { x: origin.x - 1, y: origin.y + 3, z: origin.z },
    { x: origin.x + 2, y: origin.y + 3, z: origin.z },
  ]) {
    assert.ok(
      !frame.some((p) => p.x === corner.x && p.y === corner.y && p.z === corner.z),
      `corner ${JSON.stringify(corner)} must not be in the frame`,
    );
  }
});

test("frame and interior never overlap", () => {
  const frame = framePositions(origin, "x").map((p) => `${p.x},${p.y},${p.z}`);
  const inner = interiorPositions(origin, "x").map((p) => `${p.x},${p.y},${p.z}`);
  assert.equal(frame.filter((p) => inner.includes(p)).length, 0);
});

test("the frame is a closed ring around the interior", () => {
  const frame = framePositions(origin, "x");
  const inner = interiorPositions(origin, "x");
  // Every interior block has all four orthogonal neighbours either interior or frame.
  const known = new Set([...frame, ...inner].map((p) => `${p.x},${p.y},${p.z}`));
  for (const p of inner) {
    for (const d of [
      { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
    ]) {
      assert.ok(
        known.has(`${p.x + d.x},${p.y + d.y},${p.z}`),
        `interior ${p.x},${p.y} has an open side at ${d.x},${d.y}`,
      );
    }
  }
});

test("the z-axis portal is the x-axis portal rotated, not translated", () => {
  const fx = framePositions(origin, "x");
  const fz = framePositions(origin, "z");
  assert.equal(new Set(fx.map((p) => p.x)).size, 4, "x-axis portal varies in x");
  assert.equal(new Set(fz.map((p) => p.z)).size, 4, "z-axis portal varies in z");
  assert.equal(new Set(fz.map((p) => p.x)).size, 1, "z-axis portal is flat in x");
});

test("ignition targets a block inside the frame, at the bottom", () => {
  const t = ignitionTarget(origin, "x");
  assert.equal(t.y, origin.y, "strike the bottom row of the interior");
  const inner = interiorPositions(origin, "x");
  assert.ok(inner.some((p) => p.x === t.x && p.y === t.y && p.z === t.z));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/skills/portal-geometry.test.ts`
Expected: FAIL — `Cannot find module './portal-geometry.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/skills/portal-geometry.ts
//
// Where the obsidian goes.
//
// Pure arithmetic, deliberately separated from the skill that places blocks:
// each obsidian block costs a round trip to a lava pool, so an off-by-one here
// is the most expensive class of bug available to a bot at iron tier.
//
// `origin` is the bottom-left INTERIOR block. Corners are omitted, which is
// legal and makes the frame 10 blocks instead of 14.

import type { Vec3Like } from "./fluid.js";

export const PORTAL_OBSIDIAN = 10;

const WIDTH = 2; // interior
const HEIGHT = 3; // interior

/** Offset helper: `w` runs along the portal's width axis, `h` is vertical. */
function at(origin: Vec3Like, axis: "x" | "z", w: number, h: number): Vec3Like {
  return axis === "x"
    ? { x: origin.x + w, y: origin.y + h, z: origin.z }
    : { x: origin.x, y: origin.y + h, z: origin.z + w };
}

export function interiorPositions(origin: Vec3Like, axis: "x" | "z"): Vec3Like[] {
  const out: Vec3Like[] = [];
  for (let h = 0; h < HEIGHT; h++) for (let w = 0; w < WIDTH; w++) out.push(at(origin, axis, w, h));
  return out;
}

export function framePositions(origin: Vec3Like, axis: "x" | "z"): Vec3Like[] {
  const out: Vec3Like[] = [];
  for (let w = 0; w < WIDTH; w++) {
    out.push(at(origin, axis, w, -1)); // floor
    out.push(at(origin, axis, w, HEIGHT)); // lintel
  }
  for (let h = 0; h < HEIGHT; h++) {
    out.push(at(origin, axis, -1, h)); // left jamb
    out.push(at(origin, axis, WIDTH, h)); // right jamb
  }
  return out;
}

/** Flint and steel is struck on the bottom-left interior square. */
export function ignitionTarget(origin: Vec3Like, axis: "x" | "z"): Vec3Like {
  return at(origin, axis, 0, 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/skills/portal-geometry.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/skills/portal-geometry.ts src/skills/portal-geometry.test.ts
git commit -m "Pin down where the ten obsidian blocks go"
```

---

### Task 4: Two ways to get obsidian, and choosing between them

**Files:**
- Create: `src/skills/obsidian.ts`
- Test: `src/skills/obsidian.test.ts`

**Interfaces:**
- Consumes: `isSourceBlock`, `Vec3Like` (Task 1); `framePositions` (Task 3); `pickaxeTier` from `src/bot/tool-tier.js`.
- Produces:
  - `chooseStrategy(inventoryNames: string[]): "mine" | "cast"` — `"mine"` only when a diamond or netherite pickaxe is held
  - `castInPlace(bot: Bot, positions: Vec3Like[]): Promise<string>`
  - `mineObsidian(bot: Bot, count: number): Promise<string>`
  - `acquireObsidian(bot: Bot, positions: Vec3Like[]): Promise<string>` — dispatches on `chooseStrategy`

- [ ] **Step 1: Write the failing test**

```ts
// src/skills/obsidian.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { chooseStrategy } from "./obsidian.js";

// WHAT THIS FILE PINS DOWN.
//
// Obsidian needs a diamond pickaxe to MINE, but not to MAKE: water poured on a
// lava source turns it to obsidian where it stands. The swarm is at iron tier
// with one diamond, so a plan that required a diamond pickaxe would have
// blocked the whole nether push behind a diamond hunt of unknown length.
//
// Both routes exist and the bot picks. The distinction is not cosmetic:
//
//   cast -> reaches the Nether, unlocks its 24 advancements, but never puts
//           obsidian in the inventory, so story/form_obsidian stays unearned
//           (its trigger is inventory_changed on minecraft:obsidian).
//   mine -> also earns story/form_obsidian.
//
// Getting the tier test wrong in the optimistic direction is expensive: a bot
// that believes an iron pickaxe can mine obsidian digs for 250 seconds and
// drops nothing.

test("a diamond pickaxe means mine", () => {
  assert.equal(chooseStrategy(["diamond_pickaxe", "bucket"]), "mine");
});

test("netherite also mines", () => {
  assert.equal(chooseStrategy(["netherite_pickaxe"]), "mine");
});

test("iron is not good enough and must cast instead", () => {
  // The expensive mistake: iron digs obsidian for 250s and drops nothing.
  assert.equal(chooseStrategy(["iron_pickaxe", "bucket"]), "cast");
});

test("stone, wood and gold all cast", () => {
  assert.equal(chooseStrategy(["stone_pickaxe"]), "cast");
  assert.equal(chooseStrategy(["wooden_pickaxe"]), "cast");
  assert.equal(chooseStrategy(["golden_pickaxe"]), "cast");
});

test("no pickaxe at all still casts rather than refusing", () => {
  assert.equal(chooseStrategy([]), "cast");
});

test("the best pickaxe decides, not the first one found", () => {
  assert.equal(chooseStrategy(["wooden_pickaxe", "diamond_pickaxe"]), "mine");
  assert.equal(chooseStrategy(["diamond_pickaxe", "wooden_pickaxe"]), "mine");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/skills/obsidian.test.ts`
Expected: FAIL — `Cannot find module './obsidian.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/skills/obsidian.ts
//
// Two routes to a portal frame.
//
// Casting needs no diamond: water on a lava SOURCE makes obsidian in place.
// Mining needs a diamond pickaxe but is the only route that puts obsidian in
// the inventory, which is what story/form_obsidian actually triggers on.
//
// The swarm is at iron tier with one diamond, so casting is the route that
// works today and mining is the upgrade.

import type { Bot } from "mineflayer";
import { pickaxeTier } from "../bot/tool-tier.js";
import { isSourceBlock, fillBucket, emptyBucket, type Vec3Like } from "./fluid.js";

const DIAMOND_TIER = 3;

export function chooseStrategy(inventoryNames: string[]): "mine" | "cast" {
  const best = inventoryNames.reduce((acc, n) => Math.max(acc, pickaxeTier(n) ?? -1), -1);
  return best >= DIAMOND_TIER ? "mine" : "cast";
}

/**
 * Cast obsidian at each position: lava first, then water over it.
 *
 * One block per round trip, because a bucket holds one fluid. Ten trips for a
 * frame. Slow, and the only route available at iron tier.
 */
export async function castInPlace(bot: Bot, positions: Vec3Like[]): Promise<string> {
  const { Vec3 } = await import("vec3");
  let cast = 0;
  for (const pos of positions) {
    const existing = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (existing?.name === "obsidian") {
      cast++;
      continue;
    }

    const lava = await fillBucket(bot, "lava");
    if (!lava.startsWith("Filled")) return `Cast stopped after ${cast}/${positions.length}: ${lava}`;
    await emptyBucket(bot, pos);

    const water = await fillBucket(bot, "water");
    if (!water.startsWith("Filled")) return `Cast stopped after ${cast}/${positions.length}: ${water}`;
    await emptyBucket(bot, { x: pos.x, y: pos.y + 1, z: pos.z });

    await new Promise((r) => setTimeout(r, 400));
    const now = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (now?.name === "obsidian") cast++;

    // Reclaim the water so the next block does not need a fresh source.
    const spill = bot.findBlock({
      matching: (b) => b.name === "water" && isSourceBlock(b as unknown as { name: string; metadata?: number }),
      maxDistance: 4,
    });
    if (spill) await fillBucket(bot, "water");
  }
  return cast === positions.length
    ? `Cast ${cast} obsidian in place.`
    : `Cast ${cast} of ${positions.length} obsidian; the rest did not convert.`;
}

/** Mine existing obsidian. Requires a diamond pickaxe; earns story/form_obsidian. */
export async function mineObsidian(bot: Bot, count: number): Promise<string> {
  const pick = bot.inventory.items().find((i) => (pickaxeTier(i.name) ?? -1) >= DIAMOND_TIER);
  if (!pick) return "Need a diamond pickaxe to mine obsidian.";
  await bot.equip(pick, "hand");

  let mined = 0;
  for (let i = 0; i < count; i++) {
    const block = bot.findBlock({ matching: (b) => b.name === "obsidian", maxDistance: 32 });
    if (!block) break;
    await bot.dig(block);
    mined++;
  }
  return mined > 0 ? `Mined ${mined} obsidian.` : "Cannot find obsidian within 32 blocks.";
}

export async function acquireObsidian(bot: Bot, positions: Vec3Like[]): Promise<string> {
  const names = bot.inventory.items().map((i) => i.name);
  if (chooseStrategy(names) === "mine") {
    const held = bot.inventory.items().filter((i) => i.name === "obsidian").reduce((n, i) => n + i.count, 0);
    if (held >= positions.length) return `Already holding ${held} obsidian.`;
    const res = await mineObsidian(bot, positions.length - held);
    // Mining can come up short if no obsidian is nearby; fall back rather than stall.
    if (res.startsWith("Mined")) return res;
  }
  return castInPlace(bot, positions);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/skills/obsidian.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/skills/obsidian.ts src/skills/obsidian.test.ts
git commit -m "Two routes to obsidian so diamonds cannot block the Nether"
```

---

### Task 5: Flint and steel

**Files:**
- Create: `src/skills/flint-and-steel.ts`
- Test: `src/skills/flint-and-steel.test.ts`
- Modify: `src/skills/registry.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `igniterPlan(names: { flint?: number; gravel?: number; iron_ingot?: number; flint_and_steel?: number }): { have: boolean; needGravel: number; needIron: number }`
  - `craftFlintAndSteel(bot: Bot): Promise<string>` (registered as `craft_flint_and_steel`)

- [ ] **Step 1: Write the failing test**

```ts
// src/skills/flint-and-steel.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { igniterPlan } from "./flint-and-steel.js";

// WHAT THIS FILE PINS DOWN.
//
// A portal frame with nothing to light it is ten wasted round trips to a lava
// pool. Flint and steel is 1 flint + 1 iron ingot, and flint only drops from
// gravel -- at 10%, so the expected cost is about 10 gravel per flint. A bot
// that goes looking for gravel with an exact-count plan gives up too early.
//
// The team already keeps flint_and_steel in the stash keep-list
// (src/skills/stash.ts), so having one is the common case and must short-circuit.

test("already holding one needs nothing", () => {
  assert.deepEqual(igniterPlan({ flint_and_steel: 1 }), { have: true, needGravel: 0, needIron: 0 });
});

test("flint plus iron needs no gravel", () => {
  assert.deepEqual(igniterPlan({ flint: 1, iron_ingot: 1 }), { have: false, needGravel: 0, needIron: 0 });
});

test("no flint budgets ten gravel for a ten percent drop", () => {
  assert.deepEqual(igniterPlan({ iron_ingot: 1 }), { have: false, needGravel: 10, needIron: 0 });
});

test("gravel on hand counts against the budget", () => {
  assert.deepEqual(igniterPlan({ gravel: 4, iron_ingot: 1 }), { have: false, needGravel: 6, needIron: 0 });
});

test("missing iron is reported alongside missing flint", () => {
  assert.deepEqual(igniterPlan({}), { have: false, needGravel: 10, needIron: 1 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/skills/flint-and-steel.test.ts`
Expected: FAIL — `Cannot find module './flint-and-steel.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/skills/flint-and-steel.ts
//
// Something to light the portal with.
//
// 1 flint + 1 iron ingot. Flint drops from gravel at roughly 10%, so the plan
// budgets ten gravel per flint rather than one -- a bot with an exact-count
// plan gives up after the first gravel block fails to drop.

import type { Bot } from "mineflayer";

/** Gravel blocks to break per flint wanted, at a ~10% drop rate. */
const GRAVEL_PER_FLINT = 10;

export function igniterPlan(have: {
  flint?: number;
  gravel?: number;
  iron_ingot?: number;
  flint_and_steel?: number;
}): { have: boolean; needGravel: number; needIron: number } {
  if ((have.flint_and_steel ?? 0) > 0) return { have: true, needGravel: 0, needIron: 0 };
  const needIron = Math.max(0, 1 - (have.iron_ingot ?? 0));
  if ((have.flint ?? 0) > 0) return { have: false, needGravel: 0, needIron };
  const needGravel = Math.max(0, GRAVEL_PER_FLINT - (have.gravel ?? 0));
  return { have: false, needGravel, needIron };
}

function tally(bot: Bot): Record<string, number> {
  const t: Record<string, number> = {};
  for (const i of bot.inventory.items()) t[i.name] = (t[i.name] ?? 0) + i.count;
  return t;
}

export async function craftFlintAndSteel(bot: Bot): Promise<string> {
  const t = tally(bot);
  const plan = igniterPlan(t);
  if (plan.have) return "Already have flint_and_steel.";
  if (plan.needIron > 0) return `Need ${plan.needIron} iron_ingot for flint_and_steel. Smelt raw_iron first.`;
  if (plan.needGravel > 0) return `Need about ${plan.needGravel} more gravel to get flint. Mine gravel, then retry.`;

  const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 32 });
  const mcData = (await import("minecraft-data")).default(bot.version);
  const recipe = bot.recipesFor(mcData.itemsByName.flint_and_steel.id, null, 1, table ?? null)[0];
  if (!recipe) return "No flint_and_steel recipe available with the materials on hand.";

  await bot.craft(recipe, 1, table ?? undefined);
  return bot.inventory.items().some((i) => i.name === "flint_and_steel")
    ? "Crafted flint_and_steel."
    : "flint_and_steel craft did not produce one.";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/skills/flint-and-steel.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Register and commit**

Register `craft_flint_and_steel` in `src/skills/registry.ts` following its existing shape, and add it to Forge's `allowedSkills` in `src/bot/role.ts`.

```bash
git add src/skills/flint-and-steel.ts src/skills/flint-and-steel.test.ts src/skills/registry.ts src/bot/role.ts
git commit -m "Give the swarm something to light the portal with"
```

---

### Task 6: Build it, step through, come back

**Files:**
- Create: `src/skills/nether-portal.ts`
- Test: `src/skills/nether-portal.test.ts`
- Modify: `src/skills/registry.ts`, `src/bot/role.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces:
  - `readinessOf(names: string[]): { ready: boolean; missing: string[] }` — what the bot still lacks before a portal attempt is worth starting
  - `recordPortal(bot: Bot, origin: Vec3Like, axis: "x" | "z"): void` and `lastPortal(botName: string): { origin: Vec3Like; axis: "x" | "z" } | undefined`
  - `buildNetherPortal(bot: Bot): Promise<string>` (registered `build_nether_portal`)
  - `returnThroughPortal(bot: Bot): Promise<string>` (registered `return_from_nether`)

- [ ] **Step 1: Write the failing test**

```ts
// src/skills/nether-portal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { readinessOf, recordPortal, lastPortal } from "./nether-portal.js";

// WHAT THIS FILE PINS DOWN.
//
// Two ways this ends badly, both pinned here:
//
//   1. Starting a portal attempt without an igniter. Ten round trips to a lava
//      pool, a finished frame, and nothing to light it with.
//
//   2. Stepping through and not being able to get home. The return portal is at
//      the coordinates the bot ARRIVED at, which are not the coordinates it
//      left from -- the Nether is 8:1, so a bot that walks away and tries to
//      navigate back by overworld coordinates is lost. Record on the way in.

test("a bot with bucket and igniter is ready", () => {
  assert.deepEqual(readinessOf(["bucket", "flint_and_steel"]), { ready: true, missing: [] });
});

test("no igniter is not ready, however much obsidian is held", () => {
  const r = readinessOf(["bucket", "obsidian", "obsidian", "obsidian"]);
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes("flint_and_steel"));
});

test("a full bucket counts as a bucket", () => {
  assert.equal(readinessOf(["lava_bucket", "flint_and_steel"]).ready, true);
  assert.equal(readinessOf(["water_bucket", "flint_and_steel"]).ready, true);
});

test("an empty inventory reports everything that is missing at once", () => {
  const r = readinessOf([]);
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing.sort(), ["bucket", "flint_and_steel"]);
});

test("a recorded portal is recoverable by bot name", () => {
  const bot = { username: "Forge" } as never;
  recordPortal(bot, { x: 10, y: 64, z: -20 }, "x");
  assert.deepEqual(lastPortal("Forge"), { origin: { x: 10, y: 64, z: -20 }, axis: "x" });
});

test("one bot's portal is not another's", () => {
  const forge = { username: "Forge" } as never;
  const atlas = { username: "Atlas" } as never;
  recordPortal(forge, { x: 1, y: 64, z: 1 }, "x");
  recordPortal(atlas, { x: 900, y: 30, z: 900 }, "z");
  assert.deepEqual(lastPortal("Forge")?.origin, { x: 1, y: 64, z: 1 });
  assert.equal(lastPortal("Atlas")?.axis, "z");
});

test("an unknown bot has no portal rather than a bogus one", () => {
  assert.equal(lastPortal("NeverBuilt"), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/skills/nether-portal.test.ts`
Expected: FAIL — `Cannot find module './nether-portal.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/skills/nether-portal.ts
//
// Build the frame, light it, step through, and be able to come home.
//
// The return trip is not decoration. The Nether is 8:1, so a bot that walks
// away from its arrival portal cannot navigate back by overworld coordinates,
// and it is carrying the iron the whole plan was spent acquiring.

import type { Bot } from "mineflayer";
import { framePositions, interiorPositions, ignitionTarget } from "./portal-geometry.js";
import { acquireObsidian } from "./obsidian.js";
import type { Vec3Like } from "./fluid.js";

const REQUIRED = ["bucket", "flint_and_steel"] as const;

export function readinessOf(names: string[]): { ready: boolean; missing: string[] } {
  const has = (want: string) =>
    want === "bucket"
      ? names.some((n) => n === "bucket" || n === "water_bucket" || n === "lava_bucket")
      : names.includes(want);
  const missing = REQUIRED.filter((r) => !has(r));
  return { ready: missing.length === 0, missing: [...missing] };
}

/** Where each bot's portal is, so it can find its way back. */
const portals = new Map<string, { origin: Vec3Like; axis: "x" | "z" }>();

export function recordPortal(bot: Bot, origin: Vec3Like, axis: "x" | "z"): void {
  portals.set(bot.username, { origin, axis });
}

export function lastPortal(botName: string): { origin: Vec3Like; axis: "x" | "z" } | undefined {
  return portals.get(botName);
}

export async function buildNetherPortal(bot: Bot): Promise<string> {
  const names = bot.inventory.items().map((i) => i.name);
  const { ready, missing } = readinessOf(names);
  if (!ready) return `Not ready for a portal: missing ${missing.join(", ")}. Craft those first.`;

  const { Vec3 } = await import("vec3");
  const p = bot.entity.position;
  // Build one block clear of the bot so it never entombs itself in the frame.
  const origin: Vec3Like = { x: Math.floor(p.x) + 2, y: Math.floor(p.y), z: Math.floor(p.z) };
  const axis: "x" | "z" = "x";

  const frame = framePositions(origin, axis);
  const got = await acquireObsidian(bot, frame);
  if (!got.startsWith("Cast") && !got.startsWith("Mined") && !got.startsWith("Already")) {
    return `Portal stalled getting obsidian: ${got}`;
  }

  // Placed-block route: if obsidian is in inventory, set the frame by hand.
  // bot.placeBlock needs a REFERENCE block and the face vector to build off,
  // not a target coordinate — see src/skills/build-bridge.ts:95.
  const held = bot.inventory.items().find((i) => i.name === "obsidian");
  if (held) {
    await bot.equip(held, "hand");
    for (const pos of frame) {
      const target = new Vec3(pos.x, pos.y, pos.z);
      if (bot.blockAt(target)?.name === "obsidian") continue;
      const below = bot.blockAt(target.offset(0, -1, 0));
      if (!below || below.name === "air") continue; // nothing to build off yet
      await bot.placeBlock(below, new Vec3(0, 1, 0)).catch(() => {});
    }
  }

  // Clear the interior so the portal has room to form.
  for (const pos of interiorPositions(origin, axis)) {
    const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (b && b.name !== "air" && b.name !== "nether_portal") await bot.dig(b).catch(() => {});
  }

  const igniter = bot.inventory.items().find((i) => i.name === "flint_and_steel");
  if (!igniter) return "Frame built but no flint_and_steel to light it.";
  await bot.equip(igniter, "hand");

  const t = ignitionTarget(origin, axis);
  const below = bot.blockAt(new Vec3(t.x, t.y - 1, t.z));
  if (below) await bot.activateBlock(below).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));

  const lit = interiorPositions(origin, axis).some(
    (pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name === "nether_portal",
  );
  if (!lit) return "Frame built but the portal did not light. Check the frame is complete.";

  recordPortal(bot, origin, axis);
  return `Portal built and lit at ${origin.x},${origin.y},${origin.z}.`;
}

export async function returnThroughPortal(bot: Bot): Promise<string> {
  if (bot.game.dimension !== "the_nether" && bot.game.dimension !== "minecraft:the_nether") {
    return "Not in the Nether — nothing to return from.";
  }
  const portal = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 64 });
  if (!portal) return "Cannot find a nether_portal within 64 blocks.";

  const { goals, Movements } = await import("mineflayer-pathfinder");
  bot.pathfinder.setMovements(new Movements(bot));
  await bot.pathfinder.goto(new goals.GoalBlock(portal.position.x, portal.position.y, portal.position.z));

  // Standing in the portal is what triggers the transition; give it time.
  await new Promise((r) => setTimeout(r, 6000));
  const home = bot.game.dimension === "overworld" || bot.game.dimension === "minecraft:overworld";
  return home ? "Returned to the overworld." : "Stood in the portal but did not transition.";
}
```

Then wrap both entry points as `Skill` objects like `src/skills/smelt-ores.ts:46` — `buildNetherPortalSkill` (`name: "build_nether_portal"`) and `returnFromNetherSkill` (`name: "return_from_nether"`) — each returning `{ success, message }` with `success` true only when the portal is confirmed lit, or the bot is confirmed back in the overworld.

Frame ordering matters: `bot.placeBlock` needs something solid to build against, so place the floor row first, then the jambs bottom-up, then the lintel. The loop above skips positions with nothing below; run it twice so the second pass catches what the first could not reach.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/skills/nether-portal.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Register both skills**

Register `build_nether_portal` and `return_from_nether` in `src/skills/registry.ts`, and add both to Forge's `allowedSkills` in `src/bot/role.ts`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — 425 + 7 + 5 + 7 + 6 + 5 + 7 = **462**.

- [ ] **Step 7: Commit**

```bash
git add src/skills/nether-portal.ts src/skills/nether-portal.test.ts src/skills/registry.ts src/bot/role.ts
git commit -m "Build the portal, step through, and be able to come home"
```

---

## What this plan does not do

- **Nether survival.** Ghasts, piglins, lava oceans and the 8:1 coordinate ratio are all out of scope. The bots will probably die in there. `story/enter_the_nether` and `nether/root` are awarded on arrival, so both are banked before anything can kill them, and `returnThroughPortal` gives them a chance at the gear.
- **The other 22 nether advancements.** They need survival first; that is the follow-on plan.
- **Difficulty-aware routing.** `descendantCount` currently ranks `adventure/minecraft_trials_edition` above `story/lava_bucket`, so Atlas and Blade are sent to a Trial Chamber under-geared. Tracked in the SDD ledger, unaddressed here.

## Live verification, after the tasks

The unit tests cover geometry and decisions. The bot-driving code is only proven by running it, so after Task 6:

1. Restart the swarm and watch `logs/advancement-progress.csv` for the story column moving 8 → 9 (`lava_bucket`).
2. Confirm `craft_bucket` appears in Forge's skill menu and gets invoked.
3. Watch for `Cast N of 10 obsidian` in the log — a partial cast means water is hitting flowing lava rather than a source, which is the failure `isSourceBlock` exists to prevent.
4. The finish line is a CSV row with a non-zero nether column.
