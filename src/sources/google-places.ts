import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeTarget,
} from "../types.js";
import { normalise } from "../normalise.js";
import { buildQueries } from "../queries/build.js";

/**
 * Google Places (New) — Text Search with pagination and multi-query fan-out.
 *
 * Docs:
 *   - https://developers.google.com/maps/documentation/places/web-service/text-search
 *   - https://developers.google.com/maps/documentation/places/web-service/pagination
 *
 * Strategy:
 *   1. For each target (category, city) we build N queries via `buildQueries`
 *      — barrio × synonym in Madrid / Barcelona, synonym-only elsewhere.
 *   2. Each query paginates via `pageToken` up to `MAX_PAGES` (3 = 60 rows).
 *   3. Results are deduped per-target by `place_id` before we return — the
 *      same despacho may appear for several barrio queries.
 *
 * Cost:
 *   - Basic-tier Text Search ≈ $17 / 1000 requests ($200/mo Maps credit).
 *   - With 50 cities × 3 categories × (barrios × syn or syn-only) × 3 pages
 *     ≈ ~2k requests/week, ~$35/week, ~$140/month → under the free tier.
 */

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "nextPageToken",
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.regularOpeningHours.weekdayDescriptions",
].join(",");

const MAX_PAGES = 3;
const PAGE_SIZE = 20;
const REQUEST_DELAY_MS = 120;

/**
 * Hard ceiling on API requests for a single scrape run. Guards against
 * billing surprises when pagination or synonym fan-out grows faster than
 * the cost model. Configurable via PROLIO_PLACES_BUDGET.
 *
 * Default: 4500 requests = ~$144 at Pro Text Search ($32/1k), leaving
 * a safety margin inside Google's $200/mo free Maps credit.
 */
const BUDGET = Number(process.env.PROLIO_PLACES_BUDGET ?? "4500");

let requestsUsed = 0;
let budgetWarned = false;

interface PlacesResponse {
  nextPageToken?: string;
  places?: Array<{
    id: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    nationalPhoneNumber?: string;
    internationalPhoneNumber?: string;
    websiteUri?: string;
    rating?: number;
    userRatingCount?: number;
    businessStatus?: string;
    regularOpeningHours?: { weekdayDescriptions?: string[] };
  }>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(
  apiKey: string,
  query: string,
  pageToken: string | undefined,
  regionCode: "ES" | "CA" | "US",
  languageCode: "es" | "en" | "fr",
): Promise<PlacesResponse> {
  const body: Record<string, unknown> = {
    textQuery: query,
    regionCode,
    languageCode,
    pageSize: PAGE_SIZE,
  };
  if (pageToken) body.pageToken = pageToken;

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `google_places ${response.status}: ${text.slice(0, 200)} (query="${query}")`,
    );
  }
  return (await response.json()) as PlacesResponse;
}

export function getGooglePlacesRequestsUsed(): number {
  return requestsUsed;
}

export const googlePlacesSource: ScraperSource = {
  name: "google_places",

  enabled() {
    // Opt-out via env so a CI run can skip Google (e.g. an OSM-only pass)
    // without touching the secret.
    if (process.env.PROLIO_SCRAPE_GOOGLE === "false") return false;
    return Boolean(process.env.GOOGLE_PLACES_API_KEY);
  },

  async fetch(target: ScrapeTarget): Promise<ScrapedProfessional[]> {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) return [];

    const queries = buildQueries(
      target.categoryKey,
      target.citySlug,
      target.cityName,
      target.queryLocale,
    );
    if (queries.length === 0) return [];
    const byId = new Map<string, ScrapedProfessional>();

    for (const query of queries) {
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        if (requestsUsed >= BUDGET) {
          if (!budgetWarned) {
            console.warn(
              `[google_places] budget exhausted (${BUDGET} requests) — halting`,
            );
            budgetWarned = true;
          }
          return Array.from(byId.values());
        }
        requestsUsed += 1;
        let data: PlacesResponse;
        try {
          data = await fetchPage(
            apiKey,
            query,
            pageToken,
            target.country,
            target.queryLocale,
          );
        } catch (error) {
          console.error(`[google_places] ${(error as Error).message}`);
          break;
        }

        for (const place of data.places ?? []) {
          if (!place.id || !place.displayName?.text) continue;
          if (place.businessStatus && place.businessStatus !== "OPERATIONAL") {
            continue;
          }
          if (byId.has(place.id)) continue;

          byId.set(
            place.id,
            normalise({
              source: "google_places",
              sourceId: place.id,
              name: place.displayName.text,
              categoryKey: target.categoryKey,
              citySlug: target.citySlug,
              address: place.formattedAddress,
              lat: place.location?.latitude,
              lng: place.location?.longitude,
              phone:
                place.internationalPhoneNumber ?? place.nationalPhoneNumber,
              website: place.websiteUri,
              rating: place.rating,
              reviewCount: place.userRatingCount,
              openingHours: place.regularOpeningHours?.weekdayDescriptions,
              metadata: { query },
            }),
          );
        }

        pageToken = data.nextPageToken;
        if (!pageToken) break;
        await delay(REQUEST_DELAY_MS);
      }
      await delay(REQUEST_DELAY_MS);
    }

    return Array.from(byId.values());
  },
};
