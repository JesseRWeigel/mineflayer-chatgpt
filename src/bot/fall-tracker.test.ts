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
