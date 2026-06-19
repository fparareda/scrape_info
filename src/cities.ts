export type CountryCode = "ES" | "CA" | "US" | "FR" | "MX" | "GB" | "CO";

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
function fr(c: Base): ScraperCity {
  return { ...c, country: "FR", queryLocale: "fr" };
}
function mx(c: Base): ScraperCity {
  return { ...c, country: "MX", queryLocale: "es" };
}
function co(c: Base): ScraperCity {
  return { ...c, country: "CO", queryLocale: "es" };
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

/**
 * Top 30 French metro areas. Mirrors `0067_fr_cities_seed.sql`. Used
 * by CNB Avocats (data.gouv) and Architectes-FR (annuaire) sources.
 */
export const FRENCH_CITIES: ScraperCity[] = [
  fr({ slug: "paris",                  name: "Paris",                  lat: 48.8566, lng:  2.3522 }),
  fr({ slug: "marseille",              name: "Marseille",              lat: 43.2965, lng:  5.3698 }),
  fr({ slug: "lyon",                   name: "Lyon",                   lat: 45.7640, lng:  4.8357 }),
  fr({ slug: "toulouse",               name: "Toulouse",               lat: 43.6047, lng:  1.4442 }),
  fr({ slug: "nice",                   name: "Nice",                   lat: 43.7102, lng:  7.2620 }),
  fr({ slug: "nantes",                 name: "Nantes",                 lat: 47.2184, lng: -1.5536 }),
  fr({ slug: "montpellier",            name: "Montpellier",            lat: 43.6109, lng:  3.8772 }),
  fr({ slug: "strasbourg",             name: "Strasbourg",             lat: 48.5734, lng:  7.7521 }),
  fr({ slug: "bordeaux",               name: "Bordeaux",               lat: 44.8378, lng: -0.5792 }),
  fr({ slug: "lille",                  name: "Lille",                  lat: 50.6292, lng:  3.0573 }),
  fr({ slug: "rennes",                 name: "Rennes",                 lat: 48.1173, lng: -1.6778 }),
  fr({ slug: "reims",                  name: "Reims",                  lat: 49.2583, lng:  4.0317 }),
  fr({ slug: "le-havre",               name: "Le Havre",               lat: 49.4944, lng:  0.1079 }),
  fr({ slug: "saint-etienne",          name: "Saint-Étienne",          lat: 45.4397, lng:  4.3872 }),
  fr({ slug: "toulon",                 name: "Toulon",                 lat: 43.1242, lng:  5.9280 }),
  fr({ slug: "grenoble",               name: "Grenoble",               lat: 45.1885, lng:  5.7245 }),
  fr({ slug: "dijon",                  name: "Dijon",                  lat: 47.3220, lng:  5.0415 }),
  fr({ slug: "angers",                 name: "Angers",                 lat: 47.4784, lng: -0.5632 }),
  fr({ slug: "nimes",                  name: "Nîmes",                  lat: 43.8367, lng:  4.3601 }),
  fr({ slug: "villeurbanne",           name: "Villeurbanne",           lat: 45.7665, lng:  4.8795 }),
  fr({ slug: "clermont-ferrand",       name: "Clermont-Ferrand",       lat: 45.7772, lng:  3.0870 }),
  fr({ slug: "aix-en-provence",        name: "Aix-en-Provence",        lat: 43.5297, lng:  5.4474 }),
  fr({ slug: "le-mans",                name: "Le Mans",                lat: 48.0061, lng:  0.1996 }),
  fr({ slug: "brest",                  name: "Brest",                  lat: 48.3905, lng: -4.4860 }),
  fr({ slug: "tours",                  name: "Tours",                  lat: 47.3941, lng:  0.6848 }),
  fr({ slug: "amiens",                 name: "Amiens",                 lat: 49.8941, lng:  2.2958 }),
  fr({ slug: "limoges",                name: "Limoges",                lat: 45.8336, lng:  1.2611 }),
  fr({ slug: "annecy",                 name: "Annecy",                 lat: 45.8992, lng:  6.1294 }),
  fr({ slug: "perpignan",              name: "Perpignan",              lat: 42.6886, lng:  2.8949 }),
  fr({ slug: "boulogne-billancourt",   name: "Boulogne-Billancourt",   lat: 48.8359, lng:  2.2406 }),
];

/** All cities the scraper knows about, across all countries. */
/**
 * Top 30 Mexican metro areas. Mirrors `0070_mx_cities_seed.sql`.
 * INEGI 2020 censo. Slugs use `-mx` suffix where the bare slug
 * collides with another country (e.g. `leon-mx`, `merida-mx`,
 * `veracruz-mx`).
 */
export const MEXICAN_CITIES: ScraperCity[] = [
  mx({ slug: "cdmx",            name: "Ciudad de México",     lat: 19.4326, lng: -99.1332 }),
  mx({ slug: "guadalajara",     name: "Guadalajara",          lat: 20.6597, lng: -103.3496 }),
  mx({ slug: "monterrey",       name: "Monterrey",            lat: 25.6866, lng: -100.3161 }),
  mx({ slug: "puebla",          name: "Puebla",               lat: 19.0414, lng: -98.2063 }),
  mx({ slug: "tijuana",         name: "Tijuana",              lat: 32.5149, lng: -117.0382 }),
  mx({ slug: "leon-mx",         name: "León",                 lat: 21.1250, lng: -101.6860 }),
  mx({ slug: "ciudad-juarez",   name: "Ciudad Juárez",        lat: 31.6904, lng: -106.4245 }),
  mx({ slug: "zapopan",         name: "Zapopan",              lat: 20.7235, lng: -103.3848 }),
  mx({ slug: "merida-mx",       name: "Mérida",               lat: 20.9674, lng: -89.5926 }),
  mx({ slug: "san-luis-potosi", name: "San Luis Potosí",      lat: 22.1565, lng: -100.9855 }),
  mx({ slug: "aguascalientes",  name: "Aguascalientes",       lat: 21.8853, lng: -102.2916 }),
  mx({ slug: "saltillo",        name: "Saltillo",             lat: 25.4232, lng: -101.0053 }),
  mx({ slug: "mexicali",        name: "Mexicali",             lat: 32.6245, lng: -115.4523 }),
  mx({ slug: "culiacan",        name: "Culiacán",             lat: 24.8091, lng: -107.3940 }),
  mx({ slug: "naucalpan",       name: "Naucalpan",            lat: 19.4710, lng: -99.2360 }),
  mx({ slug: "acapulco",        name: "Acapulco",             lat: 16.8531, lng: -99.8237 }),
  mx({ slug: "hermosillo",      name: "Hermosillo",           lat: 29.0892, lng: -110.9613 }),
  mx({ slug: "queretaro",       name: "Querétaro",            lat: 20.5888, lng: -100.3899 }),
  mx({ slug: "chihuahua",       name: "Chihuahua",            lat: 28.6353, lng: -106.0889 }),
  mx({ slug: "morelia",         name: "Morelia",              lat: 19.7008, lng: -101.1844 }),
  mx({ slug: "cancun",          name: "Cancún",               lat: 21.1619, lng: -86.8515 }),
  mx({ slug: "tlalnepantla",    name: "Tlalnepantla de Baz",  lat: 19.5366, lng: -99.2034 }),
  mx({ slug: "toluca",          name: "Toluca",               lat: 19.2826, lng: -99.6557 }),
  mx({ slug: "veracruz-mx",     name: "Veracruz",             lat: 19.1738, lng: -96.1342 }),
  mx({ slug: "reynosa",         name: "Reynosa",              lat: 26.0509, lng: -98.2962 }),
  mx({ slug: "tampico",         name: "Tampico",              lat: 22.2553, lng: -97.8686 }),
  mx({ slug: "cuernavaca",      name: "Cuernavaca",           lat: 18.9242, lng: -99.2216 }),
  mx({ slug: "mazatlan",        name: "Mazatlán",             lat: 23.2494, lng: -106.4111 }),
  mx({ slug: "torreon",         name: "Torreón",              lat: 25.5428, lng: -103.4068 }),
  mx({ slug: "villahermosa",    name: "Villahermosa",         lat: 17.9892, lng: -92.9281 }),
];

// Colombia — curated "marked" set shown on the web. The DB `public.cities`
// table already holds the full DANE gazetteer (~1,119 municipios); this
// static list is the deliberate display whitelist (top ~30 by population).
// The long tail stays stored-but-hidden until promoted. See
// docs/SCRAPING_CO_20260619.md §1b.
export const COLOMBIAN_CITIES: ScraperCity[] = [
  co({ slug: "bogota",          name: "Bogotá",          lat: 4.7110,  lng: -74.0721 }),
  co({ slug: "medellin",        name: "Medellín",        lat: 6.2442,  lng: -75.5812 }),
  co({ slug: "cali",            name: "Cali",            lat: 3.4516,  lng: -76.5320 }),
  co({ slug: "barranquilla",    name: "Barranquilla",    lat: 10.9685, lng: -74.7813 }),
  co({ slug: "cartagena",       name: "Cartagena",       lat: 10.3910, lng: -75.4794 }),
  co({ slug: "cucuta",          name: "Cúcuta",          lat: 7.8939,  lng: -72.5078 }),
  co({ slug: "soledad",         name: "Soledad",         lat: 10.9170, lng: -74.7646 }),
  co({ slug: "soacha",          name: "Soacha",          lat: 4.5790,  lng: -74.2169 }),
  co({ slug: "bucaramanga",     name: "Bucaramanga",     lat: 7.1193,  lng: -73.1227 }),
  co({ slug: "bello",           name: "Bello",           lat: 6.3373,  lng: -75.5550 }),
  co({ slug: "villavicencio",   name: "Villavicencio",   lat: 4.1420,  lng: -73.6266 }),
  co({ slug: "pereira",         name: "Pereira",         lat: 4.8133,  lng: -75.6961 }),
  co({ slug: "valledupar",      name: "Valledupar",      lat: 10.4631, lng: -73.2532 }),
  co({ slug: "monteria",        name: "Montería",        lat: 8.7479,  lng: -75.8814 }),
  co({ slug: "ibague",          name: "Ibagué",          lat: 4.4389,  lng: -75.2322 }),
  co({ slug: "pasto",           name: "Pasto",           lat: 1.2136,  lng: -77.2811 }),
  co({ slug: "manizales",       name: "Manizales",       lat: 5.0703,  lng: -75.5138 }),
  co({ slug: "neiva",           name: "Neiva",           lat: 2.9273,  lng: -75.2819 }),
  co({ slug: "palmira",         name: "Palmira",         lat: 3.5394,  lng: -76.3036 }),
  co({ slug: "popayan",         name: "Popayán",         lat: 2.4448,  lng: -76.6147 }),
  co({ slug: "sincelejo",       name: "Sincelejo",       lat: 9.3047,  lng: -75.3978 }),
  co({ slug: "itagui",          name: "Itagüí",          lat: 6.1719,  lng: -75.6111 }),
  co({ slug: "floridablanca",   name: "Floridablanca",   lat: 7.0625,  lng: -73.0864 }),
  co({ slug: "envigado",        name: "Envigado",        lat: 6.1666,  lng: -75.5833 }),
  co({ slug: "tulua",           name: "Tuluá",           lat: 4.0847,  lng: -76.1954 }),
  co({ slug: "dosquebradas",    name: "Dosquebradas",    lat: 4.8333,  lng: -75.6667 }),
  co({ slug: "barrancabermeja", name: "Barrancabermeja", lat: 7.0653,  lng: -73.8547 }),
  co({ slug: "santa-marta",     name: "Santa Marta",     lat: 11.2408, lng: -74.1990 }),
  co({ slug: "riohacha",        name: "Riohacha",        lat: 11.5444, lng: -72.9072 }),
  co({ slug: "tunja",           name: "Tunja",           lat: 5.5353,  lng: -73.3678 }),
];

export const ALL_CITIES: ScraperCity[] = [
  ...SPANISH_CITIES,
  ...CANADIAN_CITIES,
  ...US_CITIES,
  ...FRENCH_CITIES,
  ...MEXICAN_CITIES,
  ...COLOMBIAN_CITIES,
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
  if (country === "ES" || country === "MX" || country === "CO") return "es";
  if (country === "FR") return "fr";
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
  if (country === "FR") return FRENCH_CITIES;
  if (country === "MX") return MEXICAN_CITIES;
  if (country === "CO") return COLOMBIAN_CITIES;
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
  // Stable order required for paginated range() — without it PostgREST
  // returns overlapping windows and we end up with the same row 2-3
  // times (observed 49559 rows in memory from a 17537-row table on
  // 2026-05-20, which inflated Yelp's per-day target count by 3×).
  // Defensive dedup by (country, slug) below catches any residual.
  const seen = new Set<string>();
  // Paginate; the cities table is ~17k rows but Supabase caps each
  // select at 1000 by default.
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await client
      .from("cities")
      .select("slug, name, country, lat, lng")
      .order("country", { ascending: true })
      .order("slug", { ascending: true })
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
      // 2026-05-14: dropped the country whitelist (was 'ES'|'US'|'CA') that
      // silently filtered out MX and FR rows. The CountryCode union (line 1)
      // already covers all five countries; the DB has 300+ MX cities seeded
      // that were never loaded, leaving validSlugs empty → every MX source
      // dropped 100% of categorised rows by city. Discovered via SIEM
      // (kept=0 dropped_no_city=18,631).
      if (
        country !== "ES" &&
        country !== "US" &&
        country !== "CA" &&
        country !== "FR" &&
        country !== "MX" &&
        country !== "CO"
      )
        continue;
      // Defensive dedup — see comment above the loop.
      const key = `${country}::${row.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
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
