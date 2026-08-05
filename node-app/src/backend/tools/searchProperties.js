/** Search available real estate properties with filters. */

import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import {
  fetchRawProperties,
  resolveCompanyId,
  resolveLocationId,
  resolveCategoryId,
  resolveCityId,
  rememberRawForSession,
  stripProperty,
} from "../cache.js";
import { translateArabic, translateToArabic } from "./arabicMap.js";
import { projectMatches } from "./projectMatch.js";

const UNIT_KEYS = ["apartments", "villas", "mall"];

// Unit types the Byit API can filter SERVER-SIDE via the `bedroom` query param.
// Verified against the live API: it matches the apartment unit `type` enum, so
// only apartment-style types work here — villa/penthouse types (TWIN, TOWN,
// STAND-ALONE, PENTHOUSE, FIVE-BEDROOM, ...) return 0 and must stay client-side.
const BEDROOM_API_TYPES = new Set([
  "ONE-BEDROOM", "TWO-BEDROOM", "THREE-BEDROOM", "FOUR-BEDROOM",
  "STUDIO", "DUPLEX", "SERVICE-APARTMENT",
]);

// The Byit API only applies its price filter when BOTH priceFrom AND priceTo
// are present (a lone bound is silently ignored). So when the user gives just
// one side, we pad the other with 0 / this ceiling. Verified: the API filters
// on project.startingPrice. This number sits far above any real listing.
const PRICE_CEILING = 999999999999;

const UNIT_TYPE_ALIASES = {
  // Bedroom aliases
  "1-BEDROOM": "ONE-BEDROOM", "1 BEDROOM": "ONE-BEDROOM", "1-BED": "ONE-BEDROOM",
  "2-BEDROOM": "TWO-BEDROOM", "2 BEDROOM": "TWO-BEDROOM", "2-BED": "TWO-BEDROOM",
  "3-BEDROOM": "THREE-BEDROOM", "3 BEDROOM": "THREE-BEDROOM", "3-BED": "THREE-BEDROOM",
  "4-BEDROOM": "FOUR-BEDROOM", "4 BEDROOM": "FOUR-BEDROOM", "4-BED": "FOUR-BEDROOM",
  // Villa aliases
  "TWIN VILLA": "TWIN", "TWIN-VILLA": "TWIN", "TWIN HOUSE": "TWIN", "TWIN-HOUSE": "TWIN",
  "TOWNHOUSE": "TOWN", "TOWN HOUSE": "TOWN", "TOWN-HOUSE": "TOWN",
  "STANDALONE": "STAND-ALONE", "STANDALONE VILLA": "STAND-ALONE", "STAND-ALONE VILLA": "STAND-ALONE",
  "S VILLA": "S-VILLA", "SVILLA": "S-VILLA",
  // Commercial aliases
  "SERVICE APARTMENT": "SERVICE-APARTMENT", "SERVICED APARTMENT": "SERVICE-APARTMENT",
};

// Map common location phrasings to the EXACT name stored in the Byit Location
// API. The model frequently emits "6th of October" / "6th October", but the API
// row is "6 October" — the "th"/"of" forms don't match (exact, substring, or
// fuzzy), so we normalize them here before resolveLocationId. Keys are matched
// case-insensitively against the whole, trimmed value.
const LOCATION_ALIASES = {
  "6th of october": "6 October",
  "6th october": "6 October",
  "sixth of october": "6 October",
  // Keep alias normalization simple; the special-case "5th Settlement" behavior
  // (map to new cairo BUT do not expand as a group) is handled in
  // applyHardLocationOverride + locationGroup selection below.
  "التجمع الخامس": "new cairo",
  "5th settlement": "new cairo",
};

// The only hard location override: exact "التجمع الخامس" / "5th settlement"
// is rewritten to "new cairo" and MUST NOT trigger LOCATION_GROUPS expansion.
const HARD_LOCATION_OVERRIDES = {
  "التجمع الخامس": "new cairo",
  "5th settlement": "new cairo",
};

/** Normalize a location string to the canonical name the Location API expects. */
function normalizeLocationAlias(location) {
  if (!location) return location;
  const canonical = LOCATION_ALIASES[location.trim().toLowerCase()] ?? LOCATION_ALIASES[location.trim()];
  return canonical || location;
}

/**
 * Apply strict one-off overrides based on the raw user location input.
 * Returns the forced canonical value, or null when no hard override applies.
 */
function applyHardLocationOverride(rawLocation) {
  if (!rawLocation) return null;
  return HARD_LOCATION_OVERRIDES[rawLocation.trim().toLowerCase()] || null;
}

/**
 * Strictly keep ONLY units whose type exactly matches `requestedType`.
 * Runs on raw API rows before any downstream processing/aggregation.
 */
function filterRawPropertiesByExactUnitType(rawProperties, requestedType) {
  const want = (requestedType || "").trim().toUpperCase();
  if (!want) return rawProperties || [];

  const filtered = [];
  for (const p of rawProperties || []) {
    const srcProject = p.project || {};
    const nextProject = { ...srcProject };
    let propertyHasMatch = false;

    for (const key of UNIT_KEYS) {
      const units = Array.isArray(srcProject[key]) ? srcProject[key] : [];
      const matched = units.filter((u) => (u?.type || "").toUpperCase() === want);
      if (matched.length > 0) propertyHasMatch = true;
      nextProject[key] = matched;
    }

    if (propertyHasMatch) {
      filtered.push({ ...p, project: nextProject });
    }
  }
  return filtered;
}

// Region groups: a single region name expands to several specific locations.
// When the user names a region ("East Cairo" / "شرق القاهرة" …) we search across
// ALL its member locations instead of one. Members are real location names that
// each resolve to a Location API id (after translate + alias normalization).
const LOCATION_GROUPS = {
  "east cairo": ["التجمع السادس", "القاهرة الجديدة", "مستقبل سيتي", "هليوبوليس الجديدة","الشروق"],
  "شرق القاهرة": ["التجمع السادس", "القاهرة الجديدة", "مستقبل سيتي", "هليوبوليس الجديدة","الشروق"],
  // "New Cairo" / "القاهرة الجديدة" expand to all sub-areas for full coverage.
  "new cairo": ["التجمع الخامس", "التجمع السادس", "القاهرة الجديدة", "مستقبل سيتي", "هليوبوليس الجديدة", "الشروق"],
  "القاهرة الجديدة": ["التجمع الخامس", "التجمع السادس", "القاهرة الجديدة", "مستقبل سيتي", "هليوبوليس الجديدة", "الشروق"],
  "القاهرة الجديدة": ["التجمع الخامس", "التجمع السادس", "القاهرة الجديدة", "مستقبل سيتي", "هليوبوليس الجديدة", "الشروق"],
  "west cairo": ["الشيخ زايد", "6 أكتوبر", "حدائق أكتوبر", "أكتوبر الجديدة"],
  "غرب القاهرة": ["الشيخ زايد", "6 أكتوبر", "حدائق أكتوبر", "أكتوبر الجديدة"],
};

/** If `location` names a region group, return its member location names; else null. */
function resolveLocationGroup(location) {
  if (!location) return null;
  return LOCATION_GROUPS[location.trim().toLowerCase()] || null;
}

/**
 * Resolve every member of a region group to a Location API id, in parallel.
 * Member names are run through the same translate + alias normalization as a
 * normal location so e.g. "6 أكتوبر" → "6 October". Members that don't resolve
 * (or error) are dropped, so the search runs across whatever DOES resolve.
 *
 * @returns {Promise<Array<{ id: number, name: string }>>}
 */
async function resolveLocationGroupIds(memberNames) {
  const resolved = await Promise.all(
    memberNames.map((raw) => {
      const name = normalizeLocationAlias(translateArabic(raw));
      return resolveLocationId(name).catch((err) => {
        console.error(`[search_properties] group member "${raw}" lookup failed:`, err);
        return null;
      });
    })
  );
  return resolved.filter(Boolean);
}

// West Cairo areas, matched against the RESOLVED Location API names (lowercased)
// — covers both the "West Cairo" region group and a single West Cairo area.
const WEST_CAIRO_AREA_NAMES = new Set([
  "zayed", "6 october", "october gardens", "new october",
]);

/** True if a (stripped) property belongs to the "ADD Properties" developer. */
function isAddDeveloper(p) {
  const c = p.company || {};
  const en = (c.name_en || c.name || "").trim().toLowerCase();
  return en === "add properties" || (c.name_ar || "").includes("ايه دي دي");
}

/**
 * Down-payment eligibility. Given the user's available DOWN-PAYMENT cash, find
 * every available unit they can reserve, where:
 *   requiredDownPayment = unit.price × (downPayment% / 100)
 * and the user qualifies when cash >= requiredDownPayment.
 *
 * Computed in the backend (NOT the model) because unit prices are stripped
 * before the model ever sees them — this keeps it exact and never guessed.
 * Only available units with a real price are considered; `wantType` (a unit
 * sub-type like THREE-BEDROOM / TWIN) restricts to that type when the user
 * named one. Results are deduped per developer+type (keeping the cheapest
 * required down payment) and sorted: lowest requiredDownPayment, then lowest
 * unit price.
 *
 * @param {Array} properties  stripped properties (each with downPayment% + unit arrays)
 * @param {number} cash       user's available down-payment cash (EGP)
 * @param {string} [wantType] optional exact unit type filter
 */
function computeDownPaymentEligibility(properties, cash, wantType = "") {
  const want = (wantType || "").toUpperCase();
  const best = new Map(); // `${dev}|${type}` → qualifying unit (lowest required)
  for (const p of properties || []) {
    const pct = parseFloat(p.downPayment);
    if (!Number.isFinite(pct) || pct <= 0) continue;
    const c = p.company || {};
    const dev = c.name_en || null;
    if (!dev) continue;
    const booth = c.boothNumber ?? null;
    const proj = p.project || {};
    for (const key of UNIT_KEYS) {
      for (const u of proj[key] || []) {
        if (!u || u.available !== true || !(u.price > 0)) continue;
        if (want && (u.type || "").toUpperCase() !== want) continue;
        const required = u.price * (pct / 100);
        if (cash < required) continue;
        const k = `${dev}|${u.type}`;
        const entry = {
          developer: dev,
          boothNumber: booth,
          unitType: u.type,
          unitPrice: u.price,
          downPaymentPercent: pct,
          requiredDownPayment: Math.round(required),
        };
        const prev = best.get(k);
        if (!prev || entry.requiredDownPayment < prev.requiredDownPayment) best.set(k, entry);
      }
    }
  }
  // Sort by PROXIMITY to the user's cash budget (closest match first).
  // All entries qualify (cash >= requiredDownPayment), so gap = cash - required.
  // Smallest gap = best match for the user's budget.
  return [...best.values()].sort(
    (a, b) =>
      (cash - a.requiredDownPayment) - (cash - b.requiredDownPayment) ||
      a.unitPrice - b.unitPrice
  );
}

export function createSearchProperties(countryId, sessionId = null) {
  return _buildSearchTool(Number(countryId) || 50, sessionId);
}

// Default export (Egypt) for backwards compatibility
export const searchProperties = _buildSearchTool(50, null);

function _buildSearchTool(countryId, sessionId) { return tool({
  name: "search_properties",
  description:
    "Search available real estate properties with filters. Returns properties with pricing, " +
    "area, location, finishing, delivery, installment info, and the developer (with booth number). " +
    "Use this when users ask about properties, pricing, availability, or recommendations. " +
    "CRITICAL: You MUST present ONLY the projects returned by this tool. NEVER add, infer, or " +
    "suggest projects from memory, prior calls, or similarity. Results from previous calls do NOT " +
    "carry over. If this tool returns N projects, your response contains exactly those N projects.",
  inputSchema: z.object({
    category: z.string().default("any").describe(
      "Property CATEGORY — the kind of property. One of: Apartment, Villa, Chalet, " +
      "Office, Commercial Shop, Clinic, Service Apartment (Arabic accepted: شقة، فيلا، " +
      "شاليه، مكتب، محل تجاري، عيادة، شقة فندقية). SET THIS whenever the user names a " +
      "property kind (e.g. 'شقة' → Apartment, 'فيلا' → Villa). Use 'any' only when the " +
      "user did not specify a kind. This is DIFFERENT from unit_type."
    ),
    unit_type: z.string().default("").describe(
      "Unit SUB-TYPE within a category — bedroom count or villa style. Examples: " +
      "ONE-BEDROOM, TWO-BEDROOM, THREE-BEDROOM, FOUR-BEDROOM, STUDIO, DUPLEX, TWIN, " +
      "TOWN, STAND-ALONE, PENTHOUSE. Arabic bedroom phrases accepted (e.g. 'ثلاث غرف'). " +
      "Leave empty if the user only named a category and not a bedroom count / sub-type."
    ),
    location: z.string().default("").describe("Sub-area / district filter, e.g. New Cairo, North Coast, Dubai Marina, Business Bay, Al Marjan Island. If the user names a REGION ('East Cairo'/'شرق القاهرة' or 'West Cairo'/'غرب القاهرة'), pass the region name AS-IS — the backend expands it across all its areas. Do not split a region into multiple searches."),
    city: z.string().default("").describe("UAE city filter (Dubai, Abu Dhabi, Sharjah, Ajman, Ras al-Khaimah, Umm Al Quwain, Fujairah). Egypt rows have no city — leave empty for Egypt searches."),
    min_price: z.number().default(0).describe("Minimum price in EGP"),
    max_price: z.number().default(0).describe("Maximum price in EGP"),
    finishing_type: z.string().default("").describe("Finishing type: CORE-SHELL, SEMI-FINISHED, FULLY-FINISHED"),
    delivery_status: z.string().default("").describe("Delivery status: READY-To-MOVE, AFTER-ONE-YEAR, AFTER-TWO-YEARS, AFTER-THREE-YEARS, AFTER-FOUR-YEARS, AFTER-FIVE-YEARS etc."),
    max_down_payment: z.number().default(-1).describe("Maximum down payment percentage"),
    min_installment_duration: z.number().default(-1).describe("Minimum installment duration in years"),
    down_payment_cash: z.number().default(0).describe(
      "The CASH amount in EGP the user has available FOR THE DOWN PAYMENT (NOT their " +
      "total budget). Set this when the user says how much down-payment money they have " +
      "or asks what they can reserve with it — e.g. 'معايا مليون ونص مقدم', 'عايز وحدة " +
      "بمقدم ٥٠٠ ألف', 'أقدر أحجز بإيه', 'هل المقدم ده يكفي'. The backend computes which " +
      "available units can be reserved (requiredDownPayment = unit.price × downPayment%) " +
      "and returns them in 'downPaymentEligibility'. Leave 0 otherwise."
    ),
    developer_name: z.string().default("").describe("Developer/company name filter"),
    project_name: z.string().default("").describe("Project name filter"),
    project_id: z.number().optional().describe("Exact project ID — use this instead of project_name when available for precise, collision-free matching"),
    list_projects: z.boolean().default(false).describe(
      "Set true when the user asks for a LIST of projects — e.g. 'مشاريع ماونتن فيو', 'projects in North Coast', 'كل مشاريع سوديك'. " +
      "Results are returned per-project (every project is a separate row). " +
      "Set false (default) for developer comparison / ranking queries — e.g. 'مين أفضل مطور', 'قارن المطورين' — where one row per developer is correct."
    ),
    mode: z.enum(["all", "paginated"]).default("paginated").describe(
      "Fetch mode. 'paginated' (default): standard page-by-page search — use for all listing and filtering requests. " +
      "'all': fetch the full dataset in one call — use ONLY for analytics queries such as cheapest/best/comparison/ranking."
    ),
    page: z.number().default(1).describe(
      "Page number (1-based). For 'next / more / في تاني': increment by 1 and re-call with the SAME filters. " +
      "Stop when currentPage === pageCount in the previous response."
    ),
    max_results: z.number().default(5).describe("Maximum number of results to return"),
    language: z.string().default("English").describe("Response language: 'Arabic' or 'English'"),
    include_delivery: z.boolean().default(false).describe(
      "Set true ONLY when the user explicitly asks about delivery time or handover date — " +
      "e.g. 'استلام امتى؟', 'موعد الاستلام', 'delivery date', 'when can I move in'. " +
      "Default false — deliveryStatus is excluded from the response unless requested."
    ),
  }),
  callback: async (input) => {
    const _toolStart = Date.now();
    console.log(`[search_properties] CALLBACK START`);
    try {
    let {
      category, unit_type, location, city, min_price, max_price,
      finishing_type, delivery_status, max_down_payment,
      min_installment_duration, down_payment_cash, developer_name, project_name, project_id, list_projects, mode, page, max_results, language, include_delivery,
    } = input;
    // mode="paginated" (default): use the page param for standard navigation.
    // mode="all": always fetch from page 1 (no page param → API returns full dataset), for analytics only.
    const currentPage = (mode === "all") ? 1 : ((page > 0) ? Math.floor(page) : 1);
    console.log(`[search_properties] mode=${mode ?? "paginated"}, page=${currentPage}`);

    // Translate Arabic input to English for API matching
    console.log(
      `[search_properties] BEFORE translate: developer=${developer_name}, location=${location}, unit_type=${unit_type}, category=${category}, project=${project_name}`
    );
    project_name = translateArabic(project_name);
    developer_name = translateArabic(developer_name);
    const rawLocationInput = location;
    location = translateArabic(location);
    location = normalizeLocationAlias(location);
    const hardOverriddenLocation = applyHardLocationOverride(rawLocationInput);
    const skipLocationGroupExpansion = !!hardOverriddenLocation;
    if (hardOverriddenLocation) {
      location = hardOverriddenLocation;
      console.log(
        `[search_properties] hard location override "${rawLocationInput}" -> "${location}" (group expansion disabled)`
      );
    }
    city = translateArabic(city);
    unit_type = translateArabic(unit_type);
    category = translateArabic(category);
    console.log(
      `[search_properties] AFTER translate: developer=${developer_name}, location=${location}, city=${city}, unit_type=${unit_type}, category=${category}, project=${project_name}`
    );

    // North Coast without an explicit category → default to Chalet.
    // The North Coast is a beach/resort market where chalets dominate; searching
    // without a category floods results with irrelevant types.
    const isNorthCoastOrSokhna = /north\s*coast|sahel|الساحل(?:\s+الشمالي)?|ساحل|ain\s*sokhna|sokhna|العين\s*السخنة|السخنة/i.test(location || "");
    if (isNorthCoastOrSokhna && (!category || category.toLowerCase() === "any" || category.toLowerCase() === "all")) {
      category = "Chalet";
      console.log("[search_properties] North Coast / Ain Sokhna detected — defaulting category to Chalet");
    }

    // Normalize unit type variations
    if (unit_type) {
      unit_type = UNIT_TYPE_ALIASES[unit_type.toUpperCase()] || unit_type;
    }

    // Apartment-style unit types are filtered SERVER-SIDE via the `bedroom`
    // query param (smaller payload, faster). Villa/commercial types aren't
    // supported by that param, so they fall through to the client-side
    // unit_type filter below. The local filter still runs for bedroom types
    // too, as a harmless refinement.
    const bedroom = unit_type && BEDROOM_API_TYPES.has(unit_type.toUpperCase())
      ? unit_type.toUpperCase()
      : null;
    if (bedroom) {
      console.log(`[search_properties] routing unit_type "${unit_type}" → bedroom=${bedroom} (server-side)`);
    }

    // Budget → server-side price filter. The API needs BOTH bounds to filter,
    // so pad the missing side (floor 0 / high ceiling). The client-side price
    // filter below still runs as a harmless refinement (same startingPrice).
    let priceFrom = null;
    let priceTo = null;
    if (min_price > 0 || max_price > 0) {
      priceFrom = min_price > 0 ? min_price : 0;
      priceTo = max_price > 0 ? max_price : PRICE_CEILING;
      console.log(`[search_properties] budget → priceFrom=${priceFrom}, priceTo=${priceTo} (server-side)`);
    }

    // City search is temporarily disabled — we ignore the `city` input and
    // never resolve it. To re-enable, swap the cityResult line back to
    // `city ? resolveCityId(city, countryId) : Promise.resolve(null)`.
    if (city) {
      console.log(`[search_properties] city search DISABLED — ignoring city="${city}"`);
    }
    city = "";

    // Parallelize the three remaining id lookups (developer / location /
    // category). Each one hits a different Byit endpoint, so running them
    // concurrently with Promise.allSettled cuts the resolve phase from
    // ~3× round-trip-time down to ~1× RTT. Errors per branch are handled
    // individually below so one slow/missing resolver doesn't poison the rest.
    const isUAE = countryId === 7;
    // A region name ("East Cairo" / "غرب القاهرة" …) expands to several member
    // locations we search across; a normal location resolves to a single id.
    const locationGroup =
      location && !skipLocationGroupExpansion ? resolveLocationGroup(location) : null;
    if (locationGroup) {
      console.log(
        `[search_properties] location "${location}" is a region group → [${locationGroup.join(", ")}]`
      );
    }
    const [companyResult, locationResult, categoryResult, cityResult] = await Promise.allSettled([
      developer_name ? resolveCompanyId(developer_name, countryId) : Promise.resolve(null),
      location
        ? (locationGroup ? resolveLocationGroupIds(locationGroup) : resolveLocationId(location))
        : Promise.resolve(null),
      (category && category.toLowerCase() !== "any")
        ? resolveCategoryId(category, countryId)
        : Promise.resolve(null),
      // city ? resolveCityId(city, countryId) : Promise.resolve(null), // city search disabled
      Promise.resolve(null),
    ]);

    // Developer
    let companyId = null;
    if (developer_name) {
      if (companyResult.status === "fulfilled") {
        companyId = companyResult.value;
      }
      console.log(
        `[search_properties] resolved developer "${developer_name}" → company id ${companyId}`
      );
      if (companyId == null) {
        rememberRawForSession(sessionId, []);
        return JSON.stringify({
          total_matching: 0,
          returned: 0,
          offset: 0,
          has_more: false,
          properties: [],
        });
      }
    }

    // Location (same logic as before — if it can't resolve and we're in UAE,
    // fall back to city filtering downstream rather than failing immediately).
    let locationId = null;
    let locationIds = null; // set for region groups → search across all members
    let searchedLocationNames = []; // resolved Location API names (for West Cairo pinning)
    let locationAsCityFallback = "";
    let locationLookupErrored = false;
    if (location && locationGroup) {
      // Region group: gather every member id that resolved. If NONE resolved,
      // fall through to the standard not-found handling below.
      const members =
        locationResult.status === "fulfilled" && Array.isArray(locationResult.value)
          ? locationResult.value
          : [];
      if (members.length) {
        locationIds = members.map((m) => m.id);
        searchedLocationNames = members.map((m) => (m.name || "").toLowerCase());
        console.log(
          `[search_properties] resolved region "${location}" → ${members.length} locations: ` +
            members.map((m) => `${m.name}#${m.id}`).join(", ")
        );
      } else {
        locationLookupErrored = locationResult.status !== "fulfilled";
        if (isUAE && !city) {
          locationAsCityFallback = location;
        } else {
          rememberRawForSession(sessionId, []);
          return JSON.stringify({
            error: locationLookupErrored ? "location_lookup_failed" : "location_not_found",
            query: location,
            message: `No matching locations found for region "${location}". Ask the user to clarify or pick a specific area.`,
            total_matching: 0,
            returned: 0,
            offset: 0,
            has_more: false,
            properties: [],
          });
        }
      }
    } else if (location) {
      if (locationResult.status === "fulfilled") {
        const resolved = locationResult.value;
        if (resolved) {
          locationId = resolved.id;
          searchedLocationNames = [(resolved.name || "").toLowerCase()];
          console.log(
            `[search_properties] resolved location "${location}" → id ${locationId} (${resolved.name})`
          );
        } else {
          console.log(
            `[search_properties] location "${location}" — no Location API match${isUAE ? ", will try as city" : ""}`
          );
          if (isUAE && !city) {
            locationAsCityFallback = location;
          } else {
            rememberRawForSession(sessionId, []);
            return JSON.stringify({
              error: "location_not_found",
              query: location,
              message: `No matching location found for "${location}". Ask the user to clarify or suggest a known area for this country.`,
              total_matching: 0,
              returned: 0,
              offset: 0,
              has_more: false,
              properties: [],
            });
          }
        }
      } else {
        console.error(`[search_properties] location lookup failed:`, locationResult.reason);
        locationLookupErrored = true;
        if (isUAE && !city) {
          locationAsCityFallback = location;
        } else {
          rememberRawForSession(sessionId, []);
          return JSON.stringify({
            error: "location_lookup_failed",
            query: location,
            message: `Unable to look up location "${location}" right now. Ask the user to try again or rephrase.`,
            total_matching: 0,
            returned: 0,
            offset: 0,
            has_more: false,
            properties: [],
          });
        }
      }
    }

    // Category
    let categoryId = null;
    if (category && category.toLowerCase() !== "any") {
      if (categoryResult.status === "fulfilled") {
        categoryId = categoryResult.value;
      }
      console.log(
        `[search_properties] resolved category "${category}" → id ${categoryId} (country=${countryId})`
      );
      if (categoryId == null) {
        rememberRawForSession(sessionId, []);
        return JSON.stringify({
          total_matching: 0,
          returned: 0,
          offset: 0,
          has_more: false,
          properties: [],
        });
      }
    }

    // City — resolved server-side via the /countries/{id}/cities endpoint.
    // If the user gave a city but it can't be resolved against the catalog,
    // short-circuit with empty results (parallel to the developer path).
    let cityId = null;
    if (city) {
      if (cityResult.status === "fulfilled") {
        cityId = cityResult.value;
      }
      console.log(
        `[search_properties] resolved city "${city}" → id ${cityId} (country=${countryId})`
      );
      if (cityId == null) {
        rememberRawForSession(sessionId, []);
        return JSON.stringify({
          total_matching: 0,
          returned: 0,
          offset: 0,
          has_more: false,
          properties: [],
        });
      }
    }

    // UAE location-as-city fallback is also disabled while city search is off.
    // To re-enable, uncomment the resolveCityId block below.
    // if (locationAsCityFallback && cityId == null) {
    //   try {
    //     cityId = await resolveCityId(locationAsCityFallback, countryId);
    //     console.log(
    //       `[search_properties] resolved location-as-city "${locationAsCityFallback}" → id ${cityId}`
    //     );
    //   } catch (err) {
    //     console.error(`[search_properties] city fallback failed:`, err);
    //   }
    // }

    // Server-side filters: country + compound type + (optional) company id +
    // (optional) location id + (optional) category id + (optional) city id.
    // Everything else (price, unit type, finishing, delivery, project name,
    // etc.) is filtered locally below — the API doesn't support those.
    const baseFilters = {
      country: countryId,
      type: "RELATED-TO-COMPOUND",
      companyId,
      categoryId,
      cityId,
      bedroom,
      priceFrom,
      priceTo,
    };

    // For a region group, pass ALL member ids in ONE request — the API takes a
    // comma-separated `location` list and returns the union (deduped server-side).
    // A normal search passes the single resolved id.
    const locationFilter = locationIds && locationIds.length ? locationIds : locationId;
    const { data: rawProperties, propertiesCount: apiPropertiesCount, pageCount: apiPageCount } =
      await fetchRawProperties({ ...baseFilters, locationId: locationFilter, page: currentPage, mode });
    if (locationIds && locationIds.length) {
      console.log(
        `[search_properties] region group → one request for locations [${locationIds.join(",")}] → ${rawProperties.length} raw`
      );
    }
    let rawResults = rawProperties;

    // STRICT unit-type enforcement: once a specific unit type is requested,
    // keep only exact matches and drop every other unit type before any other
    // processing (project-name, price, consolidation, formatter, etc.).
    if (unit_type) {
      const strictType = unit_type.toUpperCase();
      rawResults = filterRawPropertiesByExactUnitType(rawResults, strictType);
      console.log(
        `[search_properties] strict unit_type="${strictType}" → ${rawResults.length} matching raw result(s)`
      );

      if (rawResults.length === 0) {
        rememberRawForSession(sessionId, []);
        return JSON.stringify({
          error: "unit_type_not_available",
          message: "غير متاح بالنوع ده حالياً",
          total_matching: 0,
          returned: 0,
          offset: 0,
          has_more: false,
          properties: [],
        });
      }
    }

    // Filter by project — ID takes absolute priority over name.
    // When project_id is provided it must match exactly; project_name is ignored.
    // When only project_name is given, exact (non-partial) matching is used.
    if (project_id || project_name) {
      rawResults = rawResults.filter((p) => projectMatches(p.project, project_name, project_id));
    }

    // Stash the raw matches for the image collector before we strip them.
    rememberRawForSession(sessionId, rawResults);

    // Strip internal fields before applying remaining client-side filters.
    console.log(`[search_properties] count_aftergggg_api=${rawResults.length}`);
    let results = rawResults.map(stripProperty);
console.log(`[search_properties] count_after_api 630 -- =${results.length}`);
    // (Category, location, and city are now all filtered server-side via
    // resolveCategoryId / resolveLocationId / resolveCityId — the corresponding
    // ids are passed to /properties/withoutPagenation/get?category=&location=&city=.)

    // If we fell back from location→city and nothing matched (either resolveCityId
    // returned null or the API filter excluded everything), surface the original
    // error so the LLM can ask for clarification or suggest a country switch.
    if (locationAsCityFallback && results.length === 0) {
      rememberRawForSession(sessionId, []);
      return JSON.stringify({
        error: locationLookupErrored ? "location_lookup_failed" : "location_not_found",
        query: location,
        message: locationLookupErrored
          ? `Unable to look up location "${location}" right now. Ask the user to try again or rephrase.`
          : `No matching location or city found for "${location}". The user may be searching in the wrong country, or the name may be spelled differently.`,
        total_matching: 0,
        returned: 0,
        offset: 0,
        has_more: false,
        properties: [],
      });
    }
console.log(`[search_properties] count_after_api 653 -- =${results.length}`);
    // Filter by unit sub-type
    if (unit_type) {
      const searchType = unit_type.toUpperCase();
      results = results.filter((p) => {
        const proj = p.project || {};
        for (const key of UNIT_KEYS) {
          const units = proj[key] || [];
          if (units.some((u) => u.type === searchType)) return true;
        }
        return false;
      });
    }
console.log(`[search_properties] count_after_api 666 -- =${results.length}`);
    // Filter by price range
    if (min_price || max_price) {
      const mn = min_price || 0;
      const mx = max_price || Infinity;
      results = results.filter((p) => {
        const starting = (p.project || {}).startingPrice || p.price || 0;
        if (starting > 0) return mn <= starting && starting <= mx;
        const proj = p.project || {};
        const allUnits = UNIT_KEYS.flatMap((k) => proj[k] || []);
        return allUnits.some((u) => mn <= (u.price || 0) && (u.price || 0) <= mx);
      });
    }
console.log(`[search_properties] count_after_api 679 -- =${results.length}`);
    // Filter by finishing type. finishingType / deliveryStatus are now ARRAYS in
    // the API response (e.g. ["FULLY-FINISHED"]) — they used to be plain strings.
    // matchesEnum handles both: substring match against any array element, or
    // against the string directly.
    const matchesEnum = (field, query) => {
      if (!field) return false;
      const values = Array.isArray(field) ? field : [field];
      return values.some((v) => typeof v === "string" && v.includes(query));
    };
    if (finishing_type) {
      results = results.filter((p) => matchesEnum(p.finishingType, finishing_type));
    }

    // Filter by delivery status
    if (delivery_status) {
      results = results.filter((p) => matchesEnum(p.deliveryStatus, delivery_status));
    }

    // Filter by max down payment
    if (max_down_payment >= 0) {
      results = results.filter((p) => {
        const dp = parseFloat(p.downPayment);
        return !isNaN(dp) && dp <= max_down_payment;
      });
    }

    // Filter by min installment duration
    if (min_installment_duration >= 0) {
      results = results.filter(
        (p) => (p.installmentDuration || 0) >= min_installment_duration
      );
    }

    // Down-payment eligibility — computed HERE, while unit prices/types are still
    // present (consolidation/aggregation below collapses them, and the formatter
    // strips them entirely before the model). Only runs when the user told us
    // their available down-payment cash.
    let downPaymentEligibility = null;
    if (down_payment_cash > 0) {
      const qualifying = computeDownPaymentEligibility(results, down_payment_cash, unit_type);
      downPaymentEligibility = {
        cash: down_payment_cash,
        anyQualify: qualifying.length > 0,
        // Cap for a lean, voice-friendly payload — already sorted best-first.
        units: qualifying.slice(0, 8),
      };
      console.log(
        `[search_properties] down-payment eligibility: cash=${down_payment_cash}, ` +
          `${qualifying.length} qualifying unit(s)`
      );
    }

    // Consolidate results by project name so the same project isn't listed multiple times
    const projectMap = new Map();
    console.log(`[search_properties] count_afterfff_devBest=${results.length}`);
    for (const p of results) {
      const projName = (p.project && (p.project.id || p.project.name)) || "";
      if (!projName) {
        // No project name — keep as-is under a unique key
        projectMap.set(Symbol(), p);
        continue;
      }
      const key = projName;
      if (!projectMap.has(key)) {
        projectMap.set(key, JSON.parse(JSON.stringify(p)));
      } else {
        const existing = projectMap.get(key);
        // Merge categories
        const existingCat = (existing.category && existing.category.categoryName) || "";
        const newCat = (p.category && p.category.categoryName) || "";
        if (newCat && existingCat && !existingCat.toLowerCase().includes(newCat.toLowerCase())) {
          existing.category = { categoryName: `${existingCat}, ${newCat}` };
        } else if (newCat && !existingCat) {
          existing.category = p.category;
        }
        // Merge unit arrays (apartments, villas, mall) — available units only
        const proj = existing.project || {};
        const srcProj = p.project || {};
        for (const unitKey of UNIT_KEYS) {
          const srcUnits = (srcProj[unitKey] || []).filter((u) => u.available === true);
          if (srcUnits.length > 0) {
            proj[unitKey] = [...(proj[unitKey] || []), ...srcUnits];
          }
        }
        // Merge sales contacts (deduplicate by phone)
        const existingContacts = proj.salesContacts || [];
        const newContacts = (srcProj.salesContacts || []);
        const seenPhones = new Set(existingContacts.map((c) => c.phone || c.name));
        for (const c of newContacts) {
          const ck = c.phone || c.name;
          if (!seenPhones.has(ck)) {
            seenPhones.add(ck);
            existingContacts.push(c);
          }
        }
        proj.salesContacts = existingContacts;
        existing.project = proj;
        // Use the lower down payment / longer installment if available
        if (p.downPayment != null && (existing.downPayment == null || parseFloat(p.downPayment) < parseFloat(existing.downPayment))) {
          existing.downPayment = p.downPayment;
        }
        if ((p.installmentDuration || 0) > (existing.installmentDuration || 0)) {
          existing.installmentDuration = p.installmentDuration;
        }
      }
    }
    let consolidated = [...projectMap.values()];

    const countBeforeDevBest = consolidated.length;
    const queryType = list_projects ? "project_listing" : "developer_comparison";
    console.log(`[search_properties] query_type=${queryType}, count_before_devBest=${countBeforeDevBest}`);

    if (!list_projects) {
      // Collapse to ONE entry per DEVELOPER, surfacing their BEST terms: the
      // LONGEST installment duration and the LOWEST minimum down payment across all
      // their matching projects. The assistant speaks developer-level terms (not
      // per-project), and the longest plan must always win — so we keep, per
      // developer, the row with the max installmentDuration as the representative
      // and override its downPayment with the developer's minimum.
      // We retain BOTH the shortest and longest installment duration (and the down
      // payment range) per developer, so the assistant can answer either "what's the
      // longest plan?" or "what's the minimum?" — keeping only the max would make
      // the shortest plan unanswerable.
      const devBest = new Map();
      for (const p of consolidated) {
        const c = p.company || {};
        const devKey =
          c.id != null
            ? `id:${c.id}`
            : `name:${(c.name_en || c.name || "").trim().toLowerCase()}`;
        const duration = p.installmentDuration || 0;
        const dpNum =
          p.downPayment != null && !Number.isNaN(parseFloat(p.downPayment))
            ? parseFloat(p.downPayment)
            : null;

        const e = devBest.get(devKey);
        if (!e) {
          devBest.set(devKey, {
            rep: p,
            maxDuration: duration,
            minDuration: duration > 0 ? duration : Infinity,
            minDpNum: dpNum,
            minDpStr: dpNum != null ? p.downPayment : null,
            maxDpNum: dpNum,
            maxDpStr: dpNum != null ? p.downPayment : null,
          });
          continue;
        }
        // Longest installment duration wins the representative row (it carries the
        // location/category context for the headline figure).
        if (duration > e.maxDuration) {
          e.rep = p;
          e.maxDuration = duration;
        }
        // Track the SHORTEST non-zero duration too.
        if (duration > 0 && duration < e.minDuration) e.minDuration = duration;
        // Track the lowest AND highest down payment seen for this developer.
        if (dpNum != null && (e.minDpNum == null || dpNum < e.minDpNum)) {
          e.minDpNum = dpNum;
          e.minDpStr = p.downPayment;
        }
        if (dpNum != null && (e.maxDpNum == null || dpNum > e.maxDpNum)) {
          e.maxDpNum = dpNum;
          e.maxDpStr = p.downPayment;
        }
      }

      consolidated = [...devBest.values()].map(
        ({ rep, minDuration, maxDuration, minDpStr, maxDpStr }) => {
          // Headline figures = the developer's BEST terms: lowest down payment +
          // longest plan. Plus an explicit min/max range so either can be spoken.
          if (minDpStr != null) rep.downPayment = minDpStr;
          rep.installmentDuration = maxDuration; // longest (back-compat headline)
          rep.installmentDurationMax = maxDuration;
          rep.installmentDurationMin = Number.isFinite(minDuration) ? minDuration : maxDuration;
          rep.downPaymentMin = minDpStr;
          rep.downPaymentMax = maxDpStr;
          return rep;
        }
      );
    } else {
      // Project-listing mode: preserve every project row.
      // Set min/max fields per-entry so formatProperty works identically.
      for (const p of consolidated) {
        const dur = p.installmentDuration || 0;
        p.installmentDurationMax = dur;
        p.installmentDurationMin = dur;
        p.downPaymentMin = p.downPayment ?? null;
        p.downPaymentMax = p.downPayment ?? null;
      }
    }

    const countAfterDevBest = consolidated.length;
    console.log(`[search_properties] count_after_devBest=${countAfterDevBest}`);

    // West Cairo business rule: whenever the search is scoped to West Cairo (the
    // region OR any of its areas), pin "ADD Properties" to the FIRST position so
    // it always surfaces. Stable partition — relative order is otherwise kept,
    // and pinning happens BEFORE the page slice so ADD survives the cap.
    const isWestCairo = searchedLocationNames.some((n) => WEST_CAIRO_AREA_NAMES.has(n));
    if (isWestCairo) {
      const pinned = consolidated.filter(isAddDeveloper);
      if (pinned.length) {
        consolidated = [...pinned, ...consolidated.filter((p) => !isAddDeveloper(p))];
        console.log(
          `[search_properties] West Cairo → pinned ${pinned.length} "ADD Properties" result(s) first`
        );
      }
    }

    const totalMatching = consolidated.length;
    const hasMore = currentPage < apiPageCount;

    const isArabic = (language || "").toLowerCase().includes("ar");

    // Display-facing enum translator: pass through unchanged for English,
    // convert to Arabic for Arabic responses. Never modify tool-facing ids.
    const localize = (value) => {
      if (!value) return value;
      // finishingType / deliveryStatus arrive as ARRAYS — localize each element,
      // since translateToArabic only translates strings (it passes arrays through
      // untouched, which would leave the enums in English).
      if (Array.isArray(value)) return value.map((v) => localize(v));
      return isArabic ? translateToArabic(value) : value;
    };

    // Resolve names based on language and translate enum values
    for (const p of consolidated) {
      // Add human-readable property type label
      p.propertyType = isArabic ? "كومباوند" : "Compound";

      // finishingType and deliveryStatus are translated exclusively by
      // tool-formatter.js before reaching the model. Do NOT translate here —
      // the formatter needs the raw API enum values as keys for its lookup maps.
      if (p.category?.categoryName) p.category.categoryName = localize(p.category.categoryName);

      // Arabic-script detector — used to avoid falling back to a non-Arabic value when isArabic=true
      const hasArabic = (s) => typeof s === "string" && /[\u0600-\u06FF]/.test(s);
      const pickArabic = (...candidates) => {
        for (const c of candidates) {
          if (hasArabic(c)) return c;
        }
        // No Arabic variant exists — use the first non-empty candidate as a last resort
        for (const c of candidates) {
          if (c) return c;
        }
        return "";
      };

      // Resolve project name
      if (p.project) {
        p.project.name = isArabic
          ? pickArabic(p.project.name_ar, p.project.name, p.project.name_en)
          : (p.project.name_en || p.project.name || "");
      }

      // Resolve company name
      if (p.company) {
        // Developer pronunciation/source-of-truth rule: always keep the
        // spoken/display company name bound to name_en (never localized).
        p.company.name = p.company.name_en || "";
      }

      // Resolve location name
      if (p.location) {
        p.location.name = isArabic
          ? pickArabic(p.location.name_ar, p.location.name, p.location.name_en)
          : (p.location.name_en || p.location.name || "");
      }

      // Resolve city name (UAE-only — Egypt rows have city=null and skip this).
      if (p.city) {
        p.city.name = isArabic
          ? pickArabic(p.city.name_ar, p.city.name, p.city.name_en)
          : (p.city.name_en || p.city.name || "");
      }

      const proj = p.project || {};
      for (const key of UNIT_KEYS) {
        if (Array.isArray(proj[key])) {
          for (const unit of proj[key]) {
            if (unit && unit.type) unit.type = localize(unit.type);
          }
        }
      }

      // Vendor display rule: Byit stays bare; any other vendor becomes
      // "Partner: <Vendor>" (English) or "الشريك: <Vendor>" (Arabic).
      // The vendor's own name is always kept in English per business rule.
      const partnerLabel = isArabic ? "الشريك" : "Partner";
      for (const contact of proj.salesContacts || []) {
        if (!contact || !contact.vendor) continue;
        const vendor = String(contact.vendor).trim();
        contact.vendor = /^byit$/i.test(vendor)
          ? "Byit"
          : `${partnerLabel}: ${vendor}`;
      }
    }

    // Build a deduplicated developers list from the returned properties so the
    // AI never mentions the same company twice in voice output or the UI list.
    // Primary key: company.id; fallback: normalized name (trim + lowercase).
    const seenDevKeys = new Set();
    const developers = [];
    for (const p of consolidated) {
      const c = p.company;
      if (!c) continue;
      if (!c.name_en) continue;
      const devKey =
        c.id != null
          ? `id:${c.id}`
          : `name:${c.name_en.trim().toLowerCase()}`;
      if (seenDevKeys.has(devKey)) continue;
      seenDevKeys.add(devKey);
      const dev = {
        name: c.name_en,
        name_en: c.name_en,
      };
      if (c.id != null) dev.id = c.id;
      if (c.boothNumber != null) dev.boothNumber = c.boothNumber;
      developers.push(dev);
    }

    const finalCount = consolidated.length;
    console.log(`[search_properties] total_matching=${totalMatching}, returned=${finalCount}, has_more=${hasMore}`);
    console.log(`[search_properties] query_type=${queryType} | before_devBest=${countBeforeDevBest} | after_devBest=${countAfterDevBest} | final_to_model=${finalCount}`);
    console.log(`[PAGINATION META] currentPage=${currentPage} pageCount=${apiPageCount} propertiesCount=${apiPropertiesCount} hasMore=${hasMore}`);
    console.log(`[search_properties] projects:`, consolidated.map(p => p.project?.name || "(no name)"));
    // Strip deliveryStatus from every property unless the user explicitly asked
    // for delivery information. This prevents the model from ever seeing raw
    // enum values and eliminates hallucination of delivery timelines.
    if (!include_delivery) {
      for (const p of consolidated) {
        delete p.deliveryStatus;
      }
    }

    console.log(`[search_properties] CALLBACK END — ${Date.now() - _toolStart}ms`);

    return JSON.stringify({
      mandatory_output_count: consolidated.length,
      total_matching: totalMatching,
      returned: consolidated.length,
      currentPage,
      pageCount: apiPageCount,
      propertiesCount: apiPropertiesCount,
      has_more: hasMore,
      developers,
      properties: consolidated,
      ...(downPaymentEligibility ? { downPaymentEligibility } : {}),
    });
    } catch (e) {
      console.error(`[search_properties] Error after ${Date.now() - _toolStart}ms:`, e);
      return JSON.stringify({ total_matching: 0, returned: 0, properties: [] });
    }
  },
}); }
