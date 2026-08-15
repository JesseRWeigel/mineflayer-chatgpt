import { test } from "node:test";
import assert from "node:assert/strict";

import { recordLlmCall, llmHealth, resetLlmHealth, UNHEALTHY_AFTER } from "./health.js";

// THE BUG THIS FILE EXISTS FOR.
//
// On 2026-08-15 Ollama wedged: it answered /api/tags but never completed a chat
// request. Every strategic call timed out with UND_ERR_HEADERS_TIMEOUT, the
// brain fell back to "Planning..." and each bot chose idle. The swarm sat inert
// for hours.
//
// Nothing said so. The only evidence was an undici stack trace buried in a log
// that also carried thousands of routine lines, and the visible symptom -- bots
// not moving -- looked exactly like a navigation problem. An hour went into
// diagnosing the stuck-detector before the real cause surfaced.
//
// A brain that cannot think should say so once, loudly, rather than quietly
// pretending to make decisions.

test("a healthy run reports healthy", () => {
  resetLlmHealth();
  for (let i = 0; i < 10; i++) recordLlmCall(true);
  assert.equal(llmHealth().healthy, true);
});

test("one failure is not an outage", () => {
  resetLlmHealth();
  recordLlmCall(false);
  assert.equal(llmHealth().healthy, true, "a single timeout is noise, not an outage");
});

test("consecutive failures trip the alarm", () => {
  resetLlmHealth();
  for (let i = 0; i < UNHEALTHY_AFTER; i++) recordLlmCall(false);
  assert.equal(llmHealth().healthy, false);
  assert.equal(llmHealth().consecutiveFailures, UNHEALTHY_AFTER);
});

test("a single success clears the alarm", () => {
  resetLlmHealth();
  for (let i = 0; i < UNHEALTHY_AFTER + 3; i++) recordLlmCall(false);
  assert.equal(llmHealth().healthy, false);
  recordLlmCall(true);
  assert.equal(llmHealth().healthy, true, "the brain came back; stop shouting");
  assert.equal(llmHealth().consecutiveFailures, 0);
});

test("the alarm reports as newly-tripped exactly once", () => {
  // So the log gets one banner per outage, not one per failed call. Thousands of
  // repeated lines are how the undici trace got lost in the first place.
  resetLlmHealth();
  const trips: boolean[] = [];
  for (let i = 0; i < UNHEALTHY_AFTER + 5; i++) trips.push(recordLlmCall(false).justTripped);
  assert.equal(trips.filter(Boolean).length, 1, "exactly one banner per outage");
});

test("recovery is reported exactly once too", () => {
  resetLlmHealth();
  for (let i = 0; i < UNHEALTHY_AFTER; i++) recordLlmCall(false);
  const first = recordLlmCall(true);
  const second = recordLlmCall(true);
  assert.equal(first.justRecovered, true);
  assert.equal(second.justRecovered, false);
});

test("an intermittent failure never trips the alarm", () => {
  // Alternating success and failure is a flaky model, not a dead one.
  resetLlmHealth();
  for (let i = 0; i < 20; i++) recordLlmCall(i % 2 === 0);
  assert.equal(llmHealth().healthy, true);
});

test("the threshold is small enough to catch an outage quickly", () => {
  // Strategic decisions run about every 10s per bot, so this is under a minute.
  assert.ok(UNHEALTHY_AFTER >= 3, "too low would fire on ordinary flakiness");
  assert.ok(UNHEALTHY_AFTER <= 6, "too high leaves the swarm inert without saying so");
});
