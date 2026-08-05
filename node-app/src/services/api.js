/**
 * chatbot-voice — backend API communication layer.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ BACKEND INTEGRATION POINT                                                 │
 * │ This is where the voice feature talks to the SAME Byit backend the text   │
 * │ chatbot uses. We deliberately reuse `chatbot-backend/cache.js` — the      │
 * │ stateless Byit API client — so there is ONE source of truth for endpoints │
 * │ (properties / companies / locations / categories) and zero duplication.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * No mock data: every function here results in a real GET against
 * https://api.app.byitcorp.com/api/v1/* via the existing client.
 *
 * @typedef {import('../types/index.js').BackendSearchRequest} BackendSearchRequest
 * @typedef {import('../types/index.js').BackendSearchResponse} BackendSearchResponse
 */

import {
  fetchRawProperties,
  fetchCompanies,
  rememberRawForSession,
  clearRawForSession,
  getRawForSession,
  stripProperty,
} from "../backend/cache.js";
import { logger } from "../utils/index.js";

const log = logger("api");

/**
 * Fetch raw properties straight from Byit (server-side filtered).
 * Thin pass-through so callers don't reach across packages directly.
 * @param {{country?: number, type?: string, [k:string]: any}} filters
 */
export async function fetchProperties(filters = {}) {
  log.info("fetchProperties", filters);
  return fetchRawProperties(filters);
}

/**
 * Fetch developer companies for a country.
 * @param {{country?: number}} filters
 */
export async function fetchDevelopers(filters = {}) {
  log.info("fetchDevelopers", filters);
  return fetchCompanies(filters);
}

// Re-export the per-session raw cache helpers so the realtime/tool layer can
// collect property media after a search, exactly like the text chatbot does
// in `_collectPropertyImages`.
export {
  rememberRawForSession,
  clearRawForSession,
  getRawForSession,
  stripProperty,
};
