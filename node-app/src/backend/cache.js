/** Stateless Byit API client — every call is a fresh GET with server-side filters. */

const BYIT_API_BASE = "https://api.app.byitcorp.com/api/v1";
//const BYIT_API_BASE =  "http://localhost:8000/api/v1"; // Local dev proxy to Byit API (see backend/server.js)

// Endpoint paths centralized so future URL changes stay in one place.
const BYIT_API_PATHS = {
  properties: "/properties/developers/get",
  companies: "/companies/withoutPagenation/get/for-ai",
  projects: "/projects/withoutPagenation/get/for-ai",
  locations: "/location/withoutPagenation/get",
  categories: "/categories",
};

// Headers that instruct every intermediary (browser, CDN, reverse proxy) to
// never serve a cached response. Applied to all outbound fetch calls so
// repeated identical queries always hit the origin API.
const NO_CACHE_HEADERS = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
};

// Fields stripped from property data before sending to the model
const PROPERTY_INTERNAL_FIELDS = new Set([
  "top", "isFixed", "isFavourite", "createdAt", "url","imgs", "voiceNote", "id",
]);

const PROJECT_INTERNAL_FIELDS = new Set([
  "ratio", "companyRatio", "onspotRatio", "diffOnspotRatio",
  "netRatio",
  "employeCountry", "enableFBEvent", "img", "pdf", "location",
]);

export function stripProperty(prop) {
  const cleaned = {};
  for (const [k, v] of Object.entries(prop)) {
    if (!PROPERTY_INTERNAL_FIELDS.has(k)) cleaned[k] = v;
  }

  if (cleaned.project && typeof cleaned.project === "object") {
    const proj = {};
    for (const [k, v] of Object.entries(cleaned.project)) {
      if (!PROJECT_INTERNAL_FIELDS.has(k)) proj[k] = v;
    }

    // Filter units: only available with price > 0
    for (const unitKey of ["apartments", "villas", "mall"]) {
      if (Array.isArray(proj[unitKey])) {
        proj[unitKey] = proj[unitKey].filter(
          (u) => u.available && (u.price || 0) > 0
        );
      }
    }

    // Extract sales contacts from vendors
    const vendors = proj.vendors || [];
    if (vendors.length > 0) {
      const contacts = [];
      const seen = new Set();
      for (const v of vendors) {
        if (v.contactName || v.contactPhone) {
          const key = v.contactPhone || v.contactName;
          if (!seen.has(key)) {
            seen.add(key);
            const contact = {
              name: v.contactName,
              phone: v.contactPhone,
            };
            if (v.contactTitle) contact.title = v.contactTitle;
            if (v.name_en || v.name) contact.vendor = v.name_en || v.name;
            contacts.push(contact);
          }
        }
      }
      proj.salesContacts = contacts;
    }

    delete proj.vendors;
    delete proj.employeName;
    delete proj.employePhone;

    cleaned.project = proj;
  }

  if (cleaned.company && typeof cleaned.company === "object") {
    cleaned.company = {
      name: cleaned.company.name,
      name_en: cleaned.company.name_en,
      name_ar: cleaned.company.name_ar,
      logo: cleaned.company.logo,
      // Booth number lives on the company object — keep it so the assistant can
      // show "developer name - Booth Number: N".
      boothNumber: cleaned.company.boothNumber,
    };
  }

  if (prop.imgs) {
    cleaned.images = prop.imgs;
  }

  return cleaned;
}

function _buildQuery(filters) {
  const params = new URLSearchParams();

  params.append("mode", "all"); // Always flag the request as AI-driven — constant true, sent on every request.
  if (filters.country != null) params.append("country", filters.country);
  if (filters.companyId != null) params.append("company", filters.companyId);
  // `location` accepts a single id OR several at once as a comma-separated list
  // (verified against the live API: it returns the union, deduped server-side).
  if (filters.locationId != null) {
    const loc = Array.isArray(filters.locationId)
      ? filters.locationId.join(",")
      : filters.locationId;
    params.append("location", loc);
  }
  if (filters.cityId != null) params.append("city", filters.cityId);
  if (filters.type) params.append("type", filters.type);
  if (filters.categoryId != null) params.append("category", filters.categoryId);
  // Bedroom / apartment-unit-type filter. The Byit API matches this against the
  // apartment unit `type` enum (e.g. THREE-BEDROOM, STUDIO, DUPLEX) — NOT a
  // numeric count (bedroom=3 returns nothing). Only apartment-style types are
  // routed here by the caller; villa types are filtered client-side.
  if (filters.bedroom) params.append("bedroom", filters.bedroom);
  // Price range. The Byit API only filters when BOTH bounds are present (it
  // matches project.startingPrice), so the caller always sends them as a pair.
  if (filters.priceFrom != null) params.append("priceFrom", filters.priceFrom);
  if (filters.priceTo != null) params.append("priceTo", filters.priceTo);
  // Server-side page number (1-based). Omitting it returns page 1 by default.
  if (filters.page != null && filters.page > 1) params.append("page", filters.page);
  // mode=all signals a full-dataset analytics fetch; omit for standard paginated requests.
  if (filters.mode === "all") params.append("mode", "all");
  // Always flag the request as AI-driven — constant true, sent on every request.
  params.append("forAiResult", "true");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// Unit arrays that carry per-unit availability/pricing on each property.
const UNIT_KEYS = ["apartments", "villas", "mall"];

/**
 * Is this property available? The /properties/developers/get endpoint NO LONGER
 * carries a top-level `available` flag — availability is now PER UNIT. So a
 * property counts as available when it has at least one available unit with a
 * real price (> 0). (Previously this was `p.available === true`; that field was
 * removed in the new response structure, which would otherwise filter every
 * property out and return zero results for all searches.)
 */
function hasAvailableUnit(p) {
  const proj = p?.project || {};
  return UNIT_KEYS.some(
    (k) =>
      Array.isArray(proj[k]) &&
      proj[k].some((u) => u && u.available === true && (u.price || 0) > 0)
  );
}

/**
 * Fetch raw properties from the Byit API with server-side filters.
 * Country is sent in the `country` request HEADER (not as a query param) —
 * matches the /categories convention. Everything else (company, location,
 * type, category) still goes in the query string.
 */
export async function fetchRawProperties(filters = {}) {
  const { country, ...queryFilters } = filters;
  const url = `${BYIT_API_BASE}${BYIT_API_PATHS.properties}${_buildQuery(queryFilters)}`;
  const headers = { ...NO_CACHE_HEADERS };
  if (country != null) headers["country"] = String(country);
  console.log(`[byit-api] GET ${url} (country header: ${country ?? "none"})`);
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`Byit API error: ${resp.status}`);
  const json = await resp.json();
  const data = (json.data || []).filter(hasAvailableUnit);
  return {
    data,
    propertiesCount: json.propertiesCount ?? data.length,
    pageCount: json.pageCount ?? 1,
  };
}

/** Fetch cleaned/stripped properties (derived from raw fetch). */
export async function fetchProperties(filters = {}) {
  const raw = await fetchRawProperties(filters);
  return raw.map(stripProperty);
}

/**
 * Fetch property categories. Country is sent in the `country` request header
 * (NOT as a query param) — that's what the /categories endpoint expects to
 * scope results per country. Always fetches fresh — no caching.
 */
export async function fetchCategories(countryId) {
  const url = `${BYIT_API_BASE}${BYIT_API_PATHS.categories}`;
  const headers = { ...NO_CACHE_HEADERS };
  if (countryId != null) headers["country"] = String(countryId);
  console.log(`[byit-api] GET ${url} (country header: ${countryId ?? "none"})`);
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`Byit API error: ${resp.status}`);
  const json = await resp.json();
  const data = json.data || [];

  return data.map((c) => ({
    id: c.id,
    name: c.categoryName || c.name,
    name_en: c.categoryName_en || c.name_en,
    name_ar: c.categoryName_ar || c.name_ar,
  }));
}

/**
 * Resolve a category name (English or Arabic) to a numeric category ID for the
 * given country. The Byit API only accepts numeric `category` IDs server-side
 * — name search isn't supported — so we fetch the (small) categories list,
 * scoped via the country header, and match locally. Returns null if no match.
 */
export async function resolveCategoryId(name, countryId) {
  if (!name) return null;
  const search = name.toLowerCase();
  const categories = await fetchCategories(countryId);

  const exact = categories.find(
    (c) =>
      (c.name_en || "").toLowerCase() === search ||
      (c.name || "").toLowerCase() === search ||
      (c.name_ar || "") === name
  );
  if (exact) return exact.id;

  // Partial match in BOTH directions so a plural / longer query still matches a
  // singular catalog name (e.g. the model says "apartments" / "شقق" but the
  // category is stored as "Apartment" / "شقة"). A one-directional includes()
  // would miss this and make the whole search short-circuit to zero results.
  const containsEither = (catName, query) =>
    !!catName && !!query && (catName.includes(query) || query.includes(catName));

  const partial = categories.find(
    (c) =>
      containsEither((c.name_en || "").toLowerCase(), search) ||
      containsEither((c.name || "").toLowerCase(), search) ||
      containsEither(c.name_ar || "", name)
  );
  return partial?.id ?? null;
}

/**
 * Fetch cities for a country. The endpoint puts countryId in the URL PATH:
 *   GET /countries/{countryId}/cities/withoutPagenation/get
 * Always fetches fresh — no caching.
 */
export async function fetchCities(countryId) {
  if (countryId == null) return [];

  const url = `${BYIT_API_BASE}/countries/${countryId}/cities/withoutPagenation/get`;
  console.log(`[byit-api] GET ${url}`);
  const resp = await fetch(url, { headers: NO_CACHE_HEADERS });
  if (!resp.ok) throw new Error(`Byit API error: ${resp.status}`);
  const json = await resp.json();
  const data = json.data || [];

  return data.map((c) => ({
    id: c.id,
    name: c.name,
    name_en: c.name_en,
    name_ar: c.name_ar,
  }));
}

/**
 * Resolve a city name (English or Arabic) to a numeric city ID for the given
 * country. Mirrors resolveCompanyId / resolveCategoryId. Hyphens and spaces
 * are normalized so the DB form "Ras al-Khaimah" matches user input
 * "Ras Al Khaimah" and similar.
 */
export async function resolveCityId(name, countryId) {
  if (!name || countryId == null) return null;
  const cities = await fetchCities(countryId);

  const norm = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[\-‐-―]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const search = name.toLowerCase();
  const cityKey = norm(name);

  const exact = cities.find(
    (c) =>
      (c.name_en || "").toLowerCase() === search ||
      (c.name || "").toLowerCase() === search ||
      (c.name_ar || "") === name ||
      norm(c.name_en) === cityKey ||
      norm(c.name) === cityKey
  );
  if (exact) return exact.id;

  const partial = cities.find(
    (c) => {
      const en = norm(c.name_en);
      const nm = norm(c.name);
      return (
        (en && (en.includes(cityKey) || cityKey.includes(en))) ||
        (nm && (nm.includes(cityKey) || cityKey.includes(nm))) ||
        (c.name_ar || "").includes(name)
      );
    }
  );
  return partial?.id ?? null;
}

/** Fetch developer companies, optionally scoped by country. Always fetches fresh — no caching. */
export async function fetchCompanies(filters = {}) {
  const url = `${BYIT_API_BASE}${BYIT_API_PATHS.companies}${_buildQuery(filters)}`;
  console.log(`[byit-api] GET ${url}`);
  const resp = await fetch(url, { headers: NO_CACHE_HEADERS });
  if (!resp.ok) throw new Error(`Byit API error: ${resp.status}`);
  const json = await resp.json();
  const data = json.data || [];

  return data.map((c) => ({
    id: c.id,
    name: c.name,
    name_en: c.name_en,
    name_ar: c.name_ar,
    logo: c.logo,
    type: c.type,
  }));
}

/**
 * Extract unique developer companies (with boothNumber) from the properties
 * response. The company object embedded in each property carries boothNumber,
 * which the dedicated /companies endpoint does not return. Deduplicates by id
 * when present, falls back to normalized name. Always fetches fresh — no caching.
 */
export async function fetchCompaniesFromProperties(countryId) {
  const { data: raw } = await fetchRawProperties({ country: countryId });
  const seen = new Set();
  const companies = [];
  for (const prop of raw) {
    const c = prop.company;
    if (!c) continue;
    const dedupeKey =
      c.id != null
        ? `id:${c.id}`
        : `name:${(c.name_en || c.name || "").trim().toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    companies.push({
      id: c.id,
      name: c.name,
      name_en: c.name_en,
      name_ar: c.name_ar,
      logo: c.logo,
      boothNumber: c.boothNumber,
    });
  }
  return companies;
}

/**
 * Dedicated retrieval path for developer project listing.
 * Calls /projects/withoutPagenation/get — the source of truth for projects.
 *
 * If companyId is known, passes it as a server-side filter (fast, scoped).
 * If companyId is null (name resolution failed), fetches all projects and
 * filters locally by developer name so a name-mismatch between sources never
 * causes an empty result.
 *
 * @param {string} developerName  original requested name (for local fallback filter)
 * @param {number|null} companyId resolved company id (or null)
 * @param {number} countryId
 * @returns {Promise<any[]>}  raw project rows from the API
 */
export async function fetchDeveloperProjects(developerName, companyId, countryId) {
  const params = new URLSearchParams();
  if (companyId != null) params.append("company", companyId);
  params.append("forAiResult", "true");
  params.append("other", "false");
  const qs = params.toString();
  const url = `${BYIT_API_BASE}${BYIT_API_PATHS.projects}${qs ? `?${qs}` : ""}`;
  const headers = { ...NO_CACHE_HEADERS };
  if (countryId != null) headers["country"] = String(countryId);
  console.log(`[Developer Projects] endpoint called: ${url}`);
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`Byit API error: ${resp.status}`);
  const json = await resp.json();
  const data = json.data || [];
  console.log(`[Developer Projects] projects returned: ${data.length}`);

  // When company ID was resolved server-side filters already scoped the results.
  if (companyId != null) return data;

  // No company ID — filter locally by developer name so a name mismatch between
  // /companies and properties never causes a false empty result.
  if (!developerName) return data;
  const search = developerName.toLowerCase();
  const filtered = data.filter((p) => {
    const c = p.company || {};
    return (
      (c.name_en || "").toLowerCase().includes(search) ||
      search.includes((c.name_en || "").toLowerCase()) ||
      (c.name || "").toLowerCase().includes(search) ||
      (c.name_ar || "").includes(developerName)
    );
  });
  console.log(`[Developer Projects] after name filter: ${filtered.length}`);
  return filtered;
}

/**
 * Resolve a developer name (English or Arabic) to a numeric company ID.
 * The Byit API only accepts numeric `company` IDs — name search isn't supported,
 * so we fetch the (small) company list once per call and match locally.
 * Returns null if no match.
 */
export async function resolveCompanyId(name, countryId) {
  if (!name) return null;
  const search = name.toLowerCase();
  const companies = await fetchCompanies({ country: countryId });

  const exact = companies.find(
    (c) =>
      (c.name_en || "").toLowerCase() === search ||
      (c.name || "").toLowerCase() === search ||
      (c.name_ar || "") === name
  );
  if (exact) return exact.id;

  const partial = companies.find(
    (c) =>
      (c.name_en || "").toLowerCase().includes(search) ||
      (c.name || "").toLowerCase().includes(search) ||
      (c.name_ar || "").includes(name)
  );
  return partial?.id ?? null;
}

// Classic iterative Levenshtein with two rolling rows — O(m·n) time, O(n) space.
function _levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Fuzzy match a location name against the full list. Catches transliteration
 * drift and DB typos (e.g. user "Nasr City" → DB row "Naser City").
 *
 * Strategy, in priority order:
 *   1. Arabic input → substring match on name_ar
 *   2. English substring match in either direction on name / name_en
 *   3. Levenshtein within a length-proportional threshold (max(2, len/4))
 */
async function _fuzzyResolveLocation(name) {
  const url = `${BYIT_API_BASE}${BYIT_API_PATHS.locations}`;
  console.log(`[byit-api] GET ${url} (full list for fuzzy match)`);
  const resp = await fetch(url, { headers: NO_CACHE_HEADERS });
  if (!resp.ok) return null;
  const json = await resp.json();
  const rows = json.data || [];
  if (!rows.length) return null;

  const search = name.trim();
  const lower = search.toLowerCase();

  if (/[؀-ۿ]/.test(search)) {
    const arHit = rows.find((r) => (r.name_ar || "").includes(search));
    if (arHit) return arHit;
  }

  const subHit = rows.find((r) => {
    const en = (r.name_en || "").toLowerCase();
    const nm = (r.name || "").toLowerCase();
    return (
      (en && (en.includes(lower) || lower.includes(en))) ||
      (nm && (nm.includes(lower) || lower.includes(nm)))
    );
  });
  if (subHit) return subHit;

  const threshold = Math.max(2, Math.floor(lower.length / 4));
  let best = null;
  let bestDist = Infinity;
  for (const r of rows) {
    for (const candidate of [r.name_en, r.name].filter(Boolean)) {
      const d = _levenshtein(lower, candidate.toLowerCase());
      if (d < bestDist) { bestDist = d; best = r; }
    }
  }
  return best && bestDist <= threshold ? best : null;
}

/**
 * Resolve a location name (English or Arabic) to a numeric location ID via the
 * Byit Location API: GET /location/withoutPagenation/get?search={name}.
 *
 * Sends the search term verbatim (after a trim) — no country param, no token
 * normalization. The API's stored names are the source of truth; some rows
 * include "City" (e.g. "Naser City") and some don't (e.g. "New Cairo"), so any
 * client-side stripping or appending corrupts recall.
 *
 * If the targeted search returns nothing, falls back to a fuzzy match against
 * the full list — covers DB typos / transliteration drift like "Nasr" → "Naser".
 *
 * Returns:
 *   - { id, name } on a confident match (exact or fuzzy)
 *   - null when neither path finds a usable id
 *
 * Throws on transport errors / non-404 HTTP failures so the caller can decide.
 */
export async function resolveLocationId(name) {
  const search = (name || "").trim();
  if (!search) return null;

  // encodeURIComponent (space → %20) — the API rejects "+" as a literal.
  const url = `${BYIT_API_BASE}${BYIT_API_PATHS.locations}?search=${encodeURIComponent(search)}`;
  console.log(`[byit-api] GET ${url}`);

  const resp = await fetch(url, { headers: NO_CACHE_HEADERS });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Byit Location API error: ${resp.status}`);
  }

  let candidates = [];
  if (resp.ok) {
    const json = await resp.json();
    const data = json.data;
    if (data) candidates = Array.isArray(data) ? data : [data];
  }

  let pick = null;
  if (candidates.length > 0) {
    const lower = search.toLowerCase();
    pick =
      candidates.find(
        (l) =>
          (l.name_en || "").toLowerCase() === lower ||
          (l.name || "").toLowerCase() === lower ||
          (l.name_ar || "") === search
      ) || candidates[0];
  } else {
    // Targeted search empty → try fuzzy match against the full list.
    pick = await _fuzzyResolveLocation(search);
    if (pick) {
      console.log(
        `[byit-api] fuzzy-matched "${search}" → id ${pick.id} (${pick.name_en || pick.name})`
      );
    }
  }

  return !pick || pick.id == null
    ? null
    : {
        id: pick.id,
        name: pick.name_en || pick.name || pick.name_ar || String(pick.id),
      };
}

// Per-session buffer of the latest raw search results — used by the image
// collector in server.js. This is request-scoped state, not a cache: it holds
// only the data from the most recent search_properties call for a given session
// so we can match project names in the response back to image URLs.
const _lastSearchBySession = new Map();

export function rememberRawForSession(sessionId, raw) {
  if (!sessionId) return;
  _lastSearchBySession.set(sessionId, raw || []);
}

export function getRawForSession(sessionId) {
  return _lastSearchBySession.get(sessionId) || [];
}

export function clearRawForSession(sessionId) {
  _lastSearchBySession.delete(sessionId);
}
