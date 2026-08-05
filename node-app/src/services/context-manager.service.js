/**
 * chatbot-voice — Context Manager.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THE BRAIN OF LONG-CONVERSATION STABILITY                                  │
 * │ The Realtime model forgets / drifts as its conversation grows. We move    │
 * │ memory OUT of OpenAI and into the backend:                                │
 * │   • structured user preferences (area, budget, unitType, …) extracted     │
 * │     after every user turn,                                                │
 * │   • a compact conversation summary regenerated as the talk grows,         │
 * │   • a turn/token budget that decides WHEN the browser should silently     │
 * │     re-mint its Realtime session.                                         │
 * │                                                                            │
 * │ The model never relies on old conversation history for these facts — they │
 * │ are re-injected into the session instructions on every mint/refresh, so a │
 * │ fresh session resumes exactly where the last one left off.                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Two-layer memory model:
 *   • LONG-TERM, per-USER preferences  → store/memory.repository.js (durable,
 *     keyed by userId, survives sessions/reconnects/refreshes).
 *   • SHORT-TERM, per-SESSION context  → conversationStore (summary + turn/token
 *     budget for the CURRENT conversation only).
 *   These are kept strictly separate (the summary is never persisted as user
 *   memory, and vice-versa).
 *
 * Turn lifecycle + context hooks the server calls:
 *   recordUserTurn() / recordAssistantTurn() — drive memory + budgets
 *   shouldRefreshSession() — decide if the Realtime session should be re-minted
 *   generateSummary()      — (re)build + store the CURRENT conversation summary
 *   buildRealtimeContext() — compose instructions (prompt + user memory + summary + recent)
 *   markRefreshed() / getDebugSnapshot()
 *
 * Long-term memory CRUD itself lives in the repository
 * (getUserMemory/saveUserMemory/updateUserMemory/deleteUserMemory).
 */

import {
  EGYPT_COUNTRY,
  CONTEXT_MAX_TURNS,
  CONTEXT_TOKEN_WINDOW,
  CONTEXT_TOKEN_THRESHOLD,
  CONTEXT_AUDIO_TOKENS_PER_TURN,
  CONTEXT_RECENT_MESSAGES,
  CONTEXT_SUMMARY_MIN_MESSAGES,
} from "../constants/index.js";
import {
  getOrCreateSession,
  getSession,
  updateSession,
} from "../store/conversationStore.js";
import {
  getUserMemory,
  saveUserMemory,
  updateUserMemory,
  deleteUserMemory,
} from "../store/memory.repository.js";
import { extractUserMemory, summarizeConversation } from "./memory-extractor.js";
import { getVoiceSystemPrompt, buildContextSection } from "../prompts.js";
import { logger } from "../utils/index.js";

const log = logger("context");

// Constant cost of the base system prompt — computed once. Included in the
// usage estimate so the "% of window" figure reflects the real prompt weight.
const BASE_PROMPT_TOKENS = estimateTokens(getVoiceSystemPrompt());

/** Rough token estimate from character count (~4 chars/token). Approximate by
 *  design — audio tokens are invisible to us; this only needs to be monotonic. */
function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

/**
 * Estimated tokens in the model's CURRENT context (since the last refresh):
 * base prompt + summary + accumulated turn text + per-turn audio overhead.
 * @param {import('../store/conversationStore.js')} s  session state
 */
function estimateContextTokens(s) {
  const turnsSinceRefresh = Math.max(0, s.turns - s.lastRefreshTurn);
  return (
    BASE_PROMPT_TOKENS +
    estimateTokens(s.summary) +
    s.tokensSinceRefresh +
    turnsSinceRefresh * CONTEXT_AUDIO_TOKENS_PER_TURN
  );
}

// ── User identity ────────────────────────────────────────────────────────────

/** The userId a session belongs to. Falls back to the sessionId so memory keying
 *  always works even if the client never sent a stable id (degrades to
 *  session-scoped memory rather than failing). */
function userIdForSession(sessionId) {
  const s = getSession(sessionId);
  return s?.userId || sessionId;
}

// ── Turn lifecycle ─────────────────────────────────────────────────────────

/**
 * Record a finished USER turn: count it, grow the token estimate, extract
 * long-term preferences, and MERGE them into the user's persistent memory.
 * Returns the live refresh decision so the caller (server /history) can tell
 * the browser whether to silently re-mint.
 *
 * @param {string} sessionId
 * @param {string} text  the user's transcript
 */
export async function recordUserTurn(sessionId, text) {
  const s = getOrCreateSession(sessionId, EGYPT_COUNTRY);
  const userId = s.userId || sessionId;
  s.turns += 1;
  s.tokensSinceRefresh += estimateTokens(text);

  const memoryBefore = getUserMemory(userId);

  // Extract LONG-TERM preferences (LLM with heuristic fallback). Awaited so
  // memory is current before the refresh decision — but it can never block: the
  // extractor is hard-timeout-bounded and returns {} on any failure.
  let extracted = {};
  try {
    extracted = await extractUserMemory(text, memoryBefore);
  } catch (e) {
    log.warn(`extract threw: ${String(e.message || e)}`);
  }
  // Merge (never blind-overwrite) into the user's durable memory.
  const { after: memoryAfter, updatedFields } = updateUserMemory(userId, extracted);

  const decision = shouldRefreshSession(sessionId);
  // Memory debug log (requested shape): userId, before, extracted, after, fields.
  log.info(
    JSON.stringify({
      sessionId,
      userId,
      event: "user_turn",
      turns: s.turns,
      estimatedTokens: estimateContextTokens(s),
      memoryBefore,
      extractedMemory: extracted,
      memoryAfter,
      updatedFields,
      refreshTriggered: decision.refresh,
      refreshReason: decision.reason,
    })
  );
  return decision;
}

/** Record a finished ASSISTANT turn (token accounting only). */
export function recordAssistantTurn(sessionId, text) {
  const s = getSession(sessionId);
  if (!s) return;
  s.tokensSinceRefresh += estimateTokens(text);
  s.updatedAt = Date.now();
}

// ── Refresh decision ─────────────────────────────────────────────────────────

/**
 * Decide whether the Realtime session should be silently re-minted: too many
 * turns since the last refresh, OR estimated context usage over the threshold.
 *
 * @param {string} sessionId
 * @returns {{ refresh: boolean, reason: string|null, turns: number,
 *   turnsSinceRefresh: number, estimatedTokens: number, usage: number }}
 */
export function shouldRefreshSession(sessionId) {
  const s = getSession(sessionId);
  if (!s) {
    return { refresh: false, reason: null, turns: 0, turnsSinceRefresh: 0, estimatedTokens: 0, usage: 0 };
  }
  const turnsSinceRefresh = Math.max(0, s.turns - s.lastRefreshTurn);
  const estimatedTokens = estimateContextTokens(s);
  const usage = estimatedTokens / CONTEXT_TOKEN_WINDOW;

  let reason = null;
  if (turnsSinceRefresh >= CONTEXT_MAX_TURNS) reason = "max_turns";
  else if (usage >= CONTEXT_TOKEN_THRESHOLD) reason = "token_threshold";

  return {
    refresh: Boolean(reason),
    reason,
    turns: s.turns,
    turnsSinceRefresh,
    estimatedTokens,
    usage: Number(usage.toFixed(3)),
  };
}

// ── Summary ──────────────────────────────────────────────────────────────────

/**
 * (Re)generate the conversation summary from history + memory and store it.
 * No-op (returns the existing summary) until there are enough turns to bother.
 *
 * @param {string} sessionId
 * @returns {Promise<string>}
 */
export async function generateSummary(sessionId) {
  const s = getSession(sessionId);
  if (!s) return "";
  if (s.messages.length < CONTEXT_SUMMARY_MIN_MESSAGES) return s.summary;

  const messages = s.messages.map((m) => ({ role: m.role, text: m.text }));
  const memory = getUserMemory(s.userId || sessionId);
  const summary = await summarizeConversation(messages, memory, s.summary);
  if (summary && summary !== s.summary) {
    updateSession(sessionId, { summary });
    log.info(JSON.stringify({ sessionId, event: "summary_created", length: summary.length }));
  }
  return summary;
}

// ── Context assembly ───────────────────────────────────────────────────────

/**
 * Build the Realtime session instructions for a mint/refresh: base system
 * prompt + authoritative user memory + conversation summary + the most recent
 * turns. This is what gets baked into the ephemeral token, so the model knows
 * everything important the moment the (new) peer connection opens — WITHOUT
 * relying on OpenAI's accumulated conversation history.
 *
 * Regenerates the summary first so a refresh always carries fresh facts.
 *
 * @param {string} sessionId
 * @returns {Promise<{ sessionId: string, userId: string, instructions: string,
 *   memory: Record<string, any>, summary: string,
 *   recentMessages: Array<{role: string, text: string}> }>}
 */
export async function buildRealtimeContext(sessionId) {
  const s = getOrCreateSession(sessionId, EGYPT_COUNTRY);
  const userId = s.userId || sessionId;

  // Refresh the summary if the conversation is long enough to warrant one.
  await generateSummary(sessionId);

  const recentMessages = s.messages
    .slice(-CONTEXT_RECENT_MESSAGES)
    .map((m) => ({ role: m.role, text: m.text }));

  // LONG-TERM user memory (persistent) + SHORT-TERM summary (this session) are
  // injected as separate sections so the model gets durable preferences AND the
  // current discussion context without conflating them.
  const memory = getUserMemory(userId);
  const instructions =
    getVoiceSystemPrompt() +
    buildContextSection({ memory, summary: s.summary, recentMessages });

  return { sessionId, userId, instructions, memory, summary: s.summary, recentMessages };
}

/**
 * Mark a session as just-refreshed: reset the per-session token budget and the
 * turn baseline so the next refresh decision counts from here.
 */
export function markRefreshed(sessionId) {
  const s = getSession(sessionId);
  if (!s) return;
  updateSession(sessionId, { lastRefreshTurn: s.turns, tokensSinceRefresh: 0 });
  log.info(JSON.stringify({ sessionId, event: "session_refreshed", atTurn: s.turns }));
}

/** Structured debug snapshot (the shape requested in the spec). */
export function getDebugSnapshot(sessionId) {
  const s = getSession(sessionId);
  if (!s) return { sessionId, exists: false };
  const userId = s.userId || sessionId;
  const decision = shouldRefreshSession(sessionId);
  return {
    sessionId,
    userId,
    turns: s.turns,
    turnsSinceRefresh: decision.turnsSinceRefresh,
    estimatedTokens: decision.estimatedTokens,
    usage: decision.usage,
    memory: getUserMemory(userId), // long-term, persistent
    summary: s.summary, // short-term, this session
    refreshTriggered: decision.refresh,
    refreshReason: decision.reason,
  };
}

// Re-export the repository CRUD so callers that already depend on the context
// manager have one import surface for the whole memory system.
export { getUserMemory, saveUserMemory, updateUserMemory, deleteUserMemory };
