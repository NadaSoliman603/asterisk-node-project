/**
 * chatbot-voice — small, dependency-free helpers shared across services.
 */

/** Namespaced, greppable logger — matches the "[scope] message" style used
 *  throughout chatbot-backend so logs interleave cleanly. */
export function logger(scope) {
  const tag = `[voice:${scope}]`;
  return {
    info: (...a) => console.log(tag, ...a),
    warn: (...a) => console.warn(tag, ...a),
    error: (...a) => console.error(tag, ...a),
  };
}

/** Monotonic-ish unique id. Avoids `Math.random`-only collisions by mixing in
 *  a process-local counter. */
let _seq = 0;
export function uid(prefix = "id") {
  _seq = (_seq + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

/** Detect Arabic so we can hint the model which language to *speak* back.
 *  Same Unicode range chatbot-backend uses in `detectLanguage`. */
export function detectLanguage(text) {
  return /[؀-ۿ]/.test(text || "") ? "Arabic" : "English";
}

/** Safe JSON parse — returns `fallback` instead of throwing. */
export function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/** True for the values the browser/client may legitimately send as a country. */
export function normalizeCountry(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
