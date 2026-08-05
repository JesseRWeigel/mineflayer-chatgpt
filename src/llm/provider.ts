// src/llm/provider.ts
// One chat() call the rest of the codebase uses, backed by either Ollama or any
// OpenAI-compatible endpoint.
//
// The six call sites in index.ts all send the same shape and all read
// response.message.content, so the adapter speaks Ollama's vocabulary and
// translates for OpenAI rather than the other way round. That keeps the default
// path byte-identical: with LLM_PROVIDER unset, requests go straight to the
// Ollama client exactly as before.

import { Ollama } from "ollama";
import { config } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Ollama's sampling knobs, as used by the existing call sites. */
export interface ChatOptions {
  temperature?: number;
  repeat_penalty?: number;
  num_predict?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Ollama-only reasoning control. Ignored by OpenAI-compatible endpoints. */
  think?: boolean | "low" | "medium" | "high";
  format?: "json";
  options?: ChatOptions;
}

export interface ChatResponse {
  message: { content: string };
}

const ollama = new Ollama({ host: config.ollama.host });

/** Body for POST {baseUrl}/chat/completions.
 *
 *  Pure and exported so the mapping is testable without a network or a key.
 *
 *  Two Ollama parameters have no honest OpenAI equivalent and are dropped rather
 *  than approximated:
 *    think          Ollama-specific reasoning toggle. OpenAI reasoning models
 *                   take a different parameter with different semantics, and
 *                   guessing a mapping would silently change behaviour.
 *    repeat_penalty Multiplicative (1.15 here). OpenAI's frequency_penalty is
 *                   additive on a -2..2 scale, so the numbers are not
 *                   interchangeable and a naive copy would be wrong.
 */
export function toOpenAIRequest(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
  };
  if (req.format === "json") body.response_format = { type: "json_object" };
  if (req.options?.temperature !== undefined) body.temperature = req.options.temperature;
  if (req.options?.num_predict !== undefined) body.max_tokens = req.options.num_predict;
  return body;
}

/** Pull the assistant text out of an OpenAI chat completion.
 *
 *  Gateways vary: some omit `content` on a refusal, some send null. Callers here
 *  do .trim()/.slice() on the result, so an empty string is the only safe miss
 *  value — undefined would turn a bad response into a TypeError several frames
 *  away from the cause. */
export function fromOpenAIResponse(data: unknown): ChatResponse {
  const choice = (data as { choices?: Array<{ message?: { content?: string | null } }> })?.choices?.[0];
  return { message: { content: choice?.message?.content ?? "" } };
}

async function openAIChat(req: ChatRequest): Promise<ChatResponse> {
  const { baseUrl, apiKey } = config.openai;
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(toOpenAIRequest(req)),
  });

  if (!res.ok) {
    // Include the body. A bare "401" sends people hunting through config; the
    // provider's own message usually names the problem outright.
    const detail = await res.text().catch(() => "");
    throw new Error(
      `OpenAI request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
    );
  }

  return fromOpenAIResponse(await res.json());
}

/** Send a chat request to whichever provider is configured. */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  if (config.llm.provider === "openai") return openAIChat(req);
  return (await ollama.chat({ ...req, stream: false })) as ChatResponse;
}

/** Fail at startup, not on the first decision.
 *
 *  A missing key otherwise surfaces as a 401 inside the first strategic query,
 *  where it is caught by the same handler that covers ordinary LLM hiccups and
 *  the bots quietly fall back instead of reporting a misconfiguration. */
export function assertProviderConfigured(): void {
  if (config.llm.provider !== "openai") return;
  if (!config.openai.apiKey) {
    throw new Error(
      "LLM_PROVIDER=openai but OPENAI_API_KEY is not set. " +
        "Add it to .env, or unset LLM_PROVIDER to use local Ollama.",
    );
  }
  // No default model on purpose — see config.ts. Naming one here would rot the
  // same way, so say what to do instead of guessing on the user's behalf.
  if (!config.openai.model) {
    throw new Error(
      "LLM_PROVIDER=openai but OPENAI_MODEL is not set. " +
        "Model IDs change often, so pick a current one from your provider " +
        `(OpenAI: curl ${config.openai.baseUrl}/models -H "Authorization: Bearer $OPENAI_API_KEY"). ` +
        "See the OpenAI section of the README for examples.",
    );
  }
}
