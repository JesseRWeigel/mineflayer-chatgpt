import { test } from "node:test";
import assert from "node:assert/strict";

import { toOpenAIRequest, fromOpenAIResponse, type ChatRequest } from "./provider.js";

const BASE: ChatRequest = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
};

test("carries model and messages through unchanged", () => {
  const body = toOpenAIRequest(BASE);
  assert.equal(body.model, "gpt-4o-mini");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

// Every decision path sends format:"json" and then parses the reply. Losing this
// in translation would turn valid decisions into parse failures.
test("json format becomes response_format", () => {
  const body = toOpenAIRequest({ ...BASE, format: "json" });
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("no response_format when json was not requested", () => {
  assert.equal(toOpenAIRequest(BASE).response_format, undefined);
});

test("num_predict maps to max_tokens", () => {
  const body = toOpenAIRequest({ ...BASE, options: { num_predict: 384 } });
  assert.equal(body.max_tokens, 384);
  assert.equal(body.num_predict, undefined, "ollama's name must not leak through");
});

test("temperature passes through, including zero", () => {
  assert.equal(toOpenAIRequest({ ...BASE, options: { temperature: 0.4 } }).temperature, 0.4);
  // 0 is falsy — a truthiness check here would silently drop a deliberate 0.
  assert.equal(toOpenAIRequest({ ...BASE, options: { temperature: 0 } }).temperature, 0);
});

// These two have no honest OpenAI equivalent. Dropping them is deliberate;
// approximating them would silently change sampling behaviour.
test("ollama-only parameters are dropped, not guessed at", () => {
  const body = toOpenAIRequest({
    ...BASE,
    think: "low",
    options: { repeat_penalty: 1.15, temperature: 0.8 },
  });
  assert.equal(body.think, undefined);
  assert.equal(body.repeat_penalty, undefined);
  assert.equal(body.frequency_penalty, undefined, "1.15 multiplicative is not 1.15 additive");
  assert.equal(body.temperature, 0.8, "the mappable option still survives");
});

test("reads the assistant text out of a completion", () => {
  const res = fromOpenAIResponse({ choices: [{ message: { role: "assistant", content: '{"action":"idle"}' } }] });
  assert.equal(res.message.content, '{"action":"idle"}');
});

// Callers do .trim()/.slice() on the result. undefined would throw several
// frames from the cause; an empty string reaches the existing "empty response"
// handling that every decision path already has.
test("a refusal or malformed reply yields empty string, never undefined", () => {
  assert.equal(fromOpenAIResponse({ choices: [{ message: { content: null } }] }).message.content, "");
  assert.equal(fromOpenAIResponse({ choices: [] }).message.content, "");
  assert.equal(fromOpenAIResponse({}).message.content, "");
  assert.equal(fromOpenAIResponse(null).message.content, "");
});
