import { test } from "node:test";
import assert from "node:assert/strict";

import { isDeathTrap, deathsNear, TRAP_DEATH_THRESHOLD, TRAP_WINDOW_MS } from "./death-trap.js";

const NOW = Date.parse("2026-08-07T09:48:00Z");
const at = (mins: number) => new Date(NOW - mins * 60_000).toISOString();

// Forge's real cluster: 13 deaths near (296,61,-304), median gap 53s, five
// inside 94 seconds, wearing an iron chestplate for 16 of them.
const FORGE_TUNNEL = Array.from({ length: 13 }, (_, i) => ({ x: 296, y: 61, z: -304, timestamp: at(i) }));

test("refuses to return to the tunnel that killed it thirteen times", () => {
  assert.equal(isDeathTrap({ x: 296, z: -304 }, FORGE_TUNNEL, NOW, false), true);
});

test("one or two deaths are not a trap", () => {
  // Dying somewhere once is ordinary. Blacklisting on it would strand the swarm.
  const few = FORGE_TUNNEL.slice(0, TRAP_DEATH_THRESHOLD - 1);
  assert.equal(isDeathTrap({ x: 296, z: -304 }, few, NOW, false), false);
  assert.equal(isDeathTrap({ x: 296, z: -304 }, FORGE_TUNNEL.slice(0, TRAP_DEATH_THRESHOLD), NOW, false), true);
});

// The base is exempt on purpose: 9 of Forge's deaths were within a few blocks
// of the stash, and blacklisting the stash would stop the swarm depositing.
test("the base is never a trap, however often bots die there", () => {
  const atStash = Array.from({ length: 20 }, (_, i) => ({ x: 288, y: 66, z: -312, timestamp: at(i) }));
  assert.equal(isDeathTrap({ x: 288, z: -312 }, atStash, NOW, true), false);
});

test("old deaths stop condemning a place", () => {
  const stale = FORGE_TUNNEL.map((d) => ({ ...d, timestamp: at(TRAP_WINDOW_MS / 60_000 + 5) }));
  assert.equal(isDeathTrap({ x: 296, z: -304 }, stale, NOW, false), false);
});

test("a different place is unaffected", () => {
  assert.equal(isDeathTrap({ x: 500, z: 500 }, FORGE_TUNNEL, NOW, false), false);
});

test("proximity is horizontal, so a tunnel below still counts", () => {
  // Forge died at y=61 and y=66 within the same column. Depth must not exempt it.
  const mixed = [
    { x: 296, y: 61, z: -304, timestamp: at(1) },
    { x: 296, y: 66, z: -304, timestamp: at(2) },
    { x: 297, y: 70, z: -305, timestamp: at(3) },
  ];
  assert.equal(deathsNear({ x: 296, z: -304 }, mixed, NOW), 3);
});

test("deaths with no timestamp still count", () => {
  // Older memory entries predate timestamping; dropping them would silently
  // disarm the guard on exactly the bots with the longest death history.
  const untimed = Array.from({ length: 4 }, () => ({ x: 296, y: 61, z: -304 }));
  assert.equal(isDeathTrap({ x: 296, z: -304 }, untimed, NOW, false), true);
});
