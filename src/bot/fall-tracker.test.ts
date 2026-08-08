import { test } from "node:test";
import assert from "node:assert/strict";

import { createFallTracker } from "./fall-tracker.js";

// The bug this file exists for: a falling bot lands before it dies, and the
// landing tick used to overwrite the recorded ground height, so the drop
// computed as ~0 and nothing was logged across two real fall deaths.
test("drop survives the landing tick that precedes a fall death", () => {
  const t = createFallTracker(90);
  t.update(90, true, 0); // walking on high ground
  t.update(89, false, 100); // steps off — fall begins at y=90
  t.update(80, false, 400); // mid-air
  t.update(70, true, 900); // LANDS at y=70, then dies from the damage
  assert.equal(t.dropFrom(70), 20, "must report the 20-block fall, not 0");
  assert.equal(t.originY(), 90);
});

test("a bot that never left the ground reports no fall", () => {
  const t = createFallTracker(64);
  t.update(64, true, 0);
  t.update(64, true, 50);
  assert.equal(t.dropFrom(64), 0);
});

test("walking downhill on the ground is not a fall", () => {
  const t = createFallTracker(80);
  for (let y = 80; y >= 70; y--) t.update(y, true, y);
  assert.equal(t.dropFrom(70), 0, "grounded descent must not read as a drop");
});

test("only the most recent departure from ground counts", () => {
  const t = createFallTracker(100);
  t.update(100, true, 0);
  t.update(99, false, 10); // first fall from 100
  t.update(90, true, 20); // survives, lands at 90
  t.update(89, false, 30); // second fall starts from 90
  t.update(60, true, 40);
  assert.equal(t.dropFrom(60), 30, "must measure the second fall, not the first");
  assert.equal(t.originY(), 90);
});

test("airborne time is zero before the first fall", () => {
  const t = createFallTracker(64);
  t.update(64, true, 500);
  assert.equal(t.airborneMs(900), 0);
});

test("airborne time measures from leaving the ground", () => {
  const t = createFallTracker(64);
  t.update(64, true, 0);
  t.update(63, false, 1000);
  assert.equal(t.airborneMs(3500), 2500);
});

// Three mechanism hypotheses died against the source before this instrument
// existed. What holds the controls at the ground->airborne tick is the evidence.
test("captures what was moving the bot at the moment it left the ground", () => {
  const t = createFallTracker(116);
  t.update(116, true, 0, "controls=forward pathing=true");
  t.update(115, false, 10, "controls=sprint+forward pathing=false");
  t.update(80, false, 500, "controls=none pathing=false");
  t.update(71, true, 900, "controls=none pathing=false");
  assert.equal(t.originContext(), "controls=sprint+forward pathing=false");
  assert.equal(t.dropFrom(71), 45);
});

test("grounded ticks do not overwrite the departure context", () => {
  const t = createFallTracker(90);
  t.update(90, true, 0, "controls=forward");
  t.update(89, false, 10, "controls=left+sprint");
  t.update(72, true, 400, "controls=none"); // landing must not clobber it
  assert.equal(t.originContext(), "controls=left+sprint");
});

test("context defaults to empty when not supplied", () => {
  const t = createFallTracker(64);
  t.update(64, true, 0);
  t.update(63, false, 10);
  assert.equal(t.originContext(), "");
});

// THE FOOTING BUG.
//
// c88d494 added `on=` to answer "what is he standing on when he comes off".
// It read the block below the bot on the ground->airborne tick — but by that
// tick the bot has already stepped over the edge, so `on=` describes the gap
// it fell into, not the ground it left. Three of the first four real records
// read `on=air`, which is tautologically true of every fall and says nothing.
//
// This is the same off-by-one-tick the header comment describes for the fall
// HEIGHT, in the opposite direction: the height was sampled one tick too late
// (the landing) and fixed by holding the last grounded value; the footing is
// sampled one tick too late (the departure) and needs the same treatment.
// originY() already uses lastGroundY. The footing must come from the same tick.
test("footing is the ground the bot left, not the gap it fell into", () => {
  const t = createFallTracker(71);
  t.update(71, true, 0, "controls=none in=air on=cobblestone");
  // First airborne tick: already over the gap, so the block below reads air.
  t.update(70.9, false, 50, "controls=none in=air on=air");
  t.update(50, false, 900, "controls=none in=air on=air");
  assert.equal(
    t.originFooting(),
    "controls=none in=air on=cobblestone",
    "must report the cobblestone it walked off, not the air it fell through",
  );
  // The departure sample is still worth keeping: controls and velocity at the
  // instant of leaving are what killed three hypotheses.
  assert.equal(t.originContext(), "controls=none in=air on=air");
});

test("footing survives the landing tick like the height does", () => {
  const t = createFallTracker(118);
  t.update(118, true, 0, "on=oak_planks");
  t.update(117, false, 10, "on=air");
  t.update(96, true, 900, "on=grass_block"); // lands, then dies
  assert.equal(t.originFooting(), "on=oak_planks", "landing must not clobber the footing");
});

test("only the most recent departure's footing is kept", () => {
  const t = createFallTracker(100);
  t.update(100, true, 0, "on=stone");
  t.update(99, false, 10, "on=air");
  t.update(90, true, 20, "on=dirt"); // survives the first fall
  t.update(89, false, 30, "on=air"); // second fall leaves from dirt
  assert.equal(t.originFooting(), "on=dirt");
});

test("footing is empty before the bot has ever left the ground", () => {
  const t = createFallTracker(64);
  t.update(64, true, 0, "on=stone");
  assert.equal(t.originFooting(), "");
});
