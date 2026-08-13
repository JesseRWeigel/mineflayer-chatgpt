# Advancement Curriculum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-written tech ladder that dead-ends at diamonds with the game's own 122-advancement dependency tree, so the swarm always has a next goal and its progress is measured by the server rather than self-reported.

**Architecture:** A build-time extractor pulls the advancement tree out of the bundled vanilla server jar into a checked-in JSON file. Three small runtime modules sit on top: a pure tree/frontier calculator, an impure reader for the server's per-player progress files, and a pure role-affinity router. The strategic context gains one line naming the bot's next advancement. A CSV snapshot appended each run turns "improves over time" into a plottable series.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict` via `tsx`, Node `node:zlib`/`adm-zip`-free jar reading via `unzip` at build time only.

## Global Constraints

- Minecraft/Paper version is **1.21.4**. The vanilla jar lives at `server/cache/mojang_1.21.4.jar` and nests the real server jar at `META-INF/versions/1.21.4/server-1.21.4.jar`.
- Server `level-name=ai-world`, so progress files are at `server/ai-world/advancements/<uuid>.json`. Read the level name from `server/server.properties`; do not hardcode `world`.
- Server runs `online-mode=false`. Player UUIDs are offline UUIDs: MD5 of the UTF-8 bytes of `OfflinePlayer:<name>`, with byte 6 masked to version 3 (`(b&0x0f)|0x30`) and byte 8 to the RFC variant (`(b&0x3f)|0x80`). Verified against all five bots on 2026-08-13.
- Advancement IDs in progress files are namespaced (`minecraft:story/root`); IDs in the extracted tree are bare (`story/root`). Normalise by stripping a leading `minecraft:`.
- Entries under `minecraft:recipes/**` are recipe unlocks, not advancements. Exclude them everywhere. There are exactly **122** real advancements: 44 adventure, 29 husbandry, 24 nether, 16 story, 9 end.
- All new modules follow the repo convention of a `// THE BUG THIS FILE EXISTS FOR.` header comment in the test file explaining the measured failure that motivated the code.
- Imports use `.js` extensions even for `.ts` sources (ESM + `moduleResolution`).
- Run tests with `npm test`. Run a single file with `node --import tsx --test src/bot/<file>.test.ts`.

---

### Task 1: Extract the advancement tree from the server jar

**Files:**
- Create: `tools/extract-advancements.ts`
- Create: `src/data/advancement-tree.json` (generated output, committed)
- Test: `src/bot/advancement-tree.test.ts` (asserts on the generated data)

**Interfaces:**
- Consumes: nothing.
- Produces: `src/data/advancement-tree.json`, an array of
  `{ id: string; parent: string | null; title: string; description: string; category: string }`
  where `id` is bare (`"story/enter_the_nether"`), `parent` is bare or `null` for the five roots,
  and `category` is the first path segment (`"story" | "nether" | "end" | "adventure" | "husbandry"`).

- [ ] **Step 1: Write the extractor**

```ts
// tools/extract-advancements.ts
//
// The advancement tree is the curriculum. It is extracted at build time rather
// than read at runtime because the runtime has no business unzipping a 18MB jar
// on every decision, and because a checked-in file makes the tree diffable when
// the server version changes.
//
// Usage: npx tsx tools/extract-advancements.ts

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const NESTED = "META-INF/versions/1.21.4/server-1.21.4.jar";
const OUTER = path.resolve("server/cache/mojang_1.21.4.jar");
const TMP = path.resolve(".advancement-extract");

export interface AdvancementNode {
  id: string;
  parent: string | null;
  title: string;
  description: string;
  category: string;
}

function bare(id: string): string {
  return id.replace(/^minecraft:/, "");
}

function main(): void {
  mkdirSync(TMP, { recursive: true });
  execFileSync("unzip", ["-o", "-q", OUTER, NESTED, "-d", TMP]);
  const inner = path.join(TMP, NESTED);

  const listing = execFileSync("unzip", ["-Z1", inner], { encoding: "utf-8" });
  const paths = listing
    .split("\n")
    .filter((p) => p.startsWith("data/minecraft/advancement/") && p.endsWith(".json"))
    .filter((p) => !p.includes("/recipes/"));

  const lang = JSON.parse(
    execFileSync("unzip", ["-p", inner, "assets/minecraft/lang/en_us.json"], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as Record<string, string>;

  const nodes: AdvancementNode[] = paths.map((p) => {
    const raw = JSON.parse(execFileSync("unzip", ["-p", inner, p], { encoding: "utf-8" }));
    const id = p.replace("data/minecraft/advancement/", "").replace(/\.json$/, "");
    const display = raw.display ?? {};
    return {
      id,
      parent: raw.parent ? bare(raw.parent) : null,
      title: lang[display.title?.translate] ?? id,
      description: lang[display.description?.translate] ?? "",
      category: id.split("/")[0],
    };
  });

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  mkdirSync(path.resolve("src/data"), { recursive: true });
  writeFileSync(path.resolve("src/data/advancement-tree.json"), JSON.stringify(nodes, null, 2) + "\n");
  console.log(`Wrote ${nodes.length} advancements to src/data/advancement-tree.json`);
}

main();
```

- [ ] **Step 2: Run the extractor**

Run: `npx tsx tools/extract-advancements.ts`
Expected: `Wrote 122 advancements to src/data/advancement-tree.json`

- [ ] **Step 3: Verify the shape by hand**

Run: `node -e "const a=require('./src/data/advancement-tree.json');const n=a.find(x=>x.id==='story/enter_the_nether');console.log(n)"`
Expected:
```
{
  id: 'story/enter_the_nether',
  parent: 'story/form_obsidian',
  title: 'We Need to Go Deeper',
  description: 'Build, light and enter a Nether Portal',
  category: 'story'
}
```

- [ ] **Step 4: Clean up the temp dir and commit**

```bash
rm -rf .advancement-extract
echo ".advancement-extract/" >> .gitignore
git add tools/extract-advancements.ts src/data/advancement-tree.json .gitignore
git commit -m "Extract the 122-advancement tree from the 1.21.4 server jar"
```

---

### Task 2: Tree loading and frontier computation

**Files:**
- Create: `src/bot/advancement-tree.ts`
- Test: `src/bot/advancement-tree.test.ts`

**Interfaces:**
- Consumes: `src/data/advancement-tree.json` from Task 1.
- Produces:
  - `ALL_ADVANCEMENTS: AdvancementNode[]` (122 entries)
  - `getAdvancement(id: string): AdvancementNode | undefined`
  - `frontierOf(earned: Set<string>): AdvancementNode[]` — advancements not earned whose parent is earned, with the dimension roots gated (see below)
  - `descendantCount(id: string): number` — how many advancements this one eventually unlocks
  - `TOTAL_ADVANCEMENTS: number` (122)

**Two traps, both measured on the real tree 2026-08-13:**

- `nether/root` and `end/root` have `parent: null` like the three overworld roots, so a naive "roots are always reachable" rule offers "go to the Nether" to a team with no portal. They must be gated behind `story/enter_the_nether` and `story/enter_the_end` respectively.
- Sorting the frontier by id picks dead ends. On the real team state the story frontier is `[enchant_item, lava_bucket, shiny_gear]`; `enchant_item` unlocks **0** further advancements and `lava_bucket` unlocks **5** and is the only route to the nether. Order by `descendantCount` descending, id ascending as tiebreak.

- [ ] **Step 1: Write the failing test**

```ts
// src/bot/advancement-tree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_ADVANCEMENTS,
  TOTAL_ADVANCEMENTS,
  getAdvancement,
  frontierOf,
  descendantCount,
} from "./advancement-tree.js";

// THE BUG THIS FILE EXISTS FOR.
//
// curriculum.ts drove goal-setting from a hand-written 8-rung ladder ending at
// "diamonds". Once a bot passed it, getTechTreeLine returned:
//
//   "TECH TREE: complete through diamonds. You are endgame — focus on your role"
//
// Measured 2026-08-13 from server/ai-world/advancements: the team had 13 of the
// game's 122 advancements (10%), 0 of 24 nether and 0 of 9 end, and Atlas had
// already earned story/mine_diamond. The curriculum was telling the swarm it had
// finished the game at 10% completion. Skill-menu rotation and an honest success
// metric cannot help a team that has been told there is nothing left to want.

test("the tree has every advancement and no recipe unlocks", () => {
  assert.equal(TOTAL_ADVANCEMENTS, 122);
  assert.equal(ALL_ADVANCEMENTS.length, 122);
  assert.ok(!ALL_ADVANCEMENTS.some((a) => a.id.startsWith("recipes/")));
});

test("ids are bare, not namespaced", () => {
  assert.ok(!ALL_ADVANCEMENTS.some((a) => a.id.includes("minecraft:")));
});

test("the five roots have no parent and everything else does", () => {
  const roots = ALL_ADVANCEMENTS.filter((a) => a.parent === null);
  assert.equal(roots.length, 5);
  assert.deepEqual(
    roots.map((r) => r.id).sort(),
    ["adventure/root", "end/root", "husbandry/root", "nether/root", "story/root"],
  );
});

test("every non-root parent resolves to a real node", () => {
  for (const a of ALL_ADVANCEMENTS) {
    if (a.parent === null) continue;
    assert.ok(getAdvancement(a.parent), `${a.id} has dangling parent ${a.parent}`);
  }
});

test("a fresh world's frontier is the three OVERWORLD roots only", () => {
  const f = frontierOf(new Set());
  assert.deepEqual(f.map((a) => a.id).sort(), ["adventure/root", "husbandry/root", "story/root"]);
});

test("the dimension roots are gated behind actually going there", () => {
  // nether/root and end/root declare parent:null like the overworld roots, so a
  // naive frontier hands "go to the Nether" to a team that has never made a
  // bucket. They are unlocked by arriving, not by being reachable.
  assert.ok(!frontierOf(new Set()).some((a) => a.id === "nether/root"));
  assert.ok(!frontierOf(new Set()).some((a) => a.id === "end/root"));
  assert.ok(frontierOf(new Set(["story/enter_the_nether"])).some((a) => a.id === "nether/root"));
});

test("descendantCount measures how much an advancement unlocks", () => {
  // The numbers that make lava_bucket beat enchant_item.
  assert.equal(descendantCount("story/enchant_item"), 0);
  assert.equal(descendantCount("story/lava_bucket"), 5);
  assert.equal(descendantCount("adventure/root"), 43);
});

test("earning a parent unlocks its children", () => {
  const f = frontierOf(new Set(["story/root"]));
  assert.ok(f.some((a) => a.id === "story/mine_stone"), "mine_stone should unlock after story/root");
  assert.ok(!f.some((a) => a.id === "story/root"), "an earned advancement is not on the frontier");
});

test("the nether is gated behind form_obsidian, not directly available", () => {
  const earned = new Set(["story/root", "story/mine_stone", "story/smelt_iron"]);
  assert.ok(!frontierOf(earned).some((a) => a.id === "story/enter_the_nether"));
  earned.add("story/lava_bucket");
  earned.add("story/form_obsidian");
  assert.ok(frontierOf(earned).some((a) => a.id === "story/enter_the_nether"));
});

test("the real team state produces a non-empty frontier", () => {
  // The 13 advancements the swarm actually held on 2026-08-13.
  const earned = new Set([
    "story/root", "story/mine_stone", "story/upgrade_tools", "story/smelt_iron",
    "story/iron_tools", "story/obtain_armor", "story/mine_diamond", "story/deflect_arrow",
    "adventure/root", "adventure/kill_a_mob", "adventure/sleep_in_bed",
    "husbandry/root", "husbandry/plant_seed",
  ]);
  const f = frontierOf(earned);
  assert.ok(f.length > 0);
  assert.ok(f.some((a) => a.id === "story/lava_bucket"), "lava_bucket is the real next step on the spine");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/bot/advancement-tree.test.ts`
Expected: FAIL — `Cannot find module './advancement-tree.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/bot/advancement-tree.ts
//
// The game's own advancement graph, used as the curriculum.
//
// The hand-written TECH_LADDER in curriculum.ts stopped at diamonds, which made
// "you are endgame" the terminal state at 10% completion. The advancement tree
// has 122 rungs, declares its own dependencies, and is maintained by Mojang
// rather than by us.
//
// Pure and data-only on purpose: reading who has earned what is a separate
// concern (advancement-progress.ts) so this stays trivially testable.

import tree from "../data/advancement-tree.json" with { type: "json" };

export interface AdvancementNode {
  id: string;
  parent: string | null;
  title: string;
  description: string;
  category: string;
}

export const ALL_ADVANCEMENTS: AdvancementNode[] = tree as AdvancementNode[];
export const TOTAL_ADVANCEMENTS = ALL_ADVANCEMENTS.length;

const BY_ID = new Map(ALL_ADVANCEMENTS.map((a) => [a.id, a]));

export function getAdvancement(id: string): AdvancementNode | undefined {
  return BY_ID.get(id);
}

/**
 * Roots that are not actually free.
 *
 * All five category roots declare parent:null, but "Nether" and "The End" are
 * awarded for BEING in those dimensions. Treating them as reachable would put
 * "go to the Nether" in front of a team that has never smelted a bucket, which
 * is precisely the kind of unreachable goal the old ladder's endgame message
 * was already causing.
 */
const ROOT_GATES: Record<string, string> = {
  "nether/root": "story/enter_the_nether",
  "end/root": "story/enter_the_end",
};

const CHILDREN = new Map<string, string[]>();
for (const a of ALL_ADVANCEMENTS) {
  if (a.parent === null) continue;
  const list = CHILDREN.get(a.parent) ?? [];
  list.push(a.id);
  CHILDREN.set(a.parent, list);
}

/**
 * How many advancements this one eventually unlocks.
 *
 * The ordering signal. Alphabetically, story/enchant_item (0 descendants, a
 * dead end) beats story/lava_bucket (5 descendants, and the only route to the
 * nether's 24). Picking by id would have sent the swarm to enchanting while the
 * portal stayed unbuilt.
 */
export function descendantCount(id: string): number {
  let total = 0;
  for (const child of CHILDREN.get(id) ?? []) total += 1 + descendantCount(child);
  return total;
}

/**
 * Advancements that are reachable right now: not yet earned, but whose parent
 * has been (and whose dimension gate, if any, has been passed).
 *
 * This is the set worth putting in front of the model. Anything deeper is
 * noise — the bot cannot act on "kill the ender dragon" while it is still
 * looking for a bucket.
 */
export function frontierOf(earned: Set<string>): AdvancementNode[] {
  return ALL_ADVANCEMENTS.filter((a) => {
    if (earned.has(a.id)) return false;
    const gate = ROOT_GATES[a.id];
    if (gate !== undefined) return earned.has(gate);
    return a.parent === null || earned.has(a.parent);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/bot/advancement-tree.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/bot/advancement-tree.ts src/bot/advancement-tree.test.ts
git commit -m "Give the swarm a 122-rung ladder instead of one that ends at diamonds"
```

---

### Task 3: Read real progress from the server's own files

**Files:**
- Create: `src/bot/advancement-progress.ts`
- Test: `src/bot/advancement-progress.test.ts`

**Interfaces:**
- Consumes: `frontierOf`, `TOTAL_ADVANCEMENTS` from Task 2.
- Produces:
  - `offlineUUID(name: string): string`
  - `readEarned(botName: string, serverDir?: string): Set<string>` — bare ids that bot has completed
  - `readTeamEarned(botNames: string[], serverDir?: string): Set<string>` — union across the roster
  - `levelName(serverDir?: string): string` — parsed from `server.properties`, defaults to `"world"`

- [ ] **Step 1: Write the failing test**

```ts
// src/bot/advancement-progress.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { offlineUUID, readEarned, readTeamEarned, levelName } from "./advancement-progress.js";

// THE BUG THIS FILE EXISTS FOR.
//
// grep -rin "advancement" src/ returned zero hits, while Paper had been writing
// ground truth to server/ai-world/advancements/<uuid>.json the entire time --
// 42-46KB per bot. Every success signal the swarm had was self-reported by the
// bot that produced it, which is how classifyResult could score "deposited 12
// cobblestone" as a failure for weeks without anyone noticing.
//
// The server awards advancements. The bot cannot fake one.

test("offline UUIDs match what the server actually wrote", () => {
  // Verified against server/ai-world/advancements on 2026-08-13.
  assert.equal(offlineUUID("Atlas"), "1d4a9c61-6828-3517-9704-a0518eccaaa5");
  assert.equal(offlineUUID("Forge"), "2ddbb85b-90ad-320b-9e1f-c301c5383966");
  assert.equal(offlineUUID("Flora"), "fca4d5a4-b8c1-3fcc-8a0a-eb752019a2bb");
  assert.equal(offlineUUID("Mason"), "c12cc45b-0377-32a5-8fa0-d0f7cc95b22c");
  assert.equal(offlineUUID("Blade"), "a1c25b56-6d84-3914-8d8a-b6642a89c3fa");
});

test("the level name comes from server.properties, not a hardcoded 'world'", () => {
  assert.equal(levelName("server"), "ai-world");
});

test("a bot with no progress file yields an empty set rather than throwing", () => {
  assert.deepEqual(readEarned("NoSuchBot", "server"), new Set());
});

test("recipe unlocks are never counted as advancements", () => {
  const earned = readEarned("Atlas", "server");
  assert.ok(![...earned].some((id) => id.startsWith("recipes/")));
});

test("ids are stored bare so they join against the tree", () => {
  const earned = readEarned("Atlas", "server");
  assert.ok(![...earned].some((id) => id.includes("minecraft:")));
});

test("Atlas has the diamond that made the old ladder terminal", () => {
  assert.ok(readEarned("Atlas", "server").has("story/mine_diamond"));
});

test("the team union is at least as large as any single member", () => {
  const roster = ["Atlas", "Flora", "Forge", "Mason", "Blade"];
  const team = readTeamEarned(roster, "server");
  for (const bot of roster) {
    for (const id of readEarned(bot, "server")) {
      assert.ok(team.has(id), `${id} earned by ${bot} missing from the union`);
    }
  }
});

test("the team has not been to the nether or the end", () => {
  const team = readTeamEarned(["Atlas", "Flora", "Forge", "Mason", "Blade"], "server");
  assert.ok(![...team].some((id) => id.startsWith("nether/")));
  assert.ok(![...team].some((id) => id.startsWith("end/")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/bot/advancement-progress.test.ts`
Expected: FAIL — `Cannot find module './advancement-progress.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/bot/advancement-progress.ts
//
// Ground truth: what the SERVER says each bot has accomplished.
//
// Everything else in this codebase learns about success from the bot that
// claims it. Paper writes advancement completion to disk as the authority, so
// this module is the one place where progress cannot be self-reported.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * With online-mode=false the server derives player UUIDs from the name alone:
 * a version-3 (MD5) UUID over "OfflinePlayer:<name>". Reproducing it here means
 * we can find a bot's progress file without the server running.
 */
export function offlineUUID(name: string): string {
  const md5 = crypto.createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = md5.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The world directory is configurable; ours is "ai-world", not "world". */
export function levelName(serverDir = "server"): string {
  try {
    const props = readFileSync(path.join(serverDir, "server.properties"), "utf-8");
    return /^level-name=(.+)$/m.exec(props)?.[1].trim() || "world";
  } catch {
    return "world";
  }
}

export function readEarned(botName: string, serverDir = "server"): Set<string> {
  const file = path.join(serverDir, levelName(serverDir), "advancements", `${offlineUUID(botName)}.json`);
  const earned = new Set<string>();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // A bot that has never joined has no file. Not an error — it has earned nothing.
    return earned;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === "DataVersion") continue;
    const id = key.replace(/^minecraft:/, "");
    // Recipe unlocks share the file but are not advancements.
    if (id.startsWith("recipes/")) continue;
    if (typeof value === "object" && value !== null && (value as { done?: boolean }).done) {
      earned.add(id);
    }
  }
  return earned;
}

export function readTeamEarned(botNames: string[], serverDir = "server"): Set<string> {
  const union = new Set<string>();
  for (const name of botNames) for (const id of readEarned(name, serverDir)) union.add(id);
  return union;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/bot/advancement-progress.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/bot/advancement-progress.ts src/bot/advancement-progress.test.ts
git commit -m "Read progress from the server instead of trusting the bots"
```

---

### Task 4: Route advancements to the bot best suited to them

**Files:**
- Create: `src/bot/advancement-routing.ts`
- Test: `src/bot/advancement-routing.test.ts`

**Interfaces:**
- Consumes: `AdvancementNode` from Task 2.
- Produces: `assignFor(role: string, frontier: AdvancementNode[]): AdvancementNode | null` — the single best next advancement for a role, or `null` when the frontier holds nothing suited to it.

- [ ] **Step 1: Write the failing test**

```ts
// src/bot/advancement-routing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { assignFor } from "./advancement-routing.js";
import type { AdvancementNode } from "./advancement-tree.js";

// THE BUG THIS FILE EXISTS FOR (pre-emptively).
//
// The swarm is five specialists: Explorer/Miner, Farmer/Crafter, Miner/Smelter,
// Builder, Combat/Guard. The advancement tree is 44 adventure + 29 husbandry +
// 24 nether + 16 story + 9 end, and it does not care about job titles. Handing
// the same frontier to all five bots would have Flora the farmer chasing
// nether/obtain_blaze_rod while 29 husbandry advancements sat untouched.
//
// Routing keeps the specialists (which is what makes the stream watchable) and
// parallelises the tree across five agents instead of serialising it.

const node = (id: string): AdvancementNode => ({
  id,
  parent: null,
  title: id,
  description: "",
  category: id.split("/")[0],
});

test("the farmer gets husbandry work", () => {
  const f = [node("husbandry/breed_an_animal"), node("nether/obtain_blaze_rod")];
  assert.equal(assignFor("Farmer / Crafter", f)?.id, "husbandry/breed_an_animal");
});

test("the smelter gets the story spine and the nether", () => {
  const f = [node("husbandry/breed_an_animal"), node("story/lava_bucket")];
  assert.equal(assignFor("Miner / Smelter", f)?.id, "story/lava_bucket");
});

test("the guard gets combat adventure work", () => {
  const f = [node("adventure/kill_all_mobs"), node("husbandry/plant_seed")];
  assert.equal(assignFor("Combat / Guard", f)?.id, "adventure/kill_all_mobs");
});

test("a role falls back to any advancement rather than idling", () => {
  const f = [node("husbandry/breed_an_animal")];
  assert.ok(assignFor("Combat / Guard", f), "a guard with only farm work should still get a goal");
});

test("an empty frontier yields null, not a crash", () => {
  assert.equal(assignFor("Builder", []), null);
});

test("every role in the roster resolves to something on a mixed frontier", () => {
  const f = [
    node("story/lava_bucket"), node("husbandry/breed_an_animal"),
    node("adventure/kill_all_mobs"), node("nether/root"), node("adventure/adventuring_time"),
  ];
  for (const role of ["Explorer / Miner", "Farmer / Crafter", "Miner / Smelter", "Builder", "Combat / Guard"]) {
    assert.ok(assignFor(role, f), `${role} got no assignment`);
  }
});

test("routing is deterministic so two bots do not thrash between goals", () => {
  const f = [node("story/lava_bucket"), node("story/form_obsidian")];
  assert.equal(assignFor("Miner / Smelter", f)?.id, assignFor("Miner / Smelter", f)?.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/bot/advancement-routing.test.ts`
Expected: FAIL — `Cannot find module './advancement-routing.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/bot/advancement-routing.ts
//
// Which bot should chase which advancement.
//
// Five specialists, 122 advancements, and no overlap between the two
// vocabularies. Rather than dissolve the roles into generalists, each role
// declares the categories it prefers; the frontier is filtered by preference
// and only falls back to "anything" when the preferred buckets are empty --
// a bot with no suitable goal should still have a goal.

import { descendantCount, type AdvancementNode } from "./advancement-tree.js";

/** Category preference per role, best first. Roles are matched on the exact
 *  `role` string from BotRoleConfig. */
const AFFINITY: Record<string, string[]> = {
  "Explorer / Miner": ["adventure", "story", "nether", "end", "husbandry"],
  "Farmer / Crafter": ["husbandry", "story", "adventure", "nether", "end"],
  "Miner / Smelter": ["story", "nether", "end", "adventure", "husbandry"],
  Builder: ["story", "adventure", "husbandry", "nether", "end"],
  "Combat / Guard": ["adventure", "end", "nether", "story", "husbandry"],
};

const DEFAULT_ORDER = ["story", "adventure", "husbandry", "nether", "end"];

/**
 * Gateways first, dead ends last, id as a tiebreak.
 *
 * Sorting by id alone put story/enchant_item (unlocks nothing) ahead of
 * story/lava_bucket (unlocks 5, including the whole nether). The tiebreak keeps
 * the result deterministic: a goal that flickers between decisions is a goal
 * that never completes.
 */
function byUnlockValue(a: AdvancementNode, b: AdvancementNode): number {
  return descendantCount(b.id) - descendantCount(a.id) || a.id.localeCompare(b.id);
}

export function assignFor(role: string, frontier: AdvancementNode[]): AdvancementNode | null {
  if (frontier.length === 0) return null;
  const order = AFFINITY[role] ?? DEFAULT_ORDER;
  for (const category of order) {
    const matches = frontier.filter((a) => a.category === category).sort(byUnlockValue);
    if (matches.length > 0) return matches[0];
  }
  return [...frontier].sort(byUnlockValue)[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/bot/advancement-routing.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/bot/advancement-routing.ts src/bot/advancement-routing.test.ts
git commit -m "Route advancements to the specialist best suited to each"
```

---

### Task 5: Put the next advancement in front of the model

**Files:**
- Create: `src/bot/advancement-line.ts`
- Test: `src/bot/advancement-line.test.ts`
- Modify: `src/bot/curriculum.ts:141` (the "you are endgame" terminal branch)
- Modify: `src/bot/brain.ts:588` (inject the line into `buildContext`)

**Interfaces:**
- Consumes: `assignFor` (Task 4), `frontierOf` / `TOTAL_ADVANCEMENTS` (Task 2), `readTeamEarned` (Task 3).
- Produces: `advancementLine(role: string, earned: Set<string>): string` — one context line, or `""` when all 122 are done.

- [ ] **Step 1: Write the failing test**

```ts
// src/bot/advancement-line.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { advancementLine } from "./advancement-line.js";
import { ALL_ADVANCEMENTS } from "./advancement-tree.js";

// THE BUG THIS FILE EXISTS FOR.
//
// getTechTreeLine's terminal branch returned "TECH TREE: complete through
// diamonds. You are endgame — focus on your role and the mission." Atlas earned
// story/mine_diamond, so that string was the swarm's stated purpose while it
// held 13 of 122 advancements and had never entered the nether.

const TEAM_2026_08_13 = new Set([
  "story/root", "story/mine_stone", "story/upgrade_tools", "story/smelt_iron",
  "story/iron_tools", "story/obtain_armor", "story/mine_diamond", "story/deflect_arrow",
  "adventure/root", "adventure/kill_a_mob", "adventure/sleep_in_bed",
  "husbandry/root", "husbandry/plant_seed",
]);

test("the line names a concrete next advancement", () => {
  const line = advancementLine("Miner / Smelter", TEAM_2026_08_13);
  assert.match(line, /Hot Stuff|lava_bucket/i, `expected the lava bucket step: ${line}`);
});

test("the line carries the description so the model knows what to DO", () => {
  const line = advancementLine("Miner / Smelter", TEAM_2026_08_13);
  assert.match(line, /Fill a Bucket with lava/i);
});

test("the line reports honest progress out of 122", () => {
  assert.match(advancementLine("Builder", TEAM_2026_08_13), /13\/122/);
});

test("no bot is ever told it is finished while advancements remain", () => {
  for (const role of ["Explorer / Miner", "Farmer / Crafter", "Miner / Smelter", "Builder", "Combat / Guard"]) {
    const line = advancementLine(role, TEAM_2026_08_13);
    assert.ok(line.length > 0, `${role} got an empty line`);
    assert.doesNotMatch(line, /endgame/i, `${role} was told it is endgame at 13/122`);
  }
});

test("a completed game yields an empty line rather than a fake goal", () => {
  const all = new Set(ALL_ADVANCEMENTS.map((a) => a.id));
  assert.equal(advancementLine("Builder", all), "");
});

test("the line stays short enough for a per-decision context", () => {
  assert.ok(advancementLine("Farmer / Crafter", TEAM_2026_08_13).length < 300);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/bot/advancement-line.test.ts`
Expected: FAIL — `Cannot find module './advancement-line.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/bot/advancement-line.ts
//
// The curriculum, rendered for the strategic prompt.
//
// Deliberately one line and one goal. The frontier can hold a dozen reachable
// advancements; showing all of them recreates the problem the skill menu had,
// where a model given a long list picks the familiar item every time.

import { frontierOf, TOTAL_ADVANCEMENTS } from "./advancement-tree.js";
import { assignFor } from "./advancement-routing.js";

export function advancementLine(role: string, earned: Set<string>): string {
  const target = assignFor(role, frontierOf(earned));
  if (!target) return "";
  const desc = target.description ? ` — ${target.description}.` : "";
  return `ADVANCEMENTS: ${earned.size}/${TOTAL_ADVANCEMENTS} earned. NEXT FOR YOU: "${target.title}" (${target.id})${desc}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/bot/advancement-line.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Remove the endgame dead-end from curriculum.ts**

In `src/bot/curriculum.ts`, replace this line inside `getTechTreeLine`:

```ts
  if (!next) return "TECH TREE: complete through diamonds. You are endgame — focus on your role and the mission.";
```

with:

```ts
  // The tech ladder is early-game scaffolding only. Past diamonds the
  // advancement tree takes over as the curriculum, so say nothing here rather
  // than declaring victory at 10% completion.
  if (!next) return "";
```

- [ ] **Step 6: Wire the line into the strategic context**

In `src/bot/brain.ts`, add to the imports near line 43:

```ts
import { advancementLine } from "./advancement-line.js";
import { readTeamEarned } from "./advancement-progress.js";
import { BOT_ROSTER } from "./role.js";
```

Then in `buildContext`, immediately after the existing tech-tree block (line 588-589):

```ts
    // Ground truth from the server, not from the bot's own claims. Cached by
    // readTeamEarned's caller cadence — buildContext runs at most every ~10s.
    const advLine = advancementLine(this.roleConfig.role, readTeamEarned(BOT_ROSTER.map((b) => b.name)));
    if (advLine) ctx += `\n\n${advLine}`;
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — all pre-existing tests plus the 31 new ones from Tasks 2-5 (10 tree + 8 progress + 7 routing + 6 line).

- [ ] **Step 8: Commit**

```bash
git add src/bot/advancement-line.ts src/bot/advancement-line.test.ts src/bot/curriculum.ts src/bot/brain.ts
git commit -m "Tell each bot its next advancement instead of telling it the game is over"
```

---

### Task 6: Log progress over time

**Files:**
- Create: `src/bot/advancement-log.ts`
- Test: `src/bot/advancement-log.test.ts`
- Modify: `src/bot/index.ts` (call the snapshot on startup)

**Interfaces:**
- Consumes: `readTeamEarned` (Task 3), `TOTAL_ADVANCEMENTS` (Task 2).
- Produces: `snapshotLine(earned: Set<string>, at: Date): string` (pure, testable) and `appendSnapshot(botNames: string[], at: Date, file?: string): void`.

- [ ] **Step 1: Write the failing test**

```ts
// src/bot/advancement-log.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { snapshotLine, CSV_HEADER } from "./advancement-log.js";

// THE BUG THIS FILE EXISTS FOR.
//
// The project's claim is that a local open-weights swarm improves over time
// under frontier-model guidance. There was no time series to support it --
// progress was assessed by reading logs and forming an impression, which is
// how "generation flatlined Jun 20 -> Jul 14 -> Aug 2" went unnoticed for six
// weeks. One append-only CSV makes the claim falsifiable.

test("the header names every column the row writes", () => {
  const cols = CSV_HEADER.split(",").length;
  const earned = new Set(["story/root", "nether/root"]);
  assert.equal(snapshotLine(earned, new Date("2026-08-13T12:00:00Z")).split(",").length, cols);
});

test("a row carries the timestamp, total, and per-category counts", () => {
  const earned = new Set(["story/root", "story/mine_stone", "nether/root"]);
  const row = snapshotLine(earned, new Date("2026-08-13T12:00:00Z"));
  assert.match(row, /^2026-08-13T12:00:00\.000Z,3,/);
  assert.ok(row.includes(",2,"), `story count of 2 should appear: ${row}`);
});

test("an empty set logs zeroes rather than being skipped", () => {
  // timestamp,total,possible,story,nether,end,adventure,husbandry
  const row = snapshotLine(new Set(), new Date("2026-08-13T12:00:00Z"));
  assert.equal(row, "2026-08-13T12:00:00.000Z,0,122,0,0,0,0,0");
});

test("the possible column is the real denominator, not the earned count", () => {
  const row = snapshotLine(new Set(["story/root"]), new Date("2026-08-13T12:00:00Z"));
  assert.equal(row.split(",")[2], "122");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/bot/advancement-log.test.ts`
Expected: FAIL — `Cannot find module './advancement-log.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/bot/advancement-log.ts
//
// An append-only record of what the swarm had achieved and when.
//
// Everything else here is a snapshot of the present. This is the only artifact
// that can answer "is it getting better?", which is the actual research
// question the project exists to answer.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { TOTAL_ADVANCEMENTS } from "./advancement-tree.js";
import { readTeamEarned } from "./advancement-progress.js";

const CATEGORIES = ["story", "nether", "end", "adventure", "husbandry"] as const;

export const CSV_HEADER = `timestamp,total,possible,${CATEGORIES.join(",")}`;

export function snapshotLine(earned: Set<string>, at: Date): string {
  const counts = CATEGORIES.map((c) => [...earned].filter((id) => id.startsWith(`${c}/`)).length);
  return `${at.toISOString()},${earned.size},${TOTAL_ADVANCEMENTS},${counts.join(",")}`;
}

export function appendSnapshot(botNames: string[], at: Date, file = "logs/advancement-progress.csv"): void {
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, CSV_HEADER + "\n");
  appendFileSync(file, snapshotLine(readTeamEarned(botNames), at) + "\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/bot/advancement-log.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Call it on startup**

In `src/bot/index.ts`, add the import and a single call once the roster is known:

```ts
import { appendSnapshot } from "./advancement-log.js";
import { BOT_ROSTER } from "./role.js";

// One row per swarm start. Cheap, and it is the only record of whether any of
// this works.
appendSnapshot(BOT_ROSTER.map((b) => b.name), new Date());
```

- [ ] **Step 6: Verify the first row is real**

Run: `npm test && npx tsx -e "import('./src/bot/advancement-log.js').then(m=>m.appendSnapshot(['Atlas','Flora','Forge','Mason','Blade'],new Date()))" && cat logs/advancement-progress.csv`
Expected: a header row plus a data row reading `<timestamp>,13,122,8,0,0,3,2`

- [ ] **Step 7: Commit**

```bash
git add src/bot/advancement-log.ts src/bot/advancement-log.test.ts src/bot/index.ts logs/advancement-progress.csv
git commit -m "Record what the swarm had achieved and when"
```

---

## Follow-on plans (not in scope here)

1. **Nether breach** — `lava_bucket` → `form_obsidian` → `enter_the_nether`. Unlocks 33 of the 109 remaining advancements. Needs a portal-building skill and probably a bucket/lava-locating skill.
2. **Frontier-model loop** — nightly cron that reads the frontier plus the day's failures, authors and repairs skills, and commits; plus an escalation path when a bot fails the same assigned advancement N times. This is what makes "improves under frontier guidance" true rather than aspirational. Depends on this plan's frontier and log.
3. **Skill authorship handoff** — `src/skills/generator.ts:96` currently sends skill authoring to the local 20B. Move authoring to the frontier model and leave invocation local.
