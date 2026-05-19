import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * Foursquare Places API — generic US trades searcher.
 *
 * Endpoint:  https://api.foursquare.com/v3/places/search
 * Auth:      `Authorization: <FOURSQUARE_API_KEY>` (free tier 1k/day)
 *
 * --- 2026-05-18 probe -------------------------------------------------
 *   curl -I https://api.foursquare.com/v3/places/search
 *     → 401 Unauthorized (expected; needs API key)
 *
 * The free tier is 1,000 calls/day. We fan out across US cities × a
 * configurable shortlist of trade categories and cap per-run requests
 * via `PROLIO_FOURSQUARE_REQUESTS_PER_RUN` (default 800 to leave
 * headroom for retries within the daily quota).
 *
 * --- Category mapping --------------------------------------------------
 * Foursquare uses numeric category IDs (v3 taxonomy). We map Prolio
 * categories to a hand-picked subset of FSQ category IDs:
 *
 *   fontaneria   → 11139 (Plumber)
 *   carpinteria  → 11091 (Carpenter) + 11079 (Cabinet Maker)
 *   hvac         → 11136 (HVAC / Heating + Cooling Service)
 *   electricidad → 11090 (Electrician)
 *   cerrajero    → 11137 (Locksmith)
 *
 * (Source: https://docs.foursquare.com/data-products/docs/categories,
 *  IDs verified 2026-05-18 against the public taxonomy CSV.)
 *
 * Off by default. Requires:
 *   - FOURSQUARE_API_KEY  (Foursquare developer key)
 *   - PROLIO_RUN_FOURSQUARE_TRADES=true
 *   - PROLIO_FOURSQUARE_CATEGORY=fontaneria  (or any key in the map)
 *
 * Optional caps:
 *   PROLIO_FOURSQUARE_REQUESTS_PER_RUN   default 800
 *   PROLIO_FOURSQUARE_LIMIT_PER_RUN      default 25000 rows
 *   PROLIO_FOURSQUARE_RESULTS_PER_CALL   default 50 (FSQ max)
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const API = "https://api.foursquare.com/v3/places/search";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_REQUESTS = 800;
const DEFAULT_LIMIT = 25_000;
const DEFAULT_PAGE_SIZE = 50;

const CATEGORY_MAP: Record<string, { key: CategoryKey; fsqIds: string[] }> = {
  fontaneria:    { key: "fontaneria",    fsqIds: ["11139"] },
  carpinteria:   { key: "carpinteria",   fsqIds: ["11091", "11079"] },
  hvac:          { key: "hvac",          fsqIds: ["11136"] },
  electricidad:  { key: "electricidad",  fsqIds: ["11090"] },
  cerrajero:     { key: "cerrajero",     fsqIds: ["11137"] },
};

interface FsqLocation {
  address?: string;
  locality?: string;
  region?: string;
  postcode?: string;
  country?: string;
  formatted_address?: string;
}
interface FsqGeocodes {
  main?: { latitude?: number; longitude?: number };
}
interface FsqPlace {
  fsq_id: string;
  name?: string;
  location?: FsqLocation;
  geocodes?: FsqGeocodes;
  tel?: string;
  website?: string;
  email?: string;
}
interface FsqResponse {
  results?: FsqPlace[];
}

function normaliseUsPhone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

async function searchCity(
  apiKey: string,
  cityName: string,
  fsqIds: string[],
  limit: number,
): Promise<FsqPlace[]> {
  const u = new URL(API);
  u.searchParams.set("near", `${cityName}, US`);
  u.searchParams.set("categories", fsqIds.join(","));
  u.searchParams.set("limit", String(Math.min(limit, 50)));
  try {
    const res = await fetch(u.toString(), {
      headers: {
        Authorization: apiKey,
        Accept: "application/json",
        "User-Agent": POLITE_UA,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[foursquare-trades] ${cityName} → HTTP ${res.status}`);
      return [];
    }
    const data = (await res.json()) as FsqResponse;
    return data.results ?? [];
  } catch (e) {
    console.warn(
      `[foursquare-trades] ${cityName} fetch failed: ${(e as Error).message}`,
    );
    return [];
  }
}

function placeToScraped(
  place: FsqPlace,
  category: CategoryKey,
  citySlug: string,
): ScrapedProfessional | null {
  const name = place.name?.trim();
  if (!name) return null;
  const loc = place.location ?? {};
  const geo = place.geocodes?.main ?? {};
  const addrParts = [loc.address, loc.locality, loc.region, loc.postcode]
    .filter((p) => p && p.length > 0);
  return normalise({
    source: "foursquare-trades",
    country: "US",
    sourceId: `foursquare-trades:${place.fsq_id}`,
    name,
    categoryKey: category,
    citySlug,
    phone: normaliseUsPhone(place.tel),
    website: place.website,
    email: place.email,
    address: addrParts.length > 0 ? addrParts.join(", ") : loc.formatted_address,
    lat: typeof geo.latitude === "number" ? geo.latitude : undefined,
    lng: typeof geo.longitude === "number" ? geo.longitude : undefined,
    metadata: {
      country: "US",
      state: loc.region ?? undefined,
      authority: "Foursquare Places API v3",
      fsq_id: place.fsq_id,
    },
  });
}

export const foursquareTradesSource: ScraperSource = {
  name: "foursquare-trades",
  enabled() {
    return (
      process.env.PROLIO_RUN_FOURSQUARE_TRADES === "true" &&
      !!process.env.FOURSQUARE_API_KEY
    );
  },
  async fetch() {
    return [];
  },
};

export async function runFoursquareTrades(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (process.env.PROLIO_RUN_FOURSQUARE_TRADES !== "true") {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const apiKey = process.env.FOURSQUARE_API_KEY;
  if (!apiKey) {
    console.warn(
      "[foursquare-trades] FOURSQUARE_API_KEY not set — register one at " +
        "https://foursquare.com/developers/ then set the env var. STUB.",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const catKey = process.env.PROLIO_FOURSQUARE_CATEGORY ?? "fontaneria";
  const mapping = CATEGORY_MAP[catKey];
  if (!mapping) {
    console.warn(
      `[foursquare-trades] unknown PROLIO_FOURSQUARE_CATEGORY=${catKey} ` +
        `(known: ${Object.keys(CATEGORY_MAP).join(", ")}). Abort.`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const requestCap = Math.max(
    1,
    Number(process.env.PROLIO_FOURSQUARE_REQUESTS_PER_RUN ?? DEFAULT_REQUESTS),
  );
  const rowCap = Math.max(
    1,
    Number(process.env.PROLIO_FOURSQUARE_LIMIT_PER_RUN ?? DEFAULT_LIMIT),
  );
  const pageSize = Math.max(
    1,
    Math.min(50, Number(
      process.env.PROLIO_FOURSQUARE_RESULTS_PER_CALL ?? DEFAULT_PAGE_SIZE,
    )),
  );

  const usCities = await getCities({ country: "US" }).catch((e) => {
    console.warn(`[foursquare-trades] city load failed: ${(e as Error).message}`);
    return [] as Awaited<ReturnType<typeof getCities>>;
  });
  if (usCities.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  let requests = 0;
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const seen = new Set<string>();
  let batch: ScrapedProfessional[] = [];
  const sink = getSink();
  const FLUSH = 200;

  for (const city of usCities) {
    if (requests >= requestCap) break;
    if (fetched >= rowCap) break;
    const places = await searchCity(apiKey, city.name, mapping.fsqIds, pageSize);
    requests += 1;
    for (const p of places) {
      fetched += 1;
      const rec = placeToScraped(p, mapping.key, city.slug);
      if (!rec) continue;
      if (seen.has(rec.sourceId)) continue;
      seen.add(rec.sourceId);
      batch.push(rec);
      if (batch.length >= FLUSH) {
        const res = await sink.upsert(batch);
        inserted += res.inserted;
        updated += res.updated;
        skipped += res.skipped;
        batch = [];
      }
    }
  }
  if (batch.length > 0) {
    const res = await sink.upsert(batch);
    inserted += res.inserted;
    updated += res.updated;
    skipped += res.skipped;
  }

  console.log(
    `[foursquare-trades] cat=${catKey} requests=${requests}/${requestCap} ` +
      `fetched=${fetched} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched, inserted, updated, skipped };
}
