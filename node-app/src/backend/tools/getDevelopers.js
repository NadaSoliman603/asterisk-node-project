import Fuse from "fuse.js";
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { fetchCompaniesFromProperties } from "../cache.js";
import { translateArabic } from "./arabicMap.js";

export function createGetDevelopers(countryId) {
  const cid = Number(countryId) || 50;

  // 🔥 normalize helper (مهم للعربي + الإنجليزي)
  const normalize = (s = "") =>
    s
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[إأآا]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ؤ|ئ/g, "ء");

  function fuzzySearch(list, text) {
    if (!text) return list;

    const fuse = new Fuse(list, {
      keys: ["name_en_norm", "name_ar_norm"],
      threshold: 0.5,
      ignoreLocation: true,
      minMatchCharLength: 1,
    });

    return fuse.search(text).map(r => r.item);
  }

  return tool({
    name: "get_developers",
    description:
      "List or search real estate developer companies used for exhibition listing.",

    inputSchema: z.object({
      name: z.string().default("").describe("Developer name to search for (optional)"),
      language: z.string().default("English").describe("'Arabic' or 'English' output preference"),
      show_all: z.boolean().default(false).describe("If true returns full dataset"),
    }),

    callback: async (input) => {
      console.log("get_developers input", input);

      let { name, language, show_all } = input;

      let companies = await fetchCompaniesFromProperties(cid);

      // 🔥 step 1: normalize dataset
      companies = companies.map(c => ({
        ...c,
        name_en_norm: normalize(c.name_en),
        name_ar_norm: normalize(c.name_ar),
      }));

      // 🔥 step 2: normalize input
      name = normalize(translateArabic(name || ""));

      let results = companies;

      // 🔥 step 3: fuzzy search (no pre-filter blocking!)
      if (name) {
        results = fuzzySearch(results, name);
      }

      // optional: show_all logic (no slicing bugs)
      const filtered = show_all ? results : results;

      const developers = filtered
        .filter(c => c.name_en)
        .map(c => ({
          id: c.id,
          name: c.name_en,
          ...(c.boothNumber != null ? { boothNumber: c.boothNumber } : {}),
        }));

      return JSON.stringify({
        developers,
        meta: {
          total: results.length,
          returned: developers.length,
          hasMore: false,
        },
      });
    },
  });
}

export const getDevelopers = createGetDevelopers(50);