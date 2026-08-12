import { test } from "node:test";
import assert from "node:assert/strict";

import { pickSkillMenu, PROVEN_SLOTS, EXPLORE_SLOTS } from "./skill-menu.js";

// THE BUG THIS FILE EXISTS FOR.
//
// prompts.ts rendered the dynamic skill menu as:
//
//   rankSkills(getDynamicSkillNames()).slice(0, 10)
//
// rankSkills returns proven skills first, then untried, then strugglers. Once
// the team had 10+ proven skills, every untried skill sat permanently below the
// cut. A skill needed stats to become visible and visibility to earn stats, so
// nothing new could ever enter rotation.
//
// Measured 2026-08-11: 131 skills on disk (40 generated + 91 voyager), and
// exactly 18 had EVER been attempted. Every skill generated past roughly #11
// was dead on arrival, which is why generation flatlined:
// Jun 20 new skills -> Jul 14 -> Aug 2.
//
// Widening the slice does not fix it, because proven-first still wins the top
// of any window. Exploration needs RESERVED slots and rotation.

const proven = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"];
const untried = ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8"];

test("untried skills appear even when proven skills could fill the menu", () => {
  const menu = pickSkillMenu(proven, untried, [], 0);
  assert.ok(
    untried.some((u) => menu.includes(u)),
    `expected at least one untried skill in ${JSON.stringify(menu)}`,
  );
});

test("proven skills still lead the menu", () => {
  const menu = pickSkillMenu(proven, untried, [], 0);
  assert.equal(menu[0], "p1");
});

test("rotation surfaces different untried skills across cycles", () => {
  const first = pickSkillMenu(proven, untried, [], 0).filter((s) => s.startsWith("u"));
  const second = pickSkillMenu(proven, untried, [], 1).filter((s) => s.startsWith("u"));
  assert.notDeepEqual(first, second, "rotation must not show the same untried skills every cycle");
});

test("rotation eventually covers every untried skill", () => {
  const seen = new Set<string>();
  for (let cycle = 0; cycle < 20; cycle++) {
    for (const s of pickSkillMenu(proven, untried, [], cycle)) {
      if (s.startsWith("u")) seen.add(s);
    }
  }
  assert.equal(seen.size, untried.length, `every untried skill should surface; saw ${[...seen].join(",")}`);
});

test("rotation wraps around rather than running off the end", () => {
  const menu = pickSkillMenu(proven, untried, [], 999);
  assert.equal(menu.filter((s) => s.startsWith("u")).length, EXPLORE_SLOTS);
});

test("the menu stays bounded so the prompt cannot blow up", () => {
  const many = Array.from({ length: 500 }, (_, i) => `x${i}`);
  assert.ok(pickSkillMenu(many, many, many, 0).length <= PROVEN_SLOTS + EXPLORE_SLOTS + 2);
});

test("spare capacity goes to proven skills when there is nothing to explore", () => {
  const menu = pickSkillMenu(proven, [], [], 0);
  assert.ok(menu.length > PROVEN_SLOTS, "with no untried skills, proven should use the free slots");
});

test("strugglers fill in only after proven and untried", () => {
  const menu = pickSkillMenu(["p1"], ["u1"], ["s1"], 0);
  assert.deepEqual(menu, ["p1", "u1", "s1"]);
});

test("no duplicates even if a skill appears in two buckets", () => {
  const menu = pickSkillMenu(["dup"], ["dup"], ["dup"], 0);
  assert.deepEqual(menu, ["dup"]);
});

test("an empty library yields an empty menu", () => {
  assert.deepEqual(pickSkillMenu([], [], [], 0), []);
});
