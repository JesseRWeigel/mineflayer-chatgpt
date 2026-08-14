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
