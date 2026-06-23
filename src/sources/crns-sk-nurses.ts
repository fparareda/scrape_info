/**
 * College of Registered Nurses of Saskatchewan (CRNS) — public register.
 *
 *   https://crns.alinityapp.com/Client/PublicDirectory
 *
 * Universe: ~15,000 Registered Nurses (RNs) and Nurse Practitioners (NPs)
 * in Saskatchewan. The existing `clpns-sk-nurses` source (open PR) covers
 * Licensed Practical Nurses — a different licence class — so there is no
 * overlap.
 *
 * Pre-flight (2026-06-22):
 *   robots.txt returns 404 (no restrictions). No login, no CAPTCHA observed.
 *   Alinity public directory shell at /Client/PublicDirectory loads with a
 *   `querySID` value in the HTML. Same POST /Registrants endpoint and
 *   alphabetical-enumeration strategy used by 15+ other Canadian regulators
 *   already in this repo (CPSA, CPM, LSS-SK, CAP-psychologists, etc.).
 *   Response fields confirmed: `rn` (registration number), `fn` (first name),
 *   `ln` (last name), `mcn` (practice city), `reg` (registration status).
 *
 * Category: enfermeria. Province: SK. Authority: CRNS.
 * Off by default — `PROLIO_RUN_CRNS_SK_NURSES=true`.
 * Cap: `PROLIO_CRNS_SK_NURSES_LIMIT` (default 20 000).
 * Monthly cadence via .github/workflows/scrape-crns-sk-nurses.yml.
 */

import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

const TENANT = "crns";
const AUTHORITY = "CRNS";
const PROVINCE = "SK";
const DEFAULT_LIMIT = 20_000;

const CITY_MAP: Record<string, string> = {
  saskatoon: "saskatoon",
  regina: "regina",
  "prince albert": "prince-albert",
  "moose jaw": "moose-jaw",
  "swift current": "swift-current",
  yorkton: "yorkton",
  "north battleford": "north-battleford",
  estevan: "estevan",
  weyburn: "weyburn",
  lloydminster: "lloydminster",
  "la ronge": "la-ronge",
  humboldt: "humboldt",
  "meadow lake": "meadow-lake",
  melfort: "melfort",
  battleford: "north-battleford",
};
const DEFAULT_CITY = "saskatoon";

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return CITY_MAP[k] ?? DEFAULT_CITY;
}

export const crnsSkNursesSource: ScraperSource = {
  name: "crns-sk-nurses" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CRNS_SK_NURSES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCrnsSkNurses(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!crnsSkNursesSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_CRNS_SK_NURSES_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for await (const rec of fetchAlinityDirectory(TENANT, { limit: cap })) {
    const key = `crns-sk-nurses:${rec.registrationNumber ?? `${rec.name}|${rec.city ?? ""}`}`;
    if (seen.has(key)) continue;
    seen.add(key);

    records.push(
      normalise({
        source: "crns-sk-nurses" as ScrapeSource,
        country: "CA",
        sourceId: key,
        name: toTitleCase(rec.name),
        categoryKey: "enfermeria",
        citySlug: mapCity(rec.city),
        licenseNumber: rec.registrationNumber,
        metadata: {
          country: "CA",
          province: PROVINCE,
          authority: AUTHORITY,
          verified_by_authority: true,
          status: rec.status,
        },
      }),
    );
  }

  if (records.length === 0) {
    console.warn(
      `[crns-sk-nurses] no rows — Alinity endpoint may have changed or tenant moved`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[crns-sk-nurses] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
