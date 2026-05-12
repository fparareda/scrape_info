export type CountryCode = "ES" | "CA" | "US";

export interface ScraperCity {
  slug: string;
  name: string;
  country: CountryCode;
  /**
   * Locale to use when forming Google Places textQuery / OSM queries.
   * Spain uses "es"; Canada is bilingual so we pick the majority
   * language of the city (QC cities = "fr", rest = "en").
   */
  queryLocale: "es" | "en" | "fr";
  lat: number;
  lng: number;
}

/** Back-compat alias. Will be removed once every caller uses ScraperCity. */
export type SpanishCity = ScraperCity;

type Base = Omit<ScraperCity, "country" | "queryLocale">;

function es(c: Base): ScraperCity {
  return { ...c, country: "ES", queryLocale: "es" };
}
function caEn(c: Base): ScraperCity {
  return { ...c, country: "CA", queryLocale: "en" };
}
function caFr(c: Base): ScraperCity {
  return { ...c, country: "CA", queryLocale: "fr" };
}
function us(c: Base): ScraperCity {
  return { ...c, country: "US", queryLocale: "en" };
}

/**
 * Top-50 cities in Spain by population (INE 2024 roundings). Slugs are
 * ASCII-safe and mirror what we insert into public.cities.
 */
export const SPANISH_CITIES: ScraperCity[] = [
  es({ slug: "madrid",              name: "Madrid",                    lat: 40.4168, lng: -3.7038 }),
  es({ slug: "barcelona",           name: "Barcelona",                 lat: 41.3874, lng:  2.1686 }),
  es({ slug: "valencia",            name: "Valencia",                  lat: 39.4699, lng: -0.3763 }),
  es({ slug: "sevilla",             name: "Sevilla",                   lat: 37.3891, lng: -5.9845 }),
  es({ slug: "zaragoza",            name: "Zaragoza",                  lat: 41.6488, lng: -0.8891 }),
  es({ slug: "malaga",              name: "Málaga",                    lat: 36.7213, lng: -4.4214 }),
  es({ slug: "murcia",              name: "Murcia",                    lat: 37.9922, lng: -1.1307 }),
  es({ slug: "palma",               name: "Palma de Mallorca",         lat: 39.5696, lng:  2.6502 }),
  es({ slug: "las-palmas",          name: "Las Palmas",                lat: 28.1235, lng: -15.4363 }),
  es({ slug: "bilbao",              name: "Bilbao",                    lat: 43.2630, lng: -2.9350 }),
  es({ slug: "alicante",            name: "Alicante",                  lat: 38.3452, lng: -0.4815 }),
  es({ slug: "cordoba",             name: "Córdoba",                   lat: 37.8882, lng: -4.7794 }),
  es({ slug: "valladolid",          name: "Valladolid",                lat: 41.6523, lng: -4.7245 }),
  es({ slug: "vigo",                name: "Vigo",                      lat: 42.2406, lng: -8.7207 }),
  es({ slug: "gijon",               name: "Gijón",                     lat: 43.5322, lng: -5.6611 }),
  es({ slug: "hospitalet",          name: "L'Hospitalet de Llobregat", lat: 41.3596, lng:  2.0997 }),
  es({ slug: "a-coruna",            name: "A Coruña",                  lat: 43.3623, lng: -8.4115 }),
  es({ slug: "vitoria",             name: "Vitoria-Gasteiz",           lat: 42.8467, lng: -2.6716 }),
  es({ slug: "granada",             name: "Granada",                   lat: 37.1773, lng: -3.5986 }),
  es({ slug: "elche",               name: "Elche",                     lat: 38.2622, lng: -0.7011 }),
  es({ slug: "oviedo",              name: "Oviedo",                    lat: 43.3619, lng: -5.8494 }),
  es({ slug: "badalona",            name: "Badalona",                  lat: 41.4502, lng:  2.2474 }),
  es({ slug: "terrassa",            name: "Terrassa",                  lat: 41.5640, lng:  2.0109 }),
  es({ slug: "cartagena",           name: "Cartagena",                 lat: 37.6257, lng: -0.9966 }),
  es({ slug: "jerez",               name: "Jerez de la Frontera",      lat: 36.6867, lng: -6.1362 }),
  es({ slug: "sabadell",            name: "Sabadell",                  lat: 41.5485, lng:  2.1075 }),
  es({ slug: "mostoles",            name: "Móstoles",                  lat: 40.3234, lng: -3.8649 }),
  es({ slug: "santa-cruz-tenerife", name: "Santa Cruz de Tenerife",    lat: 28.4636, lng: -16.2518 }),
  es({ slug: "alcala-henares",      name: "Alcalá de Henares",         lat: 40.4818, lng: -3.3643 }),
  es({ slug: "pamplona",            name: "Pamplona",                  lat: 42.8125, lng: -1.6458 }),
  es({ slug: "fuenlabrada",         name: "Fuenlabrada",               lat: 40.2842, lng: -3.7942 }),
  es({ slug: "almeria",             name: "Almería",                   lat: 36.8381, lng: -2.4597 }),
  es({ slug: "leganes",             name: "Leganés",                   lat: 40.3275, lng: -3.7634 }),
  es({ slug: "san-sebastian",       name: "San Sebastián",             lat: 43.3183, lng: -1.9812 }),
  es({ slug: "burgos",              name: "Burgos",                    lat: 42.3440, lng: -3.6969 }),
  es({ slug: "getafe",              name: "Getafe",                    lat: 40.3082, lng: -3.7322 }),
  es({ slug: "santander",           name: "Santander",                 lat: 43.4623, lng: -3.8099 }),
  es({ slug: "castellon",           name: "Castellón de la Plana",     lat: 39.9864, lng: -0.0513 }),
  es({ slug: "alcorcon",            name: "Alcorcón",                  lat: 40.3450, lng: -3.8294 }),
  es({ slug: "albacete",            name: "Albacete",                  lat: 38.9942, lng: -1.8585 }),
  es({ slug: "logrono",             name: "Logroño",                   lat: 42.4627, lng: -2.4450 }),
  es({ slug: "badajoz",             name: "Badajoz",                   lat: 38.8794, lng: -6.9707 }),
  es({ slug: "salamanca",           name: "Salamanca",                 lat: 40.9701, lng: -5.6635 }),
  es({ slug: "huelva",              name: "Huelva",                    lat: 37.2614, lng: -6.9447 }),
  es({ slug: "marbella",            name: "Marbella",                  lat: 36.5108, lng: -4.8824 }),
  es({ slug: "lleida",              name: "Lleida",                    lat: 41.6176, lng:  0.6200 }),
  es({ slug: "tarragona",           name: "Tarragona",                 lat: 41.1189, lng:  1.2445 }),
  es({ slug: "leon",                name: "León",                      lat: 42.5987, lng: -5.5671 }),
  es({ slug: "cadiz",               name: "Cádiz",                     lat: 36.5297, lng: -6.2926 }),
  es({ slug: "dos-hermanas",        name: "Dos Hermanas",              lat: 37.2833, lng: -5.9239 }),
];

/**
 * Top-20 Canadian cities by population. Slugs match public.cities
 * (seeded via migration 0018). Québec + Gatineau + Montréal use
 * queryLocale="fr" so Google Places returns French-first; the rest
 * use "en".
 */
export const CANADIAN_CITIES: ScraperCity[] = [
  caEn({ slug: "toronto",     name: "Toronto",      lat: 43.6532, lng: -79.3832 }),
  caFr({ slug: "montreal",    name: "Montréal",     lat: 45.5019, lng: -73.5674 }),
  caEn({ slug: "vancouver",   name: "Vancouver",    lat: 49.2827, lng: -123.1207 }),
  caEn({ slug: "calgary",     name: "Calgary",      lat: 51.0447, lng: -114.0719 }),
  caEn({ slug: "edmonton",    name: "Edmonton",     lat: 53.5461, lng: -113.4938 }),
  caEn({ slug: "ottawa",      name: "Ottawa",       lat: 45.4215, lng: -75.6972 }),
  caEn({ slug: "winnipeg",    name: "Winnipeg",     lat: 49.8951, lng: -97.1384 }),
  caEn({ slug: "mississauga", name: "Mississauga",  lat: 43.589,  lng: -79.6441 }),
  caFr({ slug: "quebec-city", name: "Québec",       lat: 46.8139, lng: -71.2080 }),
  caEn({ slug: "hamilton-ca", name: "Hamilton",     lat: 43.2557, lng: -79.8711 }),
  caEn({ slug: "brampton",    name: "Brampton",     lat: 43.7315, lng: -79.7624 }),
  caEn({ slug: "surrey",      name: "Surrey",       lat: 49.1913, lng: -122.849 }),
  caEn({ slug: "kitchener",   name: "Kitchener",    lat: 43.4516, lng: -80.4925 }),
  caEn({ slug: "halifax",     name: "Halifax",      lat: 44.6488, lng: -63.5752 }),
  caEn({ slug: "london-ca",   name: "London",       lat: 42.9849, lng: -81.2453 }),
  caEn({ slug: "markham",     name: "Markham",      lat: 43.8561, lng: -79.337 }),
  caEn({ slug: "vaughan",     name: "Vaughan",      lat: 43.8361, lng: -79.4983 }),
  caFr({ slug: "gatineau",    name: "Gatineau",     lat: 45.4765, lng: -75.7013 }),
  caEn({ slug: "saskatoon",   name: "Saskatoon",    lat: 52.1332, lng: -106.67 }),
  caEn({ slug: "burnaby",     name: "Burnaby",      lat: 49.2488, lng: -122.9805 }),
];

/**
 * Top-20 US cities by population. All English-first per queryLocale,
 * though a handful (San José CA, Miami, LA) are functionally bilingual
 * — EN coverage is strong enough in Google Places that EN queries find
 * ES-named businesses too, so we don't split.
 */
export const US_CITIES: ScraperCity[] = [
  us({ slug: "new-york",      name: "New York",      lat: 40.7128, lng: -74.0060 }),
  us({ slug: "los-angeles",   name: "Los Angeles",   lat: 34.0522, lng: -118.2437 }),
  us({ slug: "chicago",       name: "Chicago",       lat: 41.8781, lng: -87.6298 }),
  us({ slug: "houston",       name: "Houston",       lat: 29.7604, lng: -95.3698 }),
  us({ slug: "phoenix",       name: "Phoenix",       lat: 33.4484, lng: -112.074 }),
  us({ slug: "philadelphia",  name: "Philadelphia",  lat: 39.9526, lng: -75.1652 }),
  us({ slug: "san-antonio",   name: "San Antonio",   lat: 29.4241, lng: -98.4936 }),
  us({ slug: "san-diego",     name: "San Diego",     lat: 32.7157, lng: -117.1611 }),
  us({ slug: "dallas",        name: "Dallas",        lat: 32.7767, lng: -96.797 }),
  us({ slug: "san-jose",      name: "San José",      lat: 37.3382, lng: -121.8863 }),
  us({ slug: "austin",        name: "Austin",        lat: 30.2672, lng: -97.7431 }),
  us({ slug: "jacksonville",  name: "Jacksonville",  lat: 30.3322, lng: -81.6557 }),
  us({ slug: "fort-worth",    name: "Fort Worth",    lat: 32.7555, lng: -97.3308 }),
  us({ slug: "columbus-oh",   name: "Columbus",      lat: 39.9612, lng: -82.9988 }),
  us({ slug: "charlotte",     name: "Charlotte",     lat: 35.2271, lng: -80.8431 }),
  us({ slug: "indianapolis",  name: "Indianapolis",  lat: 39.7684, lng: -86.1581 }),
  us({ slug: "san-francisco", name: "San Francisco", lat: 37.7749, lng: -122.4194 }),
  us({ slug: "seattle",       name: "Seattle",       lat: 47.6062, lng: -122.3321 }),
  us({ slug: "denver",        name: "Denver",        lat: 39.7392, lng: -104.9903 }),
  us({ slug: "washington-dc", name: "Washington",    lat: 38.9072, lng: -77.0369 }),
];

/** All cities the scraper knows about, across all countries. */
export const ALL_CITIES: ScraperCity[] = [
  ...SPANISH_CITIES,
  ...CANADIAN_CITIES,
  ...US_CITIES,
];

// ---------------------------------------------------------------------------
// Dynamic city list (DB-backed)
// ---------------------------------------------------------------------------
//
// Historically every consumer iterated one of the static arrays above (50
// ES + 20 US + 20 CA = 90 cities). Since PR #41/#44 the public.cities table
// holds 3,000+ rows. Reading from that table at run-time is the whole point
// of this module — otherwise the scrapers stay stuck on the old 90 cities.
//
//   PROLIO_CITIES_SOURCE='db'      → fetch from public.cities (default)
//   PROLIO_CITIES_SOURCE='static'  → use the hardcoded arrays above
//
// "static" is a fallback for offline dev / environments without Supabase
// creds. CI and prod always run with the default ('db').

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type CitiesSource = "db" | "static";

export interface GetCitiesOptions {
  /** Filter by country. Default `'all'`. */
  country?: CountryCode | "all";
  /** Override the source. Default = env `PROLIO_CITIES_SOURCE` || 'db'. */
  source?: CitiesSource;
  /** Force-refresh the in-process cache. */
  refresh?: boolean;
}

function resolveSource(): CitiesSource {
  const raw = (process.env.PROLIO_CITIES_SOURCE ?? "").toLowerCase();
  if (raw === "static") return "static";
  if (raw === "db" || raw === "") return "db";
  console.warn(
    `[cities] unknown PROLIO_CITIES_SOURCE='${raw}', defaulting to 'db'`,
  );
  return "db";
}

/**
 * Slugs we know live in Québec (mostly via the `-qc` suffix used by
 * migration 0035, plus the legacy slugs from the original top-20 seed).
 * Used to derive `queryLocale='fr'` for CA cities pulled from the DB.
 */
const QC_SLUG_HINTS = ["-qc", "-quebec"];
const QC_KNOWN_SLUGS = new Set([
  "montreal",
  "quebec-city",
  "gatineau",
  "laval",
  "longueuil",
  "sherbrooke",
  "trois-rivieres",
  "saguenay",
  "levis",
  "terrebonne",
  "saint-jean-sur-richelieu",
  "repentigny",
  "drummondville",
  "saint-jerome",
  "granby",
  "blainville",
  "saint-hyacinthe",
  "shawinigan",
]);

function deriveQueryLocale(country: CountryCode, slug: string): "es" | "en" | "fr" {
  if (country === "ES") return "es";
  if (country !== "CA") return "en";
  if (QC_KNOWN_SLUGS.has(slug)) return "fr";
  if (QC_SLUG_HINTS.some((h) => slug.includes(h))) return "fr";
  return "en";
}

let dbCacheAll: ScraperCity[] | undefined;
let dbCacheError: Error | undefined;

function staticByCountry(country: CountryCode | "all"): ScraperCity[] {
  if (country === "all") return ALL_CITIES;
  if (country === "ES") return SPANISH_CITIES;
  if (country === "US") return US_CITIES;
  return CANADIAN_CITIES;
}

function makeServiceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function loadFromDb(): Promise<ScraperCity[]> {
  const client = makeServiceRoleClient();
  if (!client) {
    throw new Error(
      "[cities] PROLIO_CITIES_SOURCE='db' but Supabase creds missing " +
        "(set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or " +
        "set PROLIO_CITIES_SOURCE='static' for offline mode)",
    );
  }
  const out: ScraperCity[] = [];
  // Paginate; the cities table is ~3k rows but Supabase caps each select
  // at 1000 by default.
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await client
      .from("cities")
      .select("slug, name, country, lat, lng")
      .range(from, from + 999);
    if (error) {
      throw new Error(`[cities] DB load failed: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    for (const row of data as Array<{
      slug: string;
      name: string;
      country: string;
      lat: number | null;
      lng: number | null;
    }>) {
      const country = row.country as CountryCode;
      if (country !== "ES" && country !== "US" && country !== "CA") continue;
      // Some DB rows (e.g. legacy ES seeds before lat/lng was populated)
      // may be NULL. Fall back to 0,0 — the scrapers that need geo (Google
      // Places nearbySearch) can skip rows where lat===0 && lng===0; the
      // rest (textQuery, OSM Nominatim by name) don't care.
      out.push({
        slug: row.slug,
        name: row.name,
        country,
        queryLocale: deriveQueryLocale(country, row.slug),
        lat: row.lat ?? 0,
        lng: row.lng ?? 0,
      });
    }
    if (data.length < 1000) break;
  }
  if (out.length === 0) {
    throw new Error(
      "[cities] DB returned 0 rows from public.cities — refusing to run " +
        "with empty city list. Check the seed migrations have been applied.",
    );
  }
  return out;
}

/**
 * Returns the city list, optionally filtered by country.
 *
 * Default mode reads from `public.cities` and caches for the duration
 * of the process. Set `PROLIO_CITIES_SOURCE='static'` to force the
 * 90-city hardcoded fallback (useful for offline dev).
 */
export async function getCities(
  opts: GetCitiesOptions = {},
): Promise<ScraperCity[]> {
  const source = opts.source ?? resolveSource();
  const country = opts.country ?? "all";

  if (source === "static") {
    return staticByCountry(country);
  }

  if (opts.refresh) {
    dbCacheAll = undefined;
    dbCacheError = undefined;
  }
  if (!dbCacheAll && !dbCacheError) {
    try {
      dbCacheAll = await loadFromDb();
      console.log(
        `[cities] loaded ${dbCacheAll.length} cities from DB ` +
          `(${countByCountry(dbCacheAll, "ES")} ES, ` +
          `${countByCountry(dbCacheAll, "US")} US, ` +
          `${countByCountry(dbCacheAll, "CA")} CA)`,
      );
    } catch (err) {
      dbCacheError = err as Error;
      console.warn(
        `[cities] DB load failed, falling back to static 90-city list: ` +
          `${(err as Error).message}`,
      );
    }
  }
  const all = dbCacheAll ?? ALL_CITIES;
  if (country === "all") return all;
  return all.filter((c) => c.country === country);
}

function countByCountry(list: ScraperCity[], country: CountryCode): number {
  let n = 0;
  for (const c of list) if (c.country === country) n += 1;
  return n;
}

/** Test/CLI helper. Drops the in-process cache. */
export function clearCitiesCache(): void {
  dbCacheAll = undefined;
  dbCacheError = undefined;
}
