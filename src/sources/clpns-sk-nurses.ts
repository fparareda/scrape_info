import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * CLPNS — College of Licensed Practical Nurses of Saskatchewan.
 *
 * Public member registry (Alinity tenant: `clpns`):
 *   https://clpns.alinityapp.com/Client/PublicDirectory/
 *
 * Pre-flight 2026-06-18:
 *   - robots.txt: 404 (no file) — fully permissive.
 *   - Alinity public directory: no auth, no captcha. Standard prefix-
 *     enumeration via the POST /Registrants endpoint (same pattern as
 *     `cap-psychologists` / `cptbc-physio` / `mvma-mb-vets`).
 *   - Fields returned: fn (first), ln (last), rn (registration number),
 *     mcn (city/municipality), reg (status), rg (GUID).
 *   - ~8 000–10 000 active SK Licensed Practical Nurse registrants.
 *   - Category: `enfermeria` — LPNs are regulated nurses; closest taxonomy
 *     match. All major CA nursing stubs (CNO-ON, OIIQ-QC, BCCNM-BC,
 *     Alberta-CRNA) are WAF-blocked; CLPNS is the first live CA enfermeria
 *     source.
 *
 * Off by default. Enable via `PROLIO_RUN_CLPNS_SK_NURSES=true`.
 * Monthly cron — LPN registration rolls change slowly.
 */

const TENANT = "clpns";
const AUTHORITY = "CLPNS";
const PROVINCE = "SK";
const CATEGORY: CategoryKey = "enfermeria";
const DEFAULT_CITY = "saskatoon";
const DEFAULT_LIMIT = 15_000;

const CITY_MAP: Record<string, string> = {
  saskatoon: "saskatoon",
  regina: "regina",
  "moose jaw": "moose-jaw",
  "prince albert": "prince-albert",
  "swift current": "swift-current",
  yorkton: "yorkton",
  "north battleford": "north-battleford",
  weyburn: "weyburn",
  estevan: "estevan",
  melfort: "melfort",
  lloydminster: "lloydminster",
  kindersley: "kindersley",
  humboldt: "humboldt",
  moosomin: "moosomin",
  "meadow lake": "meadow-lake",
  "la ronge": "la-ronge",
  "la loche": "la-loche",
};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return CITY_MAP[k] ?? DEFAULT_CITY;
}

export const clpnsSkNursesSource: ScraperSource = {
  name: "clpns-sk-nurses" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CLPNS_SK_NURSES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runClpnsSkNurses(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!clpnsSkNursesSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const limit = Number(process.env.PROLIO_CLPNS_SK_NURSES_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for await (const rec of fetchAlinityDirectory(TENANT, { limit: cap })) {
    const num = rec.registrationNumber ?? rec.registrantGuid ?? `${rec.name}|${rec.city ?? ""}`;
    const key = `clpns-sk-nurses:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "clpns-sk-nurses" as ScrapeSource,
        country: "CA",
        sourceId: key,
        name: toTitleCase(rec.name),
        categoryKey: CATEGORY,
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
    console.warn(`[clpns-sk-nurses] no rows — Alinity endpoint may have changed`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[clpns-sk-nurses] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
