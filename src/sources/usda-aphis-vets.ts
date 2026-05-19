import type { ScrapedProfessional, ScraperSource } from "../types.js";

/**
 * USDA APHIS Accredited Veterinarians — federal accreditation list.
 *
 * URL:        https://www.aphis.usda.gov/animal_health/vet_accreditation/
 * Tool:       https://www.aphis.usda.gov/aphis/ourfocus/animalhealth/veterinary-accreditation/SA_Find_an_Accredited_Vet
 * Categoría:  veterinario (US, ~50k accredited vets)
 *
 * --- 2026-05-18 pre-flight probe (datacenter IP) ----------------------
 *   GET https://www.aphis.usda.gov/animal_health/vet_accreditation/
 *     → curl: HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR
 *   GET https://www.aphis.usda.gov/animal-health/vet-accreditation/find-vet
 *     → curl: operation timed out after 10s, 0 bytes received (--http1.1)
 *
 * Both the legacy and the redesigned URLs are unreachable from a cloud
 * runner — APHIS sits behind a CDN that throttles or drops non-residential
 * traffic. There is no published bulk dataset (FOIA-only per the agency
 * FAQ) and the "Find an Accredited Vet" widget is a server-side ASP.NET
 * page that requires a stateful session.
 *
 * Per CLAUDE.md "no Playwright, no fake data" → STUB.
 *
 * Reactivate when:
 *   a) USDA APHIS publishes the accredited-vet roster on
 *      data.gov / catalog.data.gov (track:
 *      https://catalog.data.gov/organization/aphis-gov),
 *   b) we run via residential proxy,
 *   c) a FOIA-released spreadsheet is hosted at a stable URL we can
 *      point `PROLIO_USDA_APHIS_VETS_CSV` at.
 */

export const usdaAphisVetsSource: ScraperSource = {
  name: "usda-aphis-vets",
  enabled() {
    return process.env.PROLIO_RUN_USDA_APHIS_VETS === "true";
  },
  async fetch(): Promise<ScrapedProfessional[]> {
    const overrideCsv = process.env.PROLIO_USDA_APHIS_VETS_CSV;
    if (overrideCsv) {
      console.warn(
        `[usda-aphis-vets] CSV override set (${overrideCsv}) — generic CSV ingest not implemented yet. Drop the file into the bulk loader once schema is known. Returning [].`,
      );
      return [];
    }
    console.warn(
      "[usda-aphis-vets] STUB — APHIS site is unreachable from cloud egress " +
        "(probed 2026-05-18: TCP/H2 reset / timeout). No public bulk dataset. " +
        "Returning [].",
    );
    return [];
  },
};

export async function runUsdaAphisVets(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!usdaAphisVetsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  console.warn(
    "[usda-aphis-vets] enabled but pipeline is a stub — see source header.",
  );
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
