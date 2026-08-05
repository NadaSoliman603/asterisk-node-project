/** Returns available unit types for a project so the bot can list them for the user. */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { fetchRawProperties } from "../cache.js";
import { translateArabic } from "./arabicMap.js";
import { projectMatches } from "./projectMatch.js";

const UNIT_KEYS = ["apartments", "villas", "mall"];

const UNIT_LABELS = {
  en: {
    "ONE-BEDROOM": "1 Bedroom", "TWO-BEDROOM": "2 Bedrooms",
    "THREE-BEDROOM": "3 Bedrooms", "FOUR-BEDROOM": "4 Bedrooms",
    "STUDIO": "Studio", "DUPLEX": "Duplex", "TWIN": "Twin House",
    "TOWN": "Townhouse", "STAND-ALONE": "Standalone Villa", "S-VILLA": "Semi Villa",
    "APARTMENT": "Apartment", "VILLA": "Villa",
    "SERVICE-APARTMENT": "Service Apartment",
    "CLINIC": "Clinic", "OFFICE": "Office", "SHOP": "Shop", "PHARMACY": "Pharmacy",
  },
  ar: {
    "ONE-BEDROOM": "غرفة نوم واحدة", "TWO-BEDROOM": "غرفتين نوم",
    "THREE-BEDROOM": "3 غرف نوم", "FOUR-BEDROOM": "4 غرف نوم",
    "STUDIO": "استوديو", "DUPLEX": "دوبلكس", "TWIN": "توين هاوس",
    "TOWN": "تاون هاوس", "STAND-ALONE": "فيلا مستقلة", "S-VILLA": "سيمي فيلا",
    "APARTMENT": "شقة", "VILLA": "فيلا",
    "SERVICE-APARTMENT": "شقة فندقية",
    "CLINIC": "عيادة", "OFFICE": "مكتب", "SHOP": "محل", "PHARMACY": "صيدلية",
  },
};

export function createRequestUnitSelection(countryId) {
  return tool({
  name: "request_unit_selection",
  description:
    "Call this when a user asks about commission WITHOUT specifying a unit type. " +
    "Returns the available unit types for that project so you can list them for the user.",
  inputSchema: z.object({
    project_name: z.string().describe("Name of the project (in English)"),
    language: z.string().default("English").describe("'Arabic' or 'English'"),
  }),
  callback: async ({ project_name, language }) => {
    const isArabic = (language || "").toLowerCase().includes("ar");
    const translated = translateArabic(project_name);

    // Server-side filter by country + compound type; project name is text-
    // matched client-side (Byit API has no text search).
    const properties = await fetchRawProperties({
      country: Number(countryId) || undefined,
      type: "RELATED-TO-COMPOUND",
    });

    const matching = properties.filter(
      (p) =>
        projectMatches(p.project, project_name) ||
        projectMatches(p.project, translated)
    );

    if (matching.length === 0) {
      return JSON.stringify({ error: `No project found matching "${project_name}"` });
    }

    // Use the best-matched project (closest name length to query)
    const queryLen = (translated || project_name || "").length;
    const best = matching.reduce((a, b) => {
      const aName = (a.project.name_en || a.project.name || "").toLowerCase();
      const bName = (b.project.name_en || b.project.name || "").toLowerCase();
      return Math.abs(aName.length - queryLen) <= Math.abs(bName.length - queryLen) ? a : b;
    }, matching[0]);

    const proj = best.project || {};
    const projectName = proj.name_en || proj.name || project_name;

    const unitTypesSet = new Set();
    for (const key of UNIT_KEYS) {
      for (const u of proj[key] || []) {
        if (u.available && u.type) unitTypesSet.add(u.type);
      }
    }
    // Fallback: include all types if none marked available
    if (unitTypesSet.size === 0) {
      for (const key of UNIT_KEYS) {
        for (const u of proj[key] || []) {
          if (u.type) unitTypesSet.add(u.type);
        }
      }
    }

    const labels = isArabic ? UNIT_LABELS.ar : UNIT_LABELS.en;
    const units = [...unitTypesSet].map((type) => ({
      type,
      label: labels[type] || type,
    }));

    console.log(`[request_unit_selection] project=${projectName}, units=${units.map(u => u.type).join(",")}`);

    return JSON.stringify({ project: projectName, units });
  },
  });
}
