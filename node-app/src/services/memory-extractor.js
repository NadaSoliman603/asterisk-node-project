/**
 * chatbot-voice — preference extraction + conversation summarization.
 *
 * Two pure-ish helpers the context manager calls. Both run OFF the audio path
 * (after a finished transcript is reported) and degrade gracefully: if the LLM
 * is disabled/unavailable or errors, extraction falls back to deterministic
 * heuristics and summarization returns the previous summary unchanged.
 *
 * The structured shape we extract (single source of truth: MEMORY_FIELDS):
 *   { area, budget, unitType, category, preferredDeveloper, paymentPreference, language }
 */

import {
  MEMORY_LLM_ENABLED,
  MEMORY_FIELDS,
} from "../constants/index.js";
import { chatJSON, chat, llmAvailable } from "./llm.js";
import { logger, detectLanguage } from "../utils/index.js";

const log = logger("memory");

const EXTRACT_SYSTEM = `You extract a real-estate buyer's stable preferences from ONE message they just spoke to a voice assistant. The user speaks Egyptian Arabic or English.

Return a JSON object with ONLY the fields you can determine with confidence FROM THIS MESSAGE. Omit any field the message does not mention. If the message states nothing useful, return {}.

Fields (use these exact keys):
- area: the location/district the user wants, written as they said it (e.g. "التجمع", "New Cairo", "الشيخ زايد").
- budget: total budget as an INTEGER number of Egyptian pounds. Convert spoken amounts: "5 مليون" / "٥ مليون" / "5 million" -> 5000000; "نص مليون" -> 500000; "750 الف" -> 750000.
- unitType: the unit kind/sub-type (e.g. "apartment", "شقة", "villa", "فيلا", "studio", "duplex", "twin", "townhouse").
- category: the property category if distinct from unitType (e.g. "Apartment", "Villa", "Commercial", "Chalet").
- preferredDeveloper: a developer/company name the user prefers or asks about (e.g. "سوديك", "Mountain View", "مدينة مصر").
- paymentPreference: how they want to pay (e.g. "long installments", "تقسيط طويل", "low down payment", "مقدم قليل", "cash").

Rules:
- Only capture preferences the user expresses about what THEY want — ignore the assistant's suggestions.
- Never invent values. Never include a field set to null or empty.
- budget must be a plain number (no currency text, no commas).`;

/**
 * Extract a preference PATCH from one user message.
 *
 * @param {string} message               the user's latest transcript
 * @param {Record<string, any>} current   the memory we already have (for context)
 * @returns {Promise<Record<string, any>>} only the fields to update (may be {})
 */
export async function extractUserMemory(message, current = {}) {
  const text = (message || "").trim();
  if (!text) return {};

  // Language is cheap + always available — set it deterministically every turn.
  /** @type {Record<string, any>} */
  const patch = { language: detectLanguage(text) };

  if (!MEMORY_LLM_ENABLED || !llmAvailable()) {
    return { ...patch, ...heuristicExtract(text) };
  }

  try {
    const known = JSON.stringify(pickKnown(current));
    const raw = await chatJSON({
      system: EXTRACT_SYSTEM,
      user: `Already known (for context, do not repeat unless the user changes it): ${known}\n\nUser message: """${text}"""`,
      maxTokens: 200,
    });
    return { ...patch, ...sanitize(raw) };
  } catch (e) {
    log.warn(`extract failed, using heuristics: ${String(e.message || e)}`);
    return { ...patch, ...heuristicExtract(text) };
  }
}

const SUMMARY_SYSTEM = `You maintain a running memory of a real-estate voice conversation. Produce a COMPACT summary of ONLY the important, durable facts a sales assistant must remember — what the user is looking for and key decisions/constraints.

Format as short bullet lines (max 6 bullets), no preamble, no closing. Each bullet one short fact. Prefer the user's language (Arabic if the conversation is Arabic). Omit small talk, greetings, tool mechanics, and anything not useful for continuing the search. Do not invent facts.`;

/**
 * Summarize the conversation into a compact set of facts.
 *
 * @param {Array<{role: string, text: string}>} messages
 * @param {Record<string, any>} memory   current structured memory (grounds the summary)
 * @param {string} [previousSummary]     returned unchanged if summarization is unavailable
 * @returns {Promise<string>}
 */
export async function summarizeConversation(messages = [], memory = {}, previousSummary = "") {
  if (!MEMORY_LLM_ENABLED || !llmAvailable()) return previousSummary;

  const transcript = messages
    .filter((m) => m && m.text)
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.text}`)
    .join("\n");
  if (!transcript) return previousSummary;

  const known = JSON.stringify(pickKnown(memory));
  const text = await chat({
    system: SUMMARY_SYSTEM,
    user: `Structured preferences so far: ${known}\n\nConversation:\n${transcript}`,
    maxTokens: 300,
    temperature: 0.2,
  });
  return text || previousSummary;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Keep only the non-empty known fields (so the prompt context stays small). */
function pickKnown(memory = {}) {
  const out = {};
  for (const f of MEMORY_FIELDS) {
    const v = memory?.[f];
    if (v !== null && v !== undefined && v !== "") out[f] = v;
  }
  return out;
}

/** Keep only recognized fields with sane, non-empty values from an LLM blob. */
function sanitize(raw = {}) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const f of MEMORY_FIELDS) {
    if (f === "language") continue; // set deterministically by the caller
    let v = raw[f];
    if (v === null || v === undefined || v === "") continue;
    if (f === "budget") {
      const n = toNumber(v);
      if (n && n > 0) out.budget = n;
      continue;
    }
    if (typeof v === "string") v = v.trim();
    if (v) out[f] = v;
  }
  return out;
}

function toNumber(v) {
  if (typeof v === "number") return Math.round(v);
  const n = parseFloat(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

// ── Deterministic fallback (no network) ──────────────────────────────────────
// Covers the highest-signal, lowest-ambiguity cases the spec calls out: budget
// in millions/thousands and language. Everything else is left to the LLM path.
const MILLION_RE = /(\d+(?:[.,]\d+)?)\s*(?:m\b|million|مليون|ملايين)/i;
const THOUSAND_RE = /(\d+(?:[.,]\d+)?)\s*(?:k\b|thousand|الف|ألف|آلاف)/i;
const PLAIN_BIG_RE = /(\d[\d,]{5,})/; // a bare 6+ digit number, e.g. "5000000"

/** Normalize Arabic-Indic digits to ASCII so the regexes above match. */
function normalizeDigits(s) {
  return (s || "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
}

function heuristicExtract(message) {
  const text = normalizeDigits(message);
  const out = {};
  let m;
  if ((m = MILLION_RE.exec(text))) {
    out.budget = Math.round(parseFloat(m[1].replace(",", ".")) * 1_000_000);
  } else if ((m = THOUSAND_RE.exec(text))) {
    out.budget = Math.round(parseFloat(m[1].replace(",", ".")) * 1_000);
  } else if ((m = PLAIN_BIG_RE.exec(text))) {
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    if (n >= 100_000) out.budget = n;
  }
  return out;
}
