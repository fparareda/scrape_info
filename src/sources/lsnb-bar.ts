import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * LSNB — Law Society of New Brunswick (Barreau du Nouveau-Brunswick).
 *
 * Hosted on Alinity (tenant: `lsbnb` — note: the host's slug uses
 * `lsbnb` not `lsnb`, see https://lsbnb.alinityapp.com/client/publicdirectory).
 * Standard Alinity shell with querySID hidden input and TextOptionA/B
 * form fields for first/last name search. Reuses the shared helper at
 * `_alinity-utils.ts` (recursive 2..N prefix drill on TextOptionB).
 *
 * Roughly ~2k registered lawyers in NB. Source name kept as `lsnb-bar`
 * to align with the regulator's English/French acronym; only the
 * Alinity tenant subdomain differs.
 *
 * Category: `extranjeria` (Prolio's revenue wedge — immigration lawyers).
 * NB has no seeded city slugs (Fredericton/Moncton/Saint John aren't in
 * cities.ts), so all rows default to `halifax` as the nearest seeded
 * Atlantic-CA bucket. The metadata.province=`NB` keeps the provenance.
 *
 * Off by default; `PROLIO_RUN_LSNB_BAR=true` to enable.
 */

const TENANT = "lsbnb";
const AUTHORITY = "LSNB";
const PROVINCE = "NB";
const CATEGORY: CategoryKey = "extranjeria";
const DEFAULT_CITY = "halifax";
const DEFAULT_LIMIT = 5000;
const CITY_MAP: Record<string, string> = {};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return CITY_MAP[k] ?? DEFAULT_CITY;
}

export const lsnbBarSource: ScraperSource = {
  name: "lsnb-bar" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_LSNB_BAR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runLsnbBar(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!lsnbBarSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const limit = Number(process.env.PROLIO_LSNB_BAR_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for await (const rec of fetchAlinityDirectory(TENANT, { limit: cap })) {
    const num = rec.registrationNumber ?? `${rec.name}-${rec.city ?? ""}`;
    const key = `lsnb-bar:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "lsnb-bar" as ScrapeSource,
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
          city_raw: rec.city,
          registration_date: rec.registrationDate,
        },
      }),
    );
  }
  if (records.length === 0) {
    console.warn(`[lsnb-bar] no rows — Alinity endpoint may have changed`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[lsnb-bar] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
