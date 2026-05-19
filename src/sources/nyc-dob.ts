import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * NYC Department of Buildings — License Info scraper.
 *
 * The NYC DOB License Info dataset (`t8hj-ruu2`) is the official registry
 * of construction-trade licences issued by New York City's Department of
 * Buildings. It is published on the NYC Open Data portal as a Socrata SODA
 * v2 JSON endpoint — no auth, no API key, no CAPTCHA. ~103k total rows
 * (all statuses); ~5,400 ACTIVE rows map cleanly to Prolio trade categories.
 *
 * Pre-flight (2026-05-04):
 *   robots.txt  — data.cityofnewyork.us allows /resource/ paths.
 *                 Only browse/filter UI paths and /api/odata/ are Disallowed.
 *                 crawl-delay: 1 (respected via REQUEST_DELAY_MS).
 *   API type    — Socrata SODA v2 REST JSON. Simple GET with SoQL query
 *                 params. No cookies, no JS, no Cloudflare. HTTP 200 from
 *                 CI IPs.
 *   Record count — ACTIVE trade-relevant rows probed 2026-05-04:
 *                    ELECTRICAL CONTRACTOR   1,855
 *                    ELECTRICAL FIRM         1,837
 *                    MASTER PLUMBER          1,140
 *                    FIRE SUPPRESSION          467
 *                    OIL BURNER INSTALLER      103
 *                    Total                   5,402
 *   Auth / WAF  — none.
 *
 * Category mapping:
 *   ELECTRICAL CONTRACTOR → electricidad
 *   ELECTRICAL FIRM       → electricidad
 *   MASTER PLUMBER        → fontaneria
 *   FIRE SUPPRESSION CONTRACTOR → hvac  (fire + HVAC share the HVAC bucket)
 *   OIL BURNER INSTALLER  → hvac
 *
 * City mapping: DOB uses NYC borough/neighbourhood names as city strings.
 * We map the five main ones (NEW YORK, BROOKLYN, BRONX, QUEENS, STATEN
 * ISLAND) to our seeded city slugs; all others are dropped (the sink
 * would reject them anyway for missing FK). This still covers ~53% of
 * active records (~2,800 rows).
 *
 * Off by default. Enable via PROLIO_RUN_NYC_DOB=true. Cap via
 * PROLIO_NYC_DOB_LIMIT (default 3000).
 *
 * Monthly cron — DOB issues annual licence renewals; data changes slowly.
 * See .github/workflows/scrape-nyc-dob.yml.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 25_000;
const REQUEST_DELAY_MS = 1_100; // honour crawl-delay: 1 from robots.txt
const PAGE_SIZE = 1000;
const DEFAULT_LIMIT = 3000;

const SODA_BASE = "https://data.cityofnewyork.us/resource/t8hj-ruu2.json";

// --- License type → CategoryKey mapping --------------------------------

interface LicenseTypeEntry {
  /** Exact string from the DOB `license_type` field (uppercase). */
  type: string;
  category: CategoryKey;
  description: string;
}

const LICENSE_TYPES: readonly LicenseTypeEntry[] = [
  { type: "ELECTRICAL CONTRACTOR", category: "electricidad", description: "Electrical Contractor" },
  { type: "ELECTRICAL FIRM",       category: "electricidad", description: "Electrical Firm" },
  { type: "MASTER PLUMBER",        category: "fontaneria",   description: "Master Plumber" },
  { type: "FIRE SUPPRESSION CONTRACTOR", category: "hvac",  description: "Fire Suppression Contractor" },
  { type: "OIL BURNER INSTALLER",  category: "hvac",        description: "Oil Burner Installer" },
];

const LICENSE_TYPE_MAP = new Map<string, LicenseTypeEntry>(
  LICENSE_TYPES.map((e) => [e.type, e]),
);

// --- City name → city slug mapping ------------------------------------

/**
 * DOB stores borough/neighbourhood names in `license_business_city`.
 * We map the five main NYC boroughs (and "Manhattan" alias) to the
 * city slugs we seeded in migrations 0021/0034/0045. Anything not in
 * this table is dropped — the sink would reject it for missing FK.
 *
 * "NEW YORK" is the most common value (Manhattan licensees). Brooklyn
 * and the Bronx need disambiguation suffixes to avoid collision with
 * same-named cities in OH/MD. Queens and Staten Island have -us-ny
 * suffixes from migration 0045.
 */
const DOB_CITY_ALIAS: Record<string, string> = {
  "new york":    "new-york",
  "manhattan":   "new-york",
  "brooklyn":    "brooklyn-us-ny",
  "bronx":       "the-bronx-us-ny",
  "the bronx":   "the-bronx-us-ny",
  "queens":      "queens-us-ny",
  "staten island": "staten-island-us-ny",
};

function mapDobCity(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  return DOB_CITY_ALIAS[key];
}

// --- SODA API types ----------------------------------------------------

interface DobRecord {
  license_sl_no?: string;
  license_type?: string;
  license_number?: string;
  last_name?: string;
  first_name?: string;
  business_name?: string;
  business_house_number?: string;
  business_street_name?: string;
  license_business_city?: string;
  business_state?: string;
  business_zip_code?: string;
  business_email?: string;
  business_phone_number?: string;
  license_status?: string;
  lat?: string;
  long?: string;
}

// --- HTTP helpers -------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normaliseUsPhone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

/**
 * Build a display name from individual and business fields.
 * Prefer business_name when present; fall back to "First Last";
 * if neither, skip the record.
 */
function buildName(r: DobRecord): string | undefined {
  const biz = r.business_name?.trim();
  if (biz) return biz;
  const first = r.first_name?.trim() ?? "";
  const last = r.last_name?.trim() ?? "";
  const full = [first, last].filter(Boolean).join(" ");
  if (!full) return undefined;
  // DOB names are uppercase — title-case for presentation.
  return full
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

async function fetchDobPage(
  licenseType: string,
  offset: number,
): Promise<DobRecord[] | null> {
  const params = new URLSearchParams({
    $where: `license_type="${licenseType}" AND license_status="ACTIVE"`,
    $limit: String(PAGE_SIZE),
    $offset: String(offset),
    $order: "license_sl_no ASC",
  });
  const url = `${SODA_BASE}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(
        `[nyc-dob] ${licenseType} offset=${offset} status=${response.status}`,
      );
      return null;
    }
    return (await response.json()) as DobRecord[];
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[nyc-dob] ${licenseType} offset=${offset} error: ${(err as Error).message}`,
    );
    return null;
  }
}

// --- Main runner -------------------------------------------------------

export const nycDobSource: ScraperSource = {
  name: "nyc-dob",
  enabled() {
    return process.env.PROLIO_RUN_NYC_DOB === "true";
  },
  // This source is bulk-only; per-target fetch is a no-op.
  async fetch() {
    return [];
  },
};

export async function runNycDob(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!nycDobSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(process.env.PROLIO_NYC_DOB_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const sink = getSink();
  const seen = new Set<string>();
  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let droppedNoCity = 0;
  let droppedNoName = 0;
  let droppedNoKey = 0;

  for (const entry of LICENSE_TYPES) {
    if (totalFetched >= limit) break;

    let offset = 0;
    console.log(`[nyc-dob] fetching ${entry.type} (${entry.description})`);

    for (;;) {
      if (totalFetched >= limit) break;

      const page = await fetchDobPage(entry.type, offset);
      if (!page || page.length === 0) break;

      const batch: ScrapedProfessional[] = [];
      for (const r of page) {
        if (totalFetched >= limit) break;

        const key = r.license_sl_no?.trim();
        if (!key) {
          droppedNoKey += 1;
          continue;
        }
        const sourceId = `nyc-dob:${key}`;
        if (seen.has(sourceId)) continue;

        const name = buildName(r);
        if (!name) {
          droppedNoName += 1;
          continue;
        }

        const citySlug = mapDobCity(r.license_business_city);
        if (!citySlug) {
          droppedNoCity += 1;
          continue;
        }

        const licenseEntry = LICENSE_TYPE_MAP.get(entry.type);
        if (!licenseEntry) continue;

        seen.add(sourceId);
        totalFetched += 1;

        const addressParts = [
          r.business_house_number,
          r.business_street_name,
          r.license_business_city,
          r.business_state,
          r.business_zip_code,
        ]
          .map((p) => (typeof p === "string" ? p.trim() : ""))
          .filter((p) => p.length > 0);

        const lat =
          r.lat ? parseFloat(r.lat) : undefined;
        const lng =
          r.long ? parseFloat(r.long) : undefined;

        batch.push(
          normalise({
            source: "nyc-dob",
            country: "US",
            sourceId,
            name,
            categoryKey: licenseEntry.category,
            citySlug,
            email: r.business_email?.trim().toLowerCase() || undefined,
            phone: normaliseUsPhone(r.business_phone_number),
            address:
              addressParts.length > 0 ? addressParts.join(", ") : undefined,
            licenseNumber: r.license_number?.trim() || undefined,
            lat: lat && Number.isFinite(lat) ? lat : undefined,
            lng: lng && Number.isFinite(lng) ? lng : undefined,
            metadata: {
              country: "US",
              state: "NY",
              city: r.license_business_city?.trim() ?? undefined,
              dob_license_sl_no: key,
              dob_license_type: entry.type,
              dob_license_status: "ACTIVE",
              verified_by_authority: true,
              authority: "NYC Department of Buildings",
            },
          }),
        );
      }

      if (batch.length > 0) {
        const { inserted, updated, skipped } = await sink.upsert(batch);
        totalInserted += inserted;
        totalUpdated += updated;
        totalSkipped += skipped;
        console.log(
          `[nyc-dob] ${entry.type} offset=${offset} ` +
            `fetched=${batch.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
        );
      }

      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;

      // Respect crawl-delay: 1 from robots.txt.
      await delay(REQUEST_DELAY_MS);
    }
  }

  console.log(
    `[nyc-dob] done — fetched=${totalFetched} inserted=${totalInserted} ` +
      `updated=${totalUpdated} skipped=${totalSkipped} ` +
      `droppedNoCity=${droppedNoCity} droppedNoName=${droppedNoName} droppedNoKey=${droppedNoKey}`,
  );
  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    skipped: totalSkipped,
  };
}
