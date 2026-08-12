import { test } from "node:test";
import assert from "node:assert/strict";

import { blockDurationFor, TRANSIENT_MS, STRUCTURAL_MS } from "./block-escalation.js";

// THE BUG THIS FILE EXISTS FOR.
//
// blockAction() defaulted every failure to FAILURE_TTL_TRANSIENT_MS (120s), and
// nothing escalated. So a skill that could never succeed cycled forever:
//
//   fail, fail -> blocked 120s -> expires -> re-picked -> fail, fail -> ...
//
// At ~2 failures per 2 minutes that is ~60/hour. Measured on 2026-08-10,
// craftChest ran 71 attempts in one day with ZERO successes, every one failing
// "Cannot find crafting_table nearby".
//
// It could not be rescued by the retirement system either: reliability.ts skips
// failures matching PRECONDITION_KEYWORDS, which contains "Cannot find" (added
// for Voyager's mineBlock). So craftChest logged 82 attempts that the stats
// never saw, stayed permanently "untried", and never retired.
//
// The blacklist treated failure #82 as no more informative than failure #1.
// Escalating the TTL is what makes repetition cost something.

test("a first failure is treated as bad luck, not a pattern", () => {
  assert.equal(blockDurationFor(1), TRANSIENT_MS);
});

test("a second block lasts longer than the first", () => {
  assert.ok(blockDurationFor(2) > blockDurationFor(1));
});

test("escalation is monotonic", () => {
  const durations = [1, 2, 3, 4, 5].map(blockDurationFor);
  for (let i = 1; i < durations.length; i++) {
    assert.ok(
      durations[i] >= durations[i - 1],
      `block ${i + 1} (${durations[i]}ms) must not be shorter than block ${i} (${durations[i - 1]}ms)`,
    );
  }
});

test("a repeatedly-blocked action reaches structural duration", () => {
  assert.equal(blockDurationFor(4), STRUCTURAL_MS);
});

test("escalation caps rather than growing without bound", () => {
  assert.equal(blockDurationFor(50), STRUCTURAL_MS);
  assert.equal(blockDurationFor(1000), STRUCTURAL_MS);
});

// craftChest's real trajectory. Under the old flat 120s TTL these 4 blocks
// cost 8 minutes of suppression total, so the bot kept coming back all day.
test("craftChest's first four blocks suppress it for over an hour, not 8 minutes", () => {
  const total = [1, 2, 3, 4].reduce((sum, n) => sum + blockDurationFor(n), 0);
  const oldFlatTotal = 4 * TRANSIENT_MS;
  assert.ok(total > oldFlatTotal * 10, `escalated total ${total}ms should dwarf flat ${oldFlatTotal}ms`);
  assert.ok(total >= 3_600_000, "four strikes should exceed an hour of suppression");
});

test("counts below one are treated as a first offence", () => {
  assert.equal(blockDurationFor(0), TRANSIENT_MS);
  assert.equal(blockDurationFor(-3), TRANSIENT_MS);
});
