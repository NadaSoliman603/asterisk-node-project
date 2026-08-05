/**
 * chatbot-voice — in-memory conversation history.
 *
 * Mirrors the `conversations` Map in chatbot-backend/server.js: a process-local
 * store keyed by sessionId. Swap this module for Redis/Mongo later without
 * touching the services — the public surface is intentionally tiny.
 *
 * @typedef {import('../types/index.js').ConversationState} ConversationState
 * @typedef {import('../types/index.js').VoiceMessage} VoiceMessage
 */

import { VOICE_STATE } from "../constants/index.js";
import { uid } from "../utils/index.js";

/** @type {Map<string, ConversationState>} */
const sessions = new Map();

// Keep memory bounded — same spirit as chatbot-backend's `.slice(-30)`.
const MAX_MESSAGES = 40;

/**
 * Get (or lazily create) the state for a session.
 * @param {string} sessionId
 * @param {number} country
 * @returns {ConversationState}
 */
export function getOrCreateSession(sessionId, country, userId) {
  let s = sessions.get(sessionId);
  if (!s) {
    const now = Date.now();
    s = {
      sessionId,
      country,
      // Stable user id this session belongs to — the key for LONG-TERM,
      // cross-session memory (store/memory.repository.js). Distinct from
      // sessionId, which only scopes the SHORT-TERM state below.
      userId: userId || null,
      state: VOICE_STATE.IDLE,
      messages: [],
      createdAt: now,
      updatedAt: now,
      // ── Short-term, per-SESSION state (context-manager.service.js) ──
      // Long-term user PREFERENCES live in the memory repository, keyed by
      // userId; only the current-conversation context stays here.
      summary: "", // compact conversation summary (current discussion context)
      turns: 0, // total USER turns seen this session
      tokensSinceRefresh: 0, // accumulated text-token estimate since last refresh
      lastRefreshTurn: 0, // `turns` value at the last silent session refresh
    };
    sessions.set(sessionId, s);
  }
  // Country can change between turns (header-driven) — keep it current.
  if (country) s.country = country;
  // Bind/refresh the user id (e.g. supplied on a later /session for the same id).
  if (userId) s.userId = userId;
  return s;
}

/** Update the FSM state for a session. */
export function setState(sessionId, state) {
  const s = sessions.get(sessionId);
  if (s) {
    s.state = state;
    s.updatedAt = Date.now();
  }
  return s;
}

/**
 * Append a turn to history (trimming to MAX_MESSAGES).
 * @param {string} sessionId
 * @param {Omit<VoiceMessage, "id"|"createdAt"> & Partial<Pick<VoiceMessage,"id"|"createdAt">>} message
 * @returns {VoiceMessage}
 */
export function addMessage(sessionId, message) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`addMessage: unknown session ${sessionId}`);
  /** @type {VoiceMessage} */
  const full = {
    id: message.id || uid("msg"),
    createdAt: message.createdAt || Date.now(),
    role: message.role,
    text: message.text || "",
    audioChunks: message.audioChunks,
    toolCalls: message.toolCalls,
  };
  s.messages.push(full);
  if (s.messages.length > MAX_MESSAGES) {
    s.messages = s.messages.slice(-MAX_MESSAGES);
  }
  s.updatedAt = Date.now();
  return full;
}

/** Plain-text history (user/assistant turns) — handy for /history responses. */
export function getHistory(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  return s.messages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
  }));
}

/** Drop a session entirely (on reset / disconnect cleanup if desired). */
export function clearSession(sessionId) {
  sessions.delete(sessionId);
}

/** Raw session state (or null) — used by the context manager. */
export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/** True if a session record currently exists (for /session reuse on refresh). */
export function hasSession(sessionId) {
  return sessions.has(sessionId);
}

/**
 * Shallow-merge per-session meta fields (userId / summary / turns /
 * tokensSinceRefresh / lastRefreshTurn) onto a session. No-op for unknown
 * sessions. Long-term user memory is NOT stored here — see memory.repository.js.
 *
 * @param {string} sessionId
 * @param {{ userId?: string, summary?: string, turns?: number,
 *   tokensSinceRefresh?: number, lastRefreshTurn?: number }} patch
 * @returns {ConversationState|null}
 */
export function updateSession(sessionId, patch = {}) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  Object.assign(s, patch);
  s.updatedAt = Date.now();
  return s;
}
