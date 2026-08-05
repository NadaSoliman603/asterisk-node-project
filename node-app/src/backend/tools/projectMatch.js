/**
 * Project identity resolution.
 *
 * Identity is ALWAYS determined by project_id when available.
 * Name-based lookup is a last resort and uses exact matching only —
 * no substring, no fuzzy, no partial — to prevent collisions between
 * projects with similar names (e.g. "Taj City" vs "Taj Sultan").
 */

function _normalizeLatin(s) {
  // Strip non-letters/digits, collapse repeated chars.
  // "Villette" → "vilete", "Vilette" → "vilete" (handles common transliteration variance).
  return String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/(.)\1+/gu, "$1");
}

/** Strict project_id match — the only truly reliable identity check. */
export function projectMatchesById(project, projectId) {
  if (!project || projectId == null) return false;
  return String(project.id) === String(projectId);
}

/**
 * Exact name match (case-insensitive, whitespace-trimmed).
 * Falls back to transliteration-normalized exact compare so
 * "Villette" still finds "Vilette", but "Taj" will NOT match "Taj City".
 */
export function matchesProjectName(value, query) {
  if (!value || !query) return false;
  const v = String(value).toLowerCase().trim();
  const q = String(query).toLowerCase().trim();
  if (!v || !q) return false;

  if (v === q) return true;

  const vn = _normalizeLatin(v);
  const qn = _normalizeLatin(q);
  if (!vn || !qn) return false;
  return vn === qn;
}

/**
 * Match a property's project against a query.
 *
 * @param {object} project   - The project object from the raw property.
 * @param {string} query     - Name string (used only when projectId is absent).
 * @param {number|string|null} projectId - When provided, matched strictly by ID; name is ignored.
 */
export function projectMatches(project, query, projectId) {
  if (!project) return false;

  // ID-based match takes absolute priority — never falls through to name.
  if (projectId != null && projectId !== 0 && projectId !== "") {
    return projectMatchesById(project, projectId);
  }

  // Exact name match across all name fields — no substring, no fuzzy.
  return (
    matchesProjectName(project.name_en, query) ||
    matchesProjectName(project.name, query) ||
    matchesProjectName(project.name_ar, query)
  );
}
