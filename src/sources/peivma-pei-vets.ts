import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { slugify } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * PEIVMA — Prince Edward Island Veterinary Medical Association.
 * Official Register of licensed veterinarians in PEI.
 *
 *   https://peivma.ca/public-info/official-register/
 *
 * Pre-flight 2026-06-04 (datacenter IP):
 *   HTTP 200, WordPress static HTML, no auth, no JS rendering.
 *   Single page, ~258 rows.
 *   Columns: First Name | Last Name
 *   No pagination, no license numbers, no address.
 *
 * City: charlottetown (PEI capital — all vets assigned there as fallback).
 * Category: veterinario. Country: CA.
 * Off by default. `PROLIO_RUN_PEIVMA_PEI_VETS=true` to enable.
 */

const URL = "https://peivma.ca/public-info/official-register/";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    // Remove Unicode left-to-right mark and similar invisible chars
    .replace(/[‪‫‬‭‮​‌‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const peivmaPeiVetsSource: ScraperSource = {
  name: "colegio" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_PEIVMA_PEI_VETS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runPeivmaPeiVets(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!peivmaPeiVetsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let html: string;
  try {
    const res = await fetch(URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[peivma-pei-vets] HTTP ${res.status}`);
      return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
    }
    html = await res.text();
  } catch (e) {
    console.warn(`[peivma-pei-vets] fetch error: ${(e as Error).message}`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  } finally {
    clearTimeout(timer);
  }

  const records: ScrapedProfessional[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  for (const tr of html.matchAll(trRe)) {
    const cells: string[] = [];
    for (const td of tr[1].matchAll(tdRe)) cells.push(stripTags(td[1]));
    if (cells.length < 2) continue;
    const firstName = cells[0];
    const lastName = cells[1];
    if (!firstName || !lastName) continue;
    // Skip header rows
    if (
      firstName.toLowerCase().includes("first") ||
      lastName.toLowerCase().includes("last")
    )
      continue;

    const name = `${firstName} ${lastName}`.trim();
    const sourceId = `peivma:${slugify(name)}`;
    records.push(
      normalise({
        source: "colegio" as ScrapeSource,
        country: "CA",
        sourceId,
        name,
        categoryKey: "veterinario",
        citySlug: "charlottetown",
        metadata: {
          country: "CA",
          province: "PE",
          authority: "PEIVMA (PEI Veterinary Medical Association)",
          verified_by_authority: true,
        },
      }),
    );
  }

  console.log(`[peivma-pei-vets] parsed ${records.length} vets`);
  if (records.length === 0) {
    console.warn("[peivma-pei-vets] no records — page structure may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[peivma-pei-vets] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
