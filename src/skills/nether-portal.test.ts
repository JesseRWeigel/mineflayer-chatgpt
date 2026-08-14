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
