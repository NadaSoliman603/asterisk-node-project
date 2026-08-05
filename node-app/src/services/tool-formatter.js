/**
 * chatbot-voice — tool-output formatter.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ KEEP THE MODEL'S CONTEXT SMALL                                            │
 * │ Raw Byit search results are large (full project objects, every unit, all  │
 * │ sales contacts, media). Feeding that verbatim into a long voice           │
 * │ conversation is the main driver of context bloat and drift. Before a tool │
 * │ result reaches the model we strip it to ONLY what the voice agent is       │
 * │ allowed to say (see PROPERTY RESPONSE STYLE in prompts.js):                │
 * │   • developer name   • booth number                                       │
 * │   • minimum down payment   • longest payment duration                     │
 * │   • light matching info (category / location / a sales contact)           │
 * │ Project names and unit details are intentionally DROPPED — the prompt      │
 * │ forbids speaking them, so the model never needs them in context.          │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Only `search_properties` is reshaped (the other tools already return compact
 * { id, name } lists). Unknown tools and unparseable payloads pass through
 * untouched, so this is always safe to call.
 */

import { logger, safeJsonParse } from "../utils/index.js";

const log = logger("tool-fmt");

/**
 * @param {string} name           tool name
 * @param {string} outputJson     the tool's model-facing JSON string
 * @returns {string}              a (usually smaller) JSON string
 */
export function formatToolOutput(name, outputJson) {
  if (name !== "search_properties") return outputJson;

  const data = safeJsonParse(outputJson, null);
  if (!data || !Array.isArray(data.properties)) return outputJson;

  let properties = data.properties.map(formatProperty);

  // When the user specified a down-payment cash budget, re-sort the developer
  // list by PROXIMITY: developers whose required down payment is closest (but
  // not above) the user's budget come first. Developers without computable
  // required down payment (missing price or percentage) go to the end.
  const userCash = data.downPaymentEligibility?.cash ?? 0;
  if (userCash > 0) {
    properties = sortByDownPaymentProximity(properties, userCash);
  }

  const out = {
    mandatory_output_count: properties.length,
    total_matching: data.total_matching,
    returned: data.returned,
    currentPage: data.currentPage,
    pageCount: data.pageCount,
    propertiesCount: data.propertiesCount,
    has_more: data.has_more,
    // Pre-deduped developers list for TTS/model consumption.
    // Keep legacy `name` and always expose explicit English `name_en`.
    developers: normalizeDevelopersForTts(data.developers),
    properties,
  };
  if (data.error) out.error = data.error;
  if (data.message) out.message = data.message;

  // Developer ranking by payment conditions. Only attached when 2+ distinct
  // developers are present (a comparison needs more than one), and only for
  // dimensions where real data exists — see buildDeveloperComparison.
  const comparison = buildDeveloperComparison(properties);
  if (comparison) out.comparison = comparison;

  // Down-payment eligibility (computed in the tool from real unit prices) — pass
  // it through so the agent can tell the user which units they can reserve.
  if (data.downPaymentEligibility) out.downPaymentEligibility = data.downPaymentEligibility;

  const compact = JSON.stringify(out);
  log.info(
    `search_properties output trimmed ${outputJson.length} → ${compact.length} chars (${data.returned ?? 0} props)`
  );

  return compact;
}

/** Reduce one property to the few fields the voice agent may actually use. */
function formatProperty(p) {
  const c = p.company || {};
  const proj = p.project || {};
  const out = {
    developer: c.name_en || null,
    name_en: c.name_en || null,
    boothNumber: c.boothNumber ?? null,
    // Down payment is a percent string/number on the raw record.
    minDownPayment: p.downPaymentMin ?? p.downPayment ?? null,
    maxDownPayment: p.downPaymentMax ?? null,
    // Installment duration in years — both ends of the developer's range so the
    // agent can answer "longest plan?" or "minimum?" (they're equal when the
    // developer has a single plan).
    longestPaymentDuration: p.installmentDurationMax ?? p.installmentDuration ?? null,
    shortestPaymentDuration: p.installmentDurationMin ?? p.installmentDuration ?? null,
  };

  // Project name.
  const projName = proj.name || proj.name_en || null;
  if (projName) out.projectName = projName;

  // Listing category — describes the API classification only.
  // NEVER use this to determine what unit types exist inside the project.
  const category = p.category?.categoryName_en;
  if (category) out.listingCategory = category;

  // Starting price — minimum across ALL available units regardless of listing
  // category. listingCategory must not restrict which unit arrays are checked
  // because some projects (e.g. chalets) store units in a different array than
  // the category name implies (TOWN/TWIN/STAND-ALONE live in `villas`).
  let minPrice = null;
  const priceByType = {};
  for (const key of ["apartments", "villas", "mall"]) {
    for (const u of proj[key] || []) {
      if (u.available === true && u.price > 0) {
        if (minPrice === null || u.price < minPrice) minPrice = u.price;
        if (u.type) {
          if (!priceByType[u.type] || u.price < priceByType[u.type]) {
            priceByType[u.type] = u.price;
          }
        }
      }
    }
  }
  if (minPrice !== null) out.startingPrice = minPrice;
  // Per-type minimum prices — lets the model extract the exact price for the
  // unit type the user requested without guessing or cross-type contamination.
  if (Object.keys(priceByType).length > 0) out.priceByType = priceByType;

  const location = p.location?.name;
  if (location) out.location = location;

  // Available unit types for this developer — lets the agent confirm a requested
  // unit type actually exists before including this developer in a comparison.
  const unitTypes = new Set(Object.keys(priceByType));
  if (unitTypes.size > 0) out.availableUnitTypes = [...unitTypes];

  // Finishing type and delivery status — translated to TTS-friendly Arabic so the
  // model never receives raw enum strings and cannot hallucinate or misinterpret them.
  const finishing = translateEnumField(p.finishingType, FINISHING_TYPE_AR);
  if (finishing) out.finishingType = finishing;
  const delivery = translateEnumField(p.deliveryStatus, DELIVERY_STATUS_AR);
  if (delivery) out.deliveryStatus = delivery;

  // A single sales contact (name + phone) for the "follow up with the developer"
  // call-to-action. Capped to one to stay lean.
  const contact = (p.project?.salesContacts || [])[0];
  if (contact && (contact.name || contact.phone)) {
    out.contact = { name: contact.name || null, phone: contact.phone || null };
  }

  // Project special offers — always present; empty array when none exist.
  out.offers = Array.isArray(proj.offers) ? proj.offers : [];

  console.log("[PROJECT TYPES]", proj.name, out.availableUnitTypes);
  return out;
}

/** Normalize developers payload so TTS always gets explicit English `name_en`. */
function normalizeDevelopersForTts(developers) {
  if (!Array.isArray(developers)) return [];
  return developers
    .filter((d) => d?.name_en)
    .map((d) => ({
      ...d,
      // Keep both keys for compatibility, both sourced from name_en only.
      name: d.name_en,
      name_en: d.name_en,
    }));
}

/**
 * Sort formatted properties by proximity of their required absolute down payment
 * to the user's cash budget (U). Priority order:
 *   1. D ≤ U — smallest gap (U − D) first (closest realistic match)
 *   2. D > U — never shown unless no other options (gap = Infinity in sort)
 *   3. Unknown required amount — goes last
 *
 * required = startingPrice × (minDownPayment% / 100)
 */
function sortByDownPaymentProximity(properties, userCash) {
  const scored = properties.map((p) => {
    const pct = parseDownPayment(p.minDownPayment);
    const price = p.startingPrice;
    let gap = Infinity;
    if (Number.isFinite(pct) && pct > 0 && price > 0) {
      const required = price * (pct / 100);
      gap = required <= userCash ? userCash - required : Infinity;
    }
    return { p, gap };
  });
  scored.sort((a, b) => a.gap - b.gap);
  return scored.map((s) => s.p);
}

// TTS-friendly Arabic translations for finishing and delivery enums.
// These values go directly into the model's context — never raw API enum strings.
const FINISHING_TYPE_AR = {
  "FULLY-FINISHED": "تشطيب كامل",
  "SEMI-FINISHED": "نصف تشطيب",
  "CORE-SHELL": "بدون تشطيب",
};

const DELIVERY_STATUS_AR = {
  "READY":            "استلام فوري",
  "READY-TO-MOVE":    "استلام فوري",
  "AFTER-ONE-YEAR":   "استلام خلال سنة",
  "AFTER-TWO-YEARS":  "استلام خلال سنتين",
  "AFTER-THREE-YEARS":"استلام خلال تلات سنين",
  "AFTER-FOUR-YEARS": "استلام خلال أربع سنين",
  "AFTER-FIVE-YEARS": "استلام خلال خمس سنين",
};

function translateEnumField(value, map) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const translated = value.map((v) => map[v] ?? v);
    return translated.length === 1 ? translated[0] : translated;
  }
  return map[value] ?? value;
}

/**
 * Map a category name to the project unit array key that holds its units.
 * Returns null when the category is unknown (caller falls back to all arrays).
 */
function resolveCategoryKey(category) {
  if (!category) return null;
  const c = category.toLowerCase();
  if (c.includes("apartment") || c.includes("chalet") || c.includes("studio") || c.includes("service")) return "apartments";
  if (c.includes("villa") || c.includes("twin") || c.includes("town") || c.includes("stand")) return "villas";
  if (c.includes("office") || c.includes("shop") || c.includes("clinic") || c.includes("mall") || c.includes("commercial")) return "mall";
  return null;
}

/**
 * Parse a down-payment value (a percent like "5", "1.5", or "10%") to a number.
 * Returns NaN for anything non-numeric so the caller can skip it.
 */
function parseDownPayment(value) {
  if (value === null || value === undefined) return NaN;
  const n = parseFloat(String(value).replace("%", "").trim());
  return Number.isFinite(n) ? n : NaN;
}

/**
 * bestDeveloperByLowestDownPayment — the developer with the SMALLEST minimum
 * down payment across the formatted properties. Developers whose downPayment is
 * missing / non-numeric are skipped (never guessed, never ranked). First match
 * wins ties so the order the tool returned is preserved.
 *
 * @returns {{ developer: string, downPayment: number, boothNumber: number|null }|null}
 */
export function bestDeveloperByLowestDownPayment(properties) {
  let best = null;
  for (const p of properties || []) {
    if (!p || !p.developer) continue;
    const dp = parseDownPayment(p.minDownPayment);
    if (Number.isNaN(dp)) continue;
    if (!best || dp < best.downPayment) {
      best = { developer: p.developer, downPayment: dp, boothNumber: p.boothNumber ?? null };
    }
  }
  return best;
}

/**
 * bestDeveloperByLongestInstallmentDuration — the developer with the HIGHEST
 * installment duration (years). Missing / non-positive durations are skipped.
 * First match wins ties.
 *
 * @returns {{ developer: string, installmentDuration: number, boothNumber: number|null }|null}
 */
export function bestDeveloperByLongestInstallmentDuration(properties) {
  let best = null;
  for (const p of properties || []) {
    if (!p || !p.developer) continue;
    const d = Number(p.longestPaymentDuration);
    if (!Number.isFinite(d) || d <= 0) continue;
    if (!best || d > best.installmentDuration) {
      best = { developer: p.developer, installmentDuration: d, boothNumber: p.boothNumber ?? null };
    }
  }
  return best;
}

/**
 * Build the developer-comparison block the voice agent uses in COMPARISON MODE.
 * Returns null unless there are at least 2 DISTINCT developers (a comparison
 * needs more than one). Each dimension is independent: it's present only when
 * real data backs it, and a developer absent from a dimension simply isn't
 * ranked there. Values are authoritative (computed from tool data) so the model
 * never has to guess.
 */
export function buildDeveloperComparison(properties) {
  const props = properties || [];
  const distinctDevelopers = new Set(
    props.map((p) => p && p.developer).filter(Boolean)
  );
  if (distinctDevelopers.size < 2) return null;

  const byDownPayment = bestDeveloperByLowestDownPayment(props);
  const byDuration = bestDeveloperByLongestInstallmentDuration(props);
  if (!byDownPayment && !byDuration) return null;

  const comparison = {};
  if (byDownPayment) comparison.bestDeveloperByLowestDownPayment = byDownPayment;
  if (byDuration) comparison.bestDeveloperByLongestInstallmentDuration = byDuration;
  return comparison;
}
