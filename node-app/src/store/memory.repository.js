/**
 * chatbot-voice — persistent USER memory repository.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ LONG-TERM, USER-SCOPED MEMORY (ChatGPT-style)                             │
 * │ This is the durable half of the memory system. It is keyed by `userId`    │
 * │ (NOT sessionId), so a user's preferences survive across:                  │
 * │   • closing the app / refreshing the browser,                             │
 * │   • creating a brand-new Realtime session,                                │
 * │   • reconnecting after a drop.                                            │
 * │                                                                            │
 * │ It stores ONLY stable preferences (area, budget, unitType, …) — never the │
 * │ short-term conversation summary, which stays per-session in               │
 * │ conversationStore. The context manager injects this memory into every     │
 * │ minted Realtime session so the model "remembers" the user.                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * STORAGE BACKEND
 *   The default backend is an in-memory Map snapshotted to a JSON file
 *   (USER_MEMORY_FILE) so memory also survives a server restart. To move to
 *   Redis/Mongo, replace `backend` with an object exposing the same
 *   get/set/delete/entries — nothing else in the codebase changes.
 *
 * Public surface (as requested):
 *   saveUserMemory(userId, data)    — replace a user's memory wholesale
 *   getUserMemory(userId)           — read (always a full record, nulls filled)
 *   updateUserMemory(userId, patch) — MERGE a patch (never blind-overwrite)
 *   deleteUserMemory(userId)        — forget a user
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MEMORY_FIELDS, USER_MEMORY_FILE } from "../constants/index.js";
import { logger } from "../utils/index.js";

const log = logger("memory-repo");

/** A full, empty memory record (every known field present, null). */
function emptyMemory() {
  /** @type {Record<string, any>} */
  const m = {};
  for (const f of MEMORY_FIELDS) m[f] = null;
  return m;
}

/** Keep only recognized, non-empty fields from arbitrary input. */
function sanitize(data) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!data || typeof data !== "object") return out;
  for (const f of MEMORY_FIELDS) {
    const v = data[f];
    if (v !== null && v !== undefined && v !== "") out[f] = v;
  }
  return out;
}

// ── Pluggable storage backend ────────────────────────────────────────────────
// Swap this object for a Redis/Mongo-backed one with the same shape to persist
// elsewhere. The repository functions below never touch the Map directly.
const map = new Map(); // userId -> memory record

const backend = {
  get: (userId) => map.get(userId) || null,
  set: (userId, data) => {
    map.set(userId, data);
    schedulePersist();
  },
  delete: (userId) => {
    map.delete(userId);
    schedulePersist();
  },
  entries: () => map.entries(),
  size: () => map.size,
};

// ── File snapshot persistence (default backend) ──────────────────────────────
let persistTimer = null;

/** Debounced write of the whole map to USER_MEMORY_FILE. Best-effort. */
function schedulePersist() {
  if (!USER_MEMORY_FILE || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const obj = Object.fromEntries(backend.entries());
      writeFileSync(USER_MEMORY_FILE, JSON.stringify(obj), "utf8");
    } catch (e) {
      log.warn(`persist failed: ${String(e.message || e)}`);
    }
  }, 500);
}

/** Load the snapshot once at startup so memory survives a restart. */
function loadSnapshot() {
  if (!USER_MEMORY_FILE) return;
  try {
    if (!existsSync(USER_MEMORY_FILE)) return;
    const obj = JSON.parse(readFileSync(USER_MEMORY_FILE, "utf8"));
    for (const [userId, data] of Object.entries(obj || {})) {
      map.set(userId, { ...emptyMemory(), ...sanitize(data) });
    }
    log.info(`loaded ${backend.size()} user memories from ${USER_MEMORY_FILE}`);
  } catch (e) {
    log.warn(`snapshot load failed: ${String(e.message || e)}`);
  }
}
loadSnapshot();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read a user's full memory record. Always returns every known field (unknown
 * users / missing fields come back as null), so callers never special-case.
 * @param {string} userId
 * @returns {Record<string, any>}
 */
export function getUserMemory(userId) {
  if (!userId) return emptyMemory();
  return { ...emptyMemory(), ...(backend.get(userId) || {}) };
}

/**
 * Replace a user's memory wholesale (sanitized). Prefer updateUserMemory() for
 * incremental updates — this is for explicit set/import.
 * @param {string} userId
 * @param {Record<string, any>} data
 * @returns {Record<string, any>} the stored record
 */
export function saveUserMemory(userId, data) {
  if (!userId) return emptyMemory();
  backend.set(userId, { ...emptyMemory(), ...sanitize(data) });
  return getUserMemory(userId);
}

/**
 * MERGE a patch into a user's memory — never a blind overwrite. Only non-empty
 * fields in the patch are applied; everything else is preserved.
 *
 * @param {string} userId
 * @param {Record<string, any>} patch
 * @returns {{ before: Record<string, any>, after: Record<string, any>, updatedFields: string[] }}
 */
export function updateUserMemory(userId, patch) {
  const before = getUserMemory(userId);
  if (!userId) return { before, after: before, updatedFields: [] };

  const after = { ...before };
  const updatedFields = [];
  const clean = sanitize(patch);
  for (const [k, v] of Object.entries(clean)) {
    if (after[k] !== v) {
      after[k] = v;
      updatedFields.push(k);
    }
  }
  if (updatedFields.length) backend.set(userId, after);
  return { before, after, updatedFields };
}

/**
 * Forget a user entirely ("delete my memory").
 * @param {string} userId
 */
export function deleteUserMemory(userId) {
  if (!userId) return;
  backend.delete(userId);
  log.info(`deleted memory for user ${userId}`);
}
