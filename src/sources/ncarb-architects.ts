import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { createClient } from "@supabase/supabase-js";

/**
 * NCARB — National Council of Architectural Registration Boards.
 *
 * Public directory at:
 *   https://www.ncarb.org/ncarb-certificate/benefits/lookup
 *
 * The lookup page renders an HTML form (id="certificationSearchForm") that
 * calls a JSON REST API discovered via the bundled Drupal JS:
 *   GET https://www.ncarb.org/api/certifications/search
 *   Params: firstName, lastName, city, stateCode, countryCode, offset,
 *           limit (max 200), orderBy (name|location)
 *   Response: { pageInfo: { offset, limit, totalItems, hasPreviousPage,
 *                            hasNextPage }, results: [...] }
 *   Record shape: { id: string, firstName: string, lastName: string,
 *                   city: string, stateCode: string, countryCode: string }
 *
 * Pre-flight 2026-05-26 (datacenter IP):
 *   - robots.txt: www.ncarb.org/robots.txt does NOT disallow /api/ —
 *     only /core/, /profiles/, /admin/, /search/, /user/*, /antibot,
 *     and a handful of publication-redirect paths are blocked.
 *   - GET /api/certifications/search?offset=0&limit=100 → 200 JSON,
 *     totalItems = 51,918.
 *   - Max limit = 200; limit ≥ 250 returns {"error":"Unable to fetch
 *     certification data."}.
 *   - No authentication, no cookies, no Cloudflare challenge.
 *   - No CSRF token required.
 *
 * Strategy: iterate with offset=0, 200, 400, … until hasNextPage=false.
 * At 200 records/page that is ~260 pages (~52k records). Polite delay
 * (PAGE_DELAY_MS) between pages avoids hammering the host.
 *
 * City mapping: loaded from Supabase `cities` table (country=US). Records
 * whose city+stateCode can't be matched fall back to the primary city of
 * their jurisdiction (e.g. "sacramento" for CA). Records with no stateCode
 * or a non-US countryCode are assigned "washington-dc" (federal default).
 *
 * Category: `arquitecto`. Authority: NCARB. Country: US.
 * Off by default — PROLIO_RUN_NCARB_ARCHITECTS=true to enable.
 * Cap via PROLIO_NCARB_ARCHITECTS_LIMIT (default 60_000).
 */

const API_URL = "https://www.ncarb.org/api/certifications/search";
const CATEGORY: CategoryKey = "arquitecto";
const DEFAULT_LIMIT = 60_000;
const PAGE_SIZE = 200;
const PAGE_DELAY_MS = 1_200; // polite: ≤ 0.84 req/s
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// Fallback city slug per US state code when the record's city can't be
// matched to a Supabase slug. Uses the largest/capital city for each state.
const STATE_FALLBACK: Record<string, string> = {
  AL: "montgomery", AK: "anchorage", AZ: "phoenix", AR: "little-rock",
  CA: "los-angeles", CO: "denver", CT: "hartford", DE: "wilmington",
  DC: "washington-dc", FL: "miami", GA: "atlanta", GU: "hagatna",
  HI: "honolulu", ID: "boise", IL: "chicago", IN: "indianapolis",
  IA: "des-moines", KS: "wichita", KY: "louisville", LA: "new-orleans",
  ME: "portland", MD: "baltimore", MA: "boston", MI: "detroit",
  MN: "minneapolis", MS: "jackson", MO: "kansas-city", MT: "billings",
  NE: "omaha", NV: "las-vegas", NH: "manchester", NJ: "newark",
  NM: "albuquerque", NY: "new-york", NC: "charlotte", ND: "fargo",
  OH: "columbus", OK: "oklahoma-city", OR: "portland", PA: "philadelphia",
  PR: "san-juan", RI: "providence", SC: "columbia", SD: "sioux-falls",
  TN: "nashville", TX: "houston", UT: "salt-lake-city", VT: "burlington",
  VA: "virginia-beach", VI: "charlotte-amalie", WA: "seattle",
  WV: "charleston", WI: "milwaukee", WY: "cheyenne",
  // Territories
  AS: "pago-pago", MP: "saipan",
};
const FEDERAL_FALLBACK = "washington-dc";

export const ncarbArchitectsSource: ScraperSource = {
  name: "ncarb-architects" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_NCARB_ARCHITECTS === "true";
  },
  async fetch() {
    return [];
  },
};

interface NcarbRecord {
  id: string;
  firstName: string;
  lastName: string;
  city?: string;
  stateCode?: string;
  countryCode?: string;
}

interface NcarbResponse {
  pageInfo: {
    offset: number;
    limit: number;
    totalItems: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
  results: NcarbRecord[];
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(offset: number): Promise<NcarbResponse | null> {
  const params = new URLSearchParams({
    firstName: "",
    lastName: "",
    city: "",
    stateCode: "",
    countryCode: "",
    offset: String(offset),
    limit: String(PAGE_SIZE),
    orderBy: "name",
  });
  const url = `${API_URL}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn(`[ncarb-architects] HTTP ${res.status} at offset=${offset}`);
      return null;
    }
    const json = (await res.json()) as NcarbResponse | { error: string };
    if ("error" in json) {
      console.warn(
        `[ncarb-architects] API error at offset=${offset}: ${(json as { error: string }).error}`,
      );
      return null;
    }
    return json as NcarbResponse;
  } catch (e) {
    console.warn(
      `[ncarb-architects] fetch error at offset=${offset}: ${(e as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadUsCitySlugs(): Promise<Set<string>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Set();
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const slugs = new Set<string>();
  for (let from = 0; from < 12_000; from += 1_000) {
    const { data, error } = await sb
      .from("cities")
      .select("slug")
      .eq("country", "US")
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;
    for (const row of data) slugs.add(row.slug as string);
    if (data.length < 1_000) break;
  }
  return slugs;
}

function resolveCitySlug(
  rec: NcarbRecord,
  validSlugs: Set<string>,
): string {
  // Try to match the record's city to a known US city slug.
  if (rec.city) {
    const candidate = slugify(rec.city.trim());
    if (validSlugs.has(candidate)) return candidate;
  }
  // Fall back to state-level primary city.
  if (rec.stateCode && STATE_FALLBACK[rec.stateCode.toUpperCase()]) {
    return STATE_FALLBACK[rec.stateCode.toUpperCase()];
  }
  return FEDERAL_FALLBACK;
}

function toRecord(
  rec: NcarbRecord,
  validSlugs: Set<string>,
): ScrapedProfessional | null {
  const firstName = rec.firstName?.trim() ?? "";
  const lastName = rec.lastName?.trim() ?? "";
  if (!firstName && !lastName) return null;
  const name = [firstName, lastName].filter(Boolean).join(" ");
  const citySlug = resolveCitySlug(rec, validSlugs);
  return normalise({
    source: "ncarb-architects" as ScrapeSource,
    country: "US",
    sourceId: `ncarb:${rec.id}`,
    name,
    categoryKey: CATEGORY,
    citySlug,
    metadata: {
      country: "US",
      authority: "NCARB",
      verified_by_authority: true,
      ncarb_id: rec.id,
      state_code: rec.stateCode ?? null,
      city: rec.city ?? null,
      country_code: rec.countryCode ?? null,
      profile_url: `https://www.ncarb.org/ncarb-certificate/benefits/lookup`,
    },
  });
}

export async function runNcarbArchitects(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!ncarbArchitectsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_NCARB_ARCHITECTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const validSlugs = await loadUsCitySlugs();
  if (validSlugs.size === 0) {
    console.warn(`[ncarb-architects] no US city slugs loaded — aborting`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const allRows: NcarbRecord[] = [];
  let totalItems: number | null = null;
  let offset = 0;

  while (true) {
    if (allRows.length >= cap) break;
    const page = await fetchPage(offset);
    if (!page) break;

    if (totalItems === null) {
      totalItems = page.pageInfo.totalItems;
      console.log(
        `[ncarb-architects] totalItems=${totalItems} (~${Math.ceil(totalItems / PAGE_SIZE)} pages)`,
      );
    }

    for (const rec of page.results) {
      allRows.push(rec);
      if (allRows.length >= cap) break;
    }

    if (!page.pageInfo.hasNextPage) break;
    offset += PAGE_SIZE;
    await delay(PAGE_DELAY_MS);
  }

  console.log(`[ncarb-architects] fetched ${allRows.length} raw records`);

  const records: ScrapedProfessional[] = [];
  const seenIds = new Set<string>();
  for (const row of allRows) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    const rec = toRecord(row, validSlugs);
    if (rec) records.push(rec);
  }

  if (records.length === 0) {
    console.warn(`[ncarb-architects] 0 records normalised — endpoint may be down`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[ncarb-architects] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
