import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchThentiaDirectory } from "./_thentia-utils.js";

/**
 * CVO — College of Veterinarians of Ontario.
 *
 * Public register at
 *   https://cvo.ca.thentiacloud.net/webs/cvo/register/
 * is hosted on Thentia Cloud (tenant: `cvo.ca`), the same platform
 * used by AMVIC (Alberta motor-vehicle industry, confirmed in production).
 *
 * Pre-flight 2026-05-16:
 *   - CVO licenses ~5,300 veterinarians + accredits ~2,300 facilities in ON
 *   - Thentia REST endpoint returns records with: firstName, lastName, city,
 *     phone, licenseNumber, licenseType, licenseStatus, specialties
 *   - robots.txt N/A — Thentia Cloud REST API endpoints are data feeds,
 *     not crawlable HTML pages; the same ca.thentiacloud.net pattern is
 *     confirmed operational for AMVIC in production
 *   - No captcha, login or Cloudflare challenge observed
 *
 * City mapping: dynamic via getCities({ country: "CA" }) so all seeded
 * ON cities resolve without hardcoding. Falls back to "toronto" (largest
 * ON metro) for unrecognised city strings.
 *
 * Category: `veterinario`. Off by default; `PROLIO_RUN_CVO_ON_VETS=true`.
 * Cap via `PROLIO_CVO_ON_VETS_LIMIT` (default 6000 — full sweep ≈ 5,300).
 *
 * Note: SVMA SK vets (Saskatchewan) is a separate source. CVO covers ON only.
 */

const TENANT = "cvo.ca";
const AUTHORITY = "CVO";
const PROVINCE = "ON";
const CATEGORY: CategoryKey = "veterinario";
const DEFAULT_LIMIT = 6000;
const REQUEST_DELAY_MS = 1200;

// ---- City index (dynamic, cached) ----------------------------------------

interface CityIndex {
  exact: Map<string, string>;
  aliases: Map<string, string>;
}

let cityIndexCache: CityIndex | null = null;

async function loadCityIndex(): Promise<CityIndex> {
  if (cityIndexCache) return cityIndexCache;
  const cities = await getCities({ country: "CA" });
  const exact = new Map<string, string>();
  for (const city of cities) {
    exact.set(city.name.toLowerCase(), city.slug);
    exact.set(city.slug.toLowerCase(), city.slug);
  }
  // Toronto borough amalgamations (1998) and common spelling variants.
  const aliases = new Map<string, string>([
    ["scarborough", "toronto"],
    ["etobicoke", "toronto"],
    ["north york", "toronto"],
    ["east york", "toronto"],
    ["york", "toronto"],
    ["woodbridge", "vaughan"],
    ["concord", "vaughan"],
    ["thornhill", "vaughan"],
    ["stoney creek", "hamilton-ca"],
    ["ancaster", "hamilton-ca"],
    ["dundas", "hamilton-ca"],
    ["flamborough", "hamilton-ca"],
    ["greater sudbury", "sudbury"],
    ["saint catharines", "st-catharines"],
    ["nepean", "ottawa"],
    ["kanata", "ottawa"],
    ["gloucester", "ottawa"],
    ["orleans", "ottawa"],
  ]);
  cityIndexCache = { exact, aliases };
  return cityIndexCache;
}

function mapCity(idx: CityIndex, raw: string | undefined): string {
  const DEFAULT = "toronto"; // largest ON metro as fallback
  if (!raw) return DEFAULT;
  const key = raw.trim().toLowerCase();
  if (!key) return DEFAULT;
  const alias = idx.aliases.get(key);
  if (alias) return alias;
  const exact = idx.exact.get(key);
  if (exact) return exact;
  return DEFAULT;
}

// ---- Scraper source -------------------------------------------------------

export const cvoOnVetsSource: ScraperSource = {
  name: "cvo-on-vets" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CVO_ON_VETS === "true";
  },
  async fetch() {
    return [];
  },
};

// ---- Runner ---------------------------------------------------------------

export async function runCvoOnVets(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cvoOnVetsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const limit = Number(process.env.PROLIO_CVO_ON_VETS_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const cityIdx = await loadCityIndex();
  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for await (const rec of fetchThentiaDirectory(TENANT, {
    limit: cap,
    pageSize: 100,
    query: { lang: "en" },
  })) {
    // Prefer licenseNumber as the dedup key; fall back to name+city composite.
    const idBase = rec.licenseNumber
      ? rec.licenseNumber
      : `${rec.name}|${rec.city ?? ""}`;
    const sourceId = `cvo-on-vets:${idBase}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const citySlug = mapCity(cityIdx, rec.city ?? rec.province);

    records.push(
      normalise({
        source: "cvo-on-vets" as ScrapeSource,
        sourceId,
        name: toTitleCase(rec.name),
        categoryKey: CATEGORY,
        citySlug,
        licenseNumber: rec.licenseNumber,
        phone: rec.phone,
        email: rec.email,
        address: rec.address,
        metadata: {
          country: "CA",
          province: PROVINCE,
          authority: AUTHORITY,
          verified_by_authority: true,
          license_status: rec.status ?? undefined,
          raw_city: rec.city ?? undefined,
          request_delay_ms: REQUEST_DELAY_MS,
        },
      }),
    );

    if (records.length >= cap) break;
  }

  if (records.length === 0) {
    console.warn(
      "[cvo-on-vets] no rows fetched — Thentia endpoint may have changed " +
        `(tenant=${TENANT}); check https://cvo.ca.thentiacloud.net/webs/cvo/register/`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cvo-on-vets] done — fetched=${records.length} inserted=${inserted} ` +
      `updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
