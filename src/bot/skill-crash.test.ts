import { test } from "node:test";
import assert from "node:assert/strict";

import { isSkillCrash, isPreconditionFailure } from "./memory.js";

// THE BUG THIS FILE EXISTS FOR.
//
// "Cannot find" was added to PRECONDITION_KEYWORDS so Voyager's mineBlock would
// not be retired merely because the ore it wanted was not nearby. That is a real
// precondition. But the same substring also matched
//
//   "craftChest failed: Cannot find crafting_table nearby"
//
// which is a skill that THREW. Every one of craftChest's 85 consecutive
// failures was therefore excluded from its own statistics. attempts stayed 0,
// so isRetired (which needs >= 8 attempts) could never fire, and the swarm went
// on invoking a skill with a 0% success rate. Measured live 2026-08-14: 0/85.
//
// A precondition is a clean early return. An exception is a bug in the skill,
// whatever the exception text happens to say.

test("a thrown skill is a crash regardless of the message", () => {
  assert.equal(isSkillCrash("craftChest failed: Cannot find crafting_table nearby"), true);
  assert.equal(isSkillCrash("buildTower failed: TypeError: bot.dig is not a function"), true);
});

test("a clean precondition return is not a crash", () => {
  assert.equal(isSkillCrash("Cannot find iron_ore within 32 blocks"), false);
  assert.equal(isSkillCrash("Need a pickaxe! Use craft_gear first."), false);
});

test("craftChest's failures now count against it", () => {
  // The exact string from the live run. This is what must change.
  assert.equal(
    isPreconditionFailure("craftChest failed: Cannot find crafting_table nearby"),
    false,
    "a crashed skill must not hide behind a precondition keyword",
  );
});

test("mineBlock is still protected from ore simply not being nearby", () => {
  // The reason "Cannot find" was added. Must keep working.
  assert.equal(isPreconditionFailure("Cannot find diamond_ore nearby"), true);
  assert.equal(isPreconditionFailure("No trees found within 256 blocks."), true);
  assert.equal(isPreconditionFailure("Nothing to smelt"), true);
  assert.equal(isPreconditionFailure("No fuel"), true);
});

test("an ordinary failure with no precondition wording still counts", () => {
  assert.equal(isPreconditionFailure("Dug for 12s and gave up."), false);
});
