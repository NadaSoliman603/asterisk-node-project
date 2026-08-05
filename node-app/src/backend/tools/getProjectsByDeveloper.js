/** List projects for a specific developer (compound-only, country-scoped). */

import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { fetchDeveloperProjects, resolveCompanyId } from "../cache.js";
import { translateArabic } from "./arabicMap.js";

export function createGetProjectsByDeveloper(countryId) {
  const cid = Number(countryId) || 50;
  return tool({
    name: "get_projects_by_developer",
    description:
      "Return the list of projects for a given developer (compound projects only). " +
      "Use when the user asks for projects belonging to a developer: " +
      "'مشاريع سوديك', 'what projects does Palm Hills have?', 'Projects by SODIC'. " +
      "Returns { id, name } per project with a hasMore flag. Max 10 by default — pass show_all=true for the full list. " +
      "CRITICAL: The response includes mandatory_output_count. You MUST enumerate exactly that many projects — " +
      "no more, no less. Never drop, skip, summarize, or merge projects. Each project is a separate item.",
    inputSchema: z.object({
      developer_name: z.string().describe("Developer name (English or Arabic)"),
      developer_id: z.number().default(0).describe("Optional developer id — if provided, use this instead of name"),
      language: z.string().default("English").describe("'Arabic' or 'English'"),
      show_all: z.boolean().default(false).describe("Return all projects without the 10-item cap"),
    }),
    callback: async (input) => {
      const { developer_id, language, show_all } = input;
      let { developer_name } = input;
      const isArabic = (language || "").toLowerCase().includes("ar");

      developer_name = translateArabic(developer_name || "");
      console.log(`[Developer Projects] developer: "${developer_name}" (id hint: ${developer_id || "none"})`);

      // Resolve company ID — used as a server-side filter on the projects endpoint.
      // If resolution fails (name mismatch between sources), fetchDeveloperProjects
      // falls back to local name filtering on the full project list so a mismatch
      // never silently returns zero results.
      let companyId = developer_id || null;
      if (!companyId && developer_name) {
        companyId = await resolveCompanyId(developer_name, cid);
      }
      console.log(`[Developer Projects] resolved company id: ${companyId ?? "null (will fallback to name filter)"}`);

      // Use the dedicated projects endpoint — independent of fetchRawProperties
      // and its hasAvailableUnit availability gate.
      const raw = await fetchDeveloperProjects(developer_name, companyId, cid);

      const hasArabic = (s) => typeof s === "string" && /[؀-ۿ]/.test(s);
      const pickArabic = (...candidates) => {
        for (const c of candidates) if (hasArabic(c)) return c;
        for (const c of candidates) if (c) return c;
        return "";
      };

      const seen = new Set();
      const projects = [];
      for (const p of raw) {
        // Projects endpoint may return project objects directly or as { project: {...} }
        const proj = p.project || p;
        const projId = proj.id ?? proj._id;
        if (!proj || projId == null || seen.has(projId)) continue;
        seen.add(projId);
        projects.push({
          id: projId,
          name: isArabic
            ? pickArabic(proj.name_ar, proj.name, proj.name_en)
            : (proj.name_en || proj.name || ""),
          offers: Array.isArray(proj.offers) ? proj.offers : [],
        });
      }

      projects.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

      const total = projects.length;
      const limit = show_all ? projects.length : 10;
      const sliced = projects.slice(0, limit);

      console.log(`[Developer Projects] projects sent to model: ${sliced.length} (total=${total}, hasMore=${sliced.length < total})`);

      return JSON.stringify({
        mandatory_output_count: sliced.length,
        projects: sliced,
        meta: { total, returned: sliced.length, hasMore: sliced.length < total },
      });
    },
  });
}
