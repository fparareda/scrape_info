import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeTarget,
} from "../types.js";
import { normalise } from "../normalise.js";

/**
 * OpenStreetMap source via Overpass API.
 *
 * OSM is free, legal (ODbL) and unlimited (with courteous rate limiting).
 * Coverage is strong for established/long-running businesses in cities
 * and weaker for newly-opened pymes — complementary to Google Places,
 * not a replacement.
 *
 * The Overpass query resolves the city boundary by name (admin_level=8,
 * Spanish municipality) and pulls every node/way/relation tagged with
 * one of our category's OSM tags. We project OSM tags to our categories
 * deliberately — OSM's tagging is inconsistent, so better too broad than
 * too narrow; the sink will de-duplicate by (source, source_id).
 *
 * Docs:
 *   - https://wiki.openstreetmap.org/wiki/Overpass_API
 *   - https://wiki.openstreetmap.org/wiki/Key:office
 *   - https://wiki.openstreetmap.org/wiki/Key:craft
 *   - https://wiki.openstreetmap.org/wiki/Key:shop
 */

const ENDPOINT = "https://overpass-api.de/api/interpreter";
// Overpass fair-use is ~10k queries/day/IP. A full ES sweep of the 0043
// seed (~730 cities × 9 categories = 6,570 queries) fits comfortably
// inside that budget at 1.5 s between calls. Keep this conservative —
// we run weekly, not hourly.
const REQUEST_DELAY_MS = 1500;
const TIMEOUT_SEC = 25;
const MAX_RETRIES = 3;
// Overpass emits 429 ("Too Many Requests") and 504 ("Gateway Timeout")
// under load. Back off exponentially — the public endpoint needs ~30 s
// to recover a thread slot when it hands out a 429.
const BACKOFF_BASE_MS = 5_000;

/**
 * OSM tag filters per Prolio category. Each entry is a (key,value) pair
 * that Overpass accepts as `[key=value]`. Multiple entries per category
 * are OR-ed.
 */
const OSM_TAGS: Record<CategoryKey, Array<[string, string]>> = {
  fiscal: [
    ["office", "tax_advisor"],
    ["office", "accountant"],
  ],
  extranjeria: [
    // OSM can't express "immigration lawyer" — we pull all lawyers and
    // accept over-capture. Owners who claim can correct the category.
    ["office", "lawyer"],
  ],
  psicologia: [
    ["healthcare", "psychotherapist"],
    ["office", "psychologist"],
    ["healthcare", "psychology"],
  ],
  medicina: [
    ["amenity", "doctors"],
    ["amenity", "clinic"],
  ],
  dentista: [
    ["amenity", "dentist"],
    ["healthcare", "dentist"],
  ],
  fisioterapia: [
    ["healthcare", "physiotherapist"],
    ["amenity", "physiotherapist"],
  ],
  veterinario: [
    ["amenity", "veterinary"],
  ],
  notario: [
    ["office", "notary"],
  ],
  arquitecto: [
    ["office", "architect"],
  ],
  cerrajero: [
    ["craft", "locksmith"],
    ["shop", "locksmith"],
  ],
  hvac: [
    ["craft", "hvac"],
    ["trade", "hvac"],
    ["shop", "air_conditioning"],
  ],
  carpinteria: [
    ["craft", "carpenter"],
  ],
  fontaneria: [
    ["craft", "plumber"],
  ],
  electricidad: [
    ["craft", "electrician"],
  ],
  mecanica: [
    ["shop", "car_repair"],
  ],
  itv: [
    ["amenity", "vehicle_inspection"],
  ],
  ingenieria: [
    ["office", "engineer"],
  ],
};

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildQuery(cityName: string, tags: Array<[string, string]>): string {
  // `admin_level=8` targets Spanish municipios. If a city name clashes
  // between provincia and municipio (e.g. "Álava") Overpass picks the
  // tighter boundary; we accept that the first hit is good enough.
  const filters = tags
    .map(([k, v]) => `  nwr["${k}"="${v}"](area.a);`)
    .join("\n");
  return `[out:json][timeout:${TIMEOUT_SEC}];
area["name"="${cityName}"]["admin_level"="8"]->.a;
(
${filters}
);
out center tags;`;
}

function buildAddress(tags: Record<string, string>): string | undefined {
  const street = tags["addr:street"];
  if (!street) return undefined;
  const parts = [street];
  if (tags["addr:housenumber"]) parts.push(tags["addr:housenumber"]);
  let line = parts.join(" ");
  const postcode = tags["addr:postcode"];
  const city = tags["addr:city"];
  if (postcode || city) {
    line += `, ${[postcode, city].filter(Boolean).join(" ")}`;
  }
  return line;
}

function mapElement(
  el: OverpassElement,
  target: ScrapeTarget,
): ScrapedProfessional | null {
  const tags = el.tags ?? {};
  const name = tags.name;
  if (!name) return null;

  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;

  return normalise({
    source: "osm",
    sourceId: `${el.type}/${el.id}`,
    name,
    categoryKey: target.categoryKey,
    citySlug: target.citySlug,
    phone: tags.phone ?? tags["contact:phone"],
    email: tags.email ?? tags["contact:email"],
    website: tags.website ?? tags["contact:website"] ?? tags.url,
    address: buildAddress(tags),
    lat,
    lng: lon,
    openingHours: tags.opening_hours ? [tags.opening_hours] : undefined,
    metadata: {
      osm_type: el.type,
      tags,
    },
  });
}

export const osmSource: ScraperSource = {
  name: "osm",

  enabled() {
    // Off by default so the Google-centric weekly run doesn't do 2x the
    // work. Flip PROLIO_SCRAPE_OSM=true in CI or .env.local to enable.
    return process.env.PROLIO_SCRAPE_OSM === "true";
  },

  async fetch(target: ScrapeTarget): Promise<ScrapedProfessional[]> {
    // Multi-country since 2026-05-07. Per OSM Wiki, admin_level=8 maps
    // to "city/municipio/commune" across ES/FR/US/CA — the original
    // ES-only gate was over-cautious. Veterinarios/notarios/cerrajeros/
    // hvac/mecanica are sparse in our FR/CA/US official sources but
    // OSM has decent coverage for tagged businesses, so this single
    // change unlocks meaningful volume across the gaps.
    //
    // Tag quality varies — false negatives in CA/US suburbs are
    // expected. Sink dedupes against Google Places via (source,
    // source_id) so OSM rows complement rather than duplicate.
    //
    // Opt out via PROLIO_OSM_COUNTRIES (CSV); unset = iterate every
    // target.
    const allowedCountries = process.env.PROLIO_OSM_COUNTRIES
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowedCountries && !allowedCountries.includes(target.country)) {
      return [];
    }
    const tags = OSM_TAGS[target.categoryKey];
    if (!tags || tags.length === 0) return [];

    const query = buildQuery(target.cityName, tags);
    let response: Response | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Prolio/0.1 (ferranp.work@gmail.com)",
          },
          body: new URLSearchParams({ data: query }).toString(),
        });
      } catch (error) {
        // Network errors (DNS, connection reset) get one retry; repeated
        // failures usually mean the public endpoint is down and pushing
        // harder won't help.
        if (attempt >= 1) {
          console.error(
            `[osm] network error on ${target.categoryKey}/${target.citySlug}:`,
            (error as Error).message,
          );
          return [];
        }
        await delay(BACKOFF_BASE_MS);
        continue;
      }

      if (response.ok) break;

      // Overpass uses 429 for rate-limit and 504 for exhausted slots —
      // both self-heal with a pause. Anything else (400 bad query, 500)
      // won't fix itself; drop the target and move on.
      if (response.status !== 429 && response.status !== 504) {
        const text = await response.text();
        console.error(
          `[osm] ${response.status} on ${target.categoryKey}/${target.citySlug}: ${text.slice(0, 120)}`,
        );
        await delay(REQUEST_DELAY_MS);
        return [];
      }
      if (attempt === MAX_RETRIES) {
        console.error(
          `[osm] giving up after ${MAX_RETRIES + 1} tries on ${target.categoryKey}/${target.citySlug} (last status ${response.status})`,
        );
        return [];
      }
      const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
      console.warn(
        `[osm] ${response.status} on ${target.categoryKey}/${target.citySlug}, retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await delay(backoff);
    }

    if (!response || !response.ok) return [];

    let data: OverpassResponse;
    try {
      data = (await response.json()) as OverpassResponse;
    } catch {
      console.error(`[osm] invalid JSON on ${target.categoryKey}/${target.citySlug}`);
      return [];
    }

    const byId = new Map<string, ScrapedProfessional>();
    for (const el of data.elements ?? []) {
      const mapped = mapElement(el, target);
      if (!mapped) continue;
      byId.set(mapped.sourceId, mapped);
    }

    // Be a good Overpass citizen — space requests out.
    await delay(REQUEST_DELAY_MS);
    return Array.from(byId.values());
  },
};
