/**
 * chatbot-voice — minimal OpenAI Chat Completions client.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ OFF-AUDIO-PATH LLM CALLS                                                  │
 * │ This is NOT the Realtime API. It's a tiny wrapper around the standard     │
 * │ /v1/chat/completions endpoint, used by the context manager for two cheap, │
 * │ asynchronous jobs that never touch the WebRTC audio stream:               │
 * │   • extracting structured user preferences from a finished transcript,    │
 * │   • summarizing the conversation into a compact set of facts.             │
 * │ It reuses the SAME OpenAI key as the Realtime session (no new secret).    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Every call is hard-bounded by MEMORY_LLM_TIMEOUT_MS and returns a safe empty
 * value on ANY failure (timeout, network, non-200, bad JSON) — the memory layer
 * is an enhancement, never a hard dependency.
 */

import {
  OPENAI_REALTIME_API_KEY,
  OPENAI_CHAT_COMPLETIONS_URL,
  MEMORY_LLM_MODEL,
  MEMORY_LLM_TIMEOUT_MS,
} from "../constants/index.js";
import { logger, safeJsonParse } from "../utils/index.js";

const log = logger("llm");

/** True when we actually have a key to call OpenAI with. */
export function llmAvailable() {
  return Boolean(OPENAI_REALTIME_API_KEY);
}

/**
 * Low-level chat completion. Returns the assistant message string, or "" on any
 * failure. Never throws.
 *
 * @param {Object} opts
 * @param {string} opts.system
 * @param {string} opts.user
 * @param {boolean} [opts.json]         request a JSON object response
 * @param {number}  [opts.temperature]
 * @param {number}  [opts.maxTokens]
 * @param {string}  [opts.model]
 * @returns {Promise<string>}
 */
export async function chat({
  system,
  user,
  json = false,
  temperature = 0,
  maxTokens = 400,
  model = MEMORY_LLM_MODEL,
}) {
  if (!llmAvailable()) return "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMORY_LLM_TIMEOUT_MS);
  try {
    const resp = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_REALTIME_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      log.warn(`chat ${model} failed: ${resp.status} ${detail.slice(0, 200)}`);
      return "";
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    log.warn(`chat ${model} error: ${String(e.message || e)}`);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat completion that MUST return a JSON object. Returns the parsed object, or
 * `fallback` ({} by default) on any failure.
 *
 * @param {Object} opts  same as chat(), minus `json`
 * @param {Record<string, any>} [fallback]
 * @returns {Promise<Record<string, any>>}
 */
export async function chatJSON(opts, fallback = {}) {
  const raw = await chat({ ...opts, json: true });
  if (!raw) return fallback;
  return safeJsonParse(raw, fallback);
}
