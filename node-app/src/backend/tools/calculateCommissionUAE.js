/** Calculate broker reward for a UAE property deal. */

import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { fetchRawProperties } from "../cache.js";
import { translateArabic } from "./arabicMap.js";
import { projectMatches } from "./projectMatch.js";

const UAE_COUNTRY_ID = 7;
const TAX_RATE = 0.09;

export function createCalculateCommissionUAE() {
  return tool({
    name: "calculate_commission",
    description:
      "MUST be called whenever a UAE user asks about reward, commission, earnings, profit, " +
      "or how much they will make on a deal. Automatically fetches commission rates and unit " +
      "prices from the API, applies the 9% UAE tax, and returns the net reward per vendor in AED. " +
      "NEVER refuse a reward/commission question.",
    inputSchema: z.object({
      project_id: z.number().optional().describe("Unique project ID from a prior search_properties result — use this for exact matching when available"),
      project_name: z.string().describe("Name of the project"),
      unit_type: z.string().default("").describe("Unit type, e.g. ONE-BEDROOM, TWIN"),
      property_value: z.number().default(0).describe("Property value (optional, auto-detected)"),
      language: z.string().default("English").describe("Response language: 'Arabic' or 'English'"),
    }),
    callback: async (input) => {
      let { project_id, project_name, unit_type, property_value, language } = input;
      const isArabic = (language || "").toLowerCase().includes("ar");
      const isBest = unit_type && unit_type.toUpperCase() === "BEST";

      project_name = translateArabic(project_name);
      unit_type = translateArabic(unit_type);

      const { data: rawProperties } = await fetchRawProperties({
        country: UAE_COUNTRY_ID,
        type: "RELATED-TO-COMPOUND",
      });
      const matching = rawProperties.filter((p) => projectMatches(p.project, project_name, project_id));

      if (matching.length === 0) {
        return JSON.stringify({
          error: `No project found matching "${project_name}". Try a different name.`,
        });
      }

      const prop = matching[0];
      const project = prop.project;
      const vendors = project.vendors || [];

      if (vendors.length === 0) {
        return JSON.stringify({
          error: `No vendor commission data for project "${project.name_en || project.name}".`,
        });
      }

      let value = property_value;
      let unitFound = true;

      const allProjectUnits = [
        ...(project.apartments || []),
        ...(project.villas || []),
        ...(project.mall || []),
      ].filter((u) => u.available && (u.price || 0) > 0);

      if (isBest) {
        let bestUnit = null;
        let bestComm = 0;
        for (const u of allProjectUnits) {
          const grossTest = u.price * ((vendors[0]?.ratio || 0) / 100);
          if (grossTest > bestComm) {
            bestComm = grossTest;
            bestUnit = u;
          }
        }
        if (bestUnit) {
          unit_type = bestUnit.type;
          value = bestUnit.price;
        }
      }

      if (!value && unit_type) {
        const searchType = unit_type.toUpperCase();
        const matched = allProjectUnits.find((u) => u.type === searchType);
        if (matched) {
          value = matched.price;
        } else {
          unitFound = false;
          const cheapest = allProjectUnits.sort((a, b) => a.price - b.price)[0];
          if (cheapest) {
            value = cheapest.price;
            unit_type = cheapest.type;
          }
        }
      }

      if (!value && (project.startingPrice || 0) > 0) {
        value = project.startingPrice;
      }

      if (!value) {
        return JSON.stringify({
          error: `Could not determine unit price for "${project.name_en || project.name}". Please provide the property value.`,
        });
      }

      console.log(`[commission-UAE] vendors count: ${vendors.length}`);
      vendors.forEach((v, i) => {
        console.log(`[commission-UAE] vendor[${i}]: name=${v.name_en || v.name}, ratio=${v.ratio}, netRatio=${v.netRatio}`);
      });

      const vendorCommissions = vendors.map((v) => {
        const normalRate = v.ratio ?? 0;
        const netRatio = v.netRatio ?? 0;
        const gross = value * (normalRate / 100);
        const afterTax = gross - gross * TAX_RATE;
        return {
          vendor_name: v.name_en || v.name,
          normal_commission_egp: Math.round(afterTax * (netRatio / 100)),
        };
      });

      const currency = isArabic ? "درهم" : "AED";
      const rewardLabel = isArabic ? "المكافأة" : "Reward";
      const fmt = (n) => Math.round(n).toLocaleString("en-US");

      const priceLabel = isArabic
        ? `💰 سعر الوحدة: ${fmt(value)} ${currency}`
        : `💰 Unit Price: ${fmt(value)} ${currency}`;

      const unitNote = !unitFound
        ? (isArabic
          ? `(الوحدة المطلوبة غير متوفرة — تم الحساب على أساس أرخص وحدة متاحة: ${unit_type})`
          : `(Requested unit not available — calculated based on cheapest unit: ${unit_type})`)
        : null;

      let formatted_result;

      if (isBest) {
        const winner = vendorCommissions.reduce((a, b) =>
          b.normal_commission_egp > a.normal_commission_egp ? b : a
        );

        const winnerLines = isArabic
          ? [
              `🏆 أعلى مكافأة من: ${winner.vendor_name}`,
              priceLabel,
              unitNote,
              `- ${rewardLabel}: ${fmt(winner.normal_commission_egp)} ${currency}`,
            ]
          : [
              `🏆 Best reward from: ${winner.vendor_name}`,
              priceLabel,
              unitNote,
              `- ${rewardLabel}: ${fmt(winner.normal_commission_egp)} ${currency}`,
            ];

        formatted_result = winnerLines.filter(Boolean).join("\n");
      } else {
        const vendorLines = vendorCommissions.map((v) => {
          const header = isArabic ? `💼 المورد: ${v.vendor_name}` : `💼 Vendor: ${v.vendor_name}`;
          const reward = `- ${rewardLabel}: ${fmt(v.normal_commission_egp)} ${currency}`;
          return [header, reward].join("\n");
        }).join("\n\n");

        formatted_result = [priceLabel, unitNote, vendorLines].filter(Boolean).join("\n\n");
      }

      console.log(`[commission-UAE] formatted_result:\n${formatted_result}`);

      return JSON.stringify({
        ...(isBest ? { type: "BEST_COMMISSION_RESULT" } : {}),
        formatted_result,
        vendor_count: vendorCommissions.length,
      });
    },
  });
}
