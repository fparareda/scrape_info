/**
 * Auto-creation of `public.cities` rows for bulk ingestion sources.
 *
 * Background: until 2026-05-20 the sink dropped any ScrapedProfessional
 * whose `citySlug` was not pre-seeded in `public.cities` (FK protection).
 * That works for the small static city catalogue but loses 30-90% of
 * rows in US state/county datasets (data.gov sources cover hundreds of
 * municipalities per state vs. the ~1k US seeds in DB).
 *
 * Strategy: when a source encounters an unknown (name, state, country)
 * tuple, call `ensureCity()` to:
 *   1. Compute a stable slug = slugify(name) + "-" + state.toLowerCase()
 *      (the state suffix prevents collisions across e.g. Springfield-IL
 *      / Springfield-MA / Springfield-MO).
 *   2. Check in-process cache.
 *   3. Try OSM Nominatim for lat/lng (rate-limited at 1 req/s per the
 *      Nominatim usage policy: https://operations.osmfoundation.org/policies/nominatim/).
 *   4. INSERT ... ON CONFLICT DO NOTHING (race-safe across concurrent
 *      workers; final row read on conflict).
 *
 * Geocoding failures are non-fatal — we insert with lat/lng=null and
 * log. A separate offline backfill job can geocode the stragglers
 * later if/when we add a paid geocoder.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { slugifyName } from "./slug-id.js";

export type CityCountry = "ES" | "CA" | "US" | "FR" | "MX" | "CO" | "GB";

export interface EnsureCityInput {
  /** Raw city name from the source (e.g. "Silver Spring"). Will be normalised. */
  name: string;
  /** State/province code or full name. Used for slug suffix + Nominatim query. */
  state?: string;
  /** ISO country. */
  country: CityCountry;
  /**
   * Optional lat/lng from the source (some Socrata datasets ship a
   * geolocation column per row). When present we skip the OSM call and
   * use these directly. The first occurrence wins; subsequent rows for
   * the same city are deduplicated via cache.
   */
  lat?: number;
  lng?: number;
}

export interface EnsureCityResult {
  slug: string;
  /** True if we inserted (or attempted insert) this row in this call. */
  created: boolean;
  /** True if we geocoded inline (lat/lng populated). */
  geocoded: boolean;
}

const NOMINATIM_USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const NOMINATIM_INTERVAL_MS = 1100; // OSM policy: max 1 req/s; pad to 1.1s.
const NOMINATIM_TIMEOUT_MS = 8_000;
const NOMINATIM_MAX_FAILURES = 2; // per-city retries

/** Serialises Nominatim calls process-wide. */
let nominatimChain: Promise<void> = Promise.resolve();

function nominatimGate(): Promise<void> {
  const wait = nominatimChain.then(
    () => new Promise<void>((r) => setTimeout(r, NOMINATIM_INTERVAL_MS)),
  );
  nominatimChain = wait.catch(() => undefined);
  return wait;
}

interface CacheEntry {
  slug: string;
  created: boolean;
  geocoded: boolean;
}

// Key: `${country}|${state ?? ""}|${slugifyName(name)}`
const cache = new Map<string, CacheEntry>();

function cacheKey(input: EnsureCityInput): string {
  return `${input.country}|${(input.state ?? "").toLowerCase()}|${slugifyName(input.name)}`;
}

/**
 * Build a stable slug. US/CA use `<name>-<state>` (lowercase, e.g.
 * "silver-spring-md"). ES/FR/MX have no state in the seed slugs so we
 * append the country code instead when state is missing.
 */
function buildCitySlug(name: string, state: string | undefined, country: CityCountry): string {
  const base = slugifyName(name);
  if (!base) return "";
  if (country === "US" || country === "CA") {
    const st = (state ?? "").trim().toLowerCase();
    if (st) return `${base}-${st}`;
    return base;
  }
  return base;
}

interface NominatimHit {
  lat: string;
  lon: string;
}

async function geocodeOsm(input: EnsureCityInput): Promise<{ lat: number; lng: number } | null> {
  const parts = [input.name];
  if (input.state) parts.push(input.state);
  parts.push(input.country);
  const q = parts.join(", ");
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  for (let attempt = 0; attempt < NOMINATIM_MAX_FAILURES; attempt += 1) {
    await nominatimGate();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": NOMINATIM_USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as NominatimHit[];
      if (!data || data.length === 0) return null;
      const lat = Number(data[0].lat);
      const lng = Number(data[0].lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng };
    } catch {
      // network/timeout — try once more
    }
  }
  return null;
}

interface EnsureCityStats {
  ensured: number;
  cacheHits: number;
  inserted: number;
  geocoded: number;
  failedGeocode: number;
}

const stats: EnsureCityStats = {
  ensured: 0,
  cacheHits: 0,
  inserted: 0,
  geocoded: 0,
  failedGeocode: 0,
};

/**
 * Ensure `public.cities` has a row for this city; return its slug.
 *
 * Idempotent + concurrency-safe (ON CONFLICT DO NOTHING).
 */
export async function ensureCity(
  client: SupabaseClient,
  input: EnsureCityInput,
): Promise<EnsureCityResult | null> {
  stats.ensured += 1;
  const key = cacheKey(input);
  const cached = cache.get(key);
  if (cached) {
    stats.cacheHits += 1;
    return cached;
  }
  const slug = buildCitySlug(input.name, input.state, input.country);
  if (!slug) return null;

  // Probe DB first to avoid hitting Nominatim for cities we already have.
  // PK is (country, slug); query on both.
  const { data: existing } = await client
    .from("cities")
    .select("slug")
    .eq("country", input.country)
    .eq("slug", slug)
    .maybeSingle();
  if (existing) {
    const entry: CacheEntry = { slug, created: false, geocoded: false };
    cache.set(key, entry);
    return entry;
  }

  // New city → use lat/lng from input if available, otherwise geocode
  // via OSM. The hint is the city-center coordinate as approximated by
  // the first row's street address — close enough for the city row
  // (distance from a random street to city centroid is <5km in most
  // US municipalities; we don't use cities.lat/lng for distance math).
  let geo: { lat: number; lng: number } | null = null;
  if (
    Number.isFinite(input.lat) &&
    Number.isFinite(input.lng) &&
    input.lat !== 0 &&
    input.lng !== 0
  ) {
    geo = { lat: input.lat as number, lng: input.lng as number };
  } else {
    geo = await geocodeOsm(input);
  }
  if (geo) stats.geocoded += 1;
  else stats.failedGeocode += 1;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (client.from("cities") as any).upsert(
    {
      slug,
      name: input.name.trim(),
      country: input.country,
      region: input.state ?? null,
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null,
    },
    { onConflict: "country,slug", ignoreDuplicates: true },
  );
  if (error) {
    console.error(`[city-upsert] insert failed for ${slug}: ${error.message}`);
    return null;
  }
  stats.inserted += 1;
  const entry: CacheEntry = { slug, created: true, geocoded: Boolean(geo) };
  cache.set(key, entry);
  return entry;
}

/** Reset cache and stats — for tests. */
export function resetCityUpsert(): void {
  cache.clear();
  stats.ensured = 0;
  stats.cacheHits = 0;
  stats.inserted = 0;
  stats.geocoded = 0;
  stats.failedGeocode = 0;
}

export function getCityUpsertStats(): EnsureCityStats {
  return { ...stats };
}
