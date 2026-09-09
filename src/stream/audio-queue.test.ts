import assert from "node:assert/strict";
import { test } from "node:test";

// This plain JavaScript module is served directly to the browser overlay.
// @ts-expect-error TypeScript does not load JavaScript outside src without allowJs.
import { ExpiringAudioQueue } from "../../overlay/audio-queue.js";

test("the overlay speech queue drops the oldest item at its count bound", () => {
  const queue = new ExpiringAudioQueue(2, () => 1_000);
  queue.push({ url: "/audio/first.mp3", expiresAt: 2_000 });
  queue.push({ url: "/audio/second.mp3", expiresAt: 2_000 });
  queue.push({ url: "/audio/third.mp3", expiresAt: 2_000 });

  assert.deepEqual(queue.shift(), { url: "/audio/second.mp3", expiresAt: 2_000 });
  assert.deepEqual(queue.shift(), { url: "/audio/third.mp3", expiresAt: 2_000 });
  assert.equal(queue.shift(), null);
});

test("the overlay speech queue never returns an expired URL", () => {
  let now = 1_000;
  const queue = new ExpiringAudioQueue(10, () => now);

  assert.equal(queue.push({ url: "/audio/already-stale.mp3", expiresAt: 999 }), false);
  assert.equal(queue.push({ url: "/audio/queued.mp3", expiresAt: 2_000 }), true);
  now = 2_001;

  assert.equal(queue.shift(), null);
});
