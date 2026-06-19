import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeTarget,
} from "../types.js";
import { normalise } from "../normalise.js";
import { buildQueries } from "../queries/build.js";

/**
 * Yelp Fusion API — /businesses/search with paginated fan-out per
 * (category × city, optionally × barrio) target.
 *
 * Docs:
 *   - https://docs.developer.yelp.com/reference/v3_business_search
 *   - https://docs.developer.yelp.com/docs/fusion-rate-limiting
 *
 * Strategy mirrors google-places.ts:
 *   1. `buildQueries` yields N text queries per target (barrio × synonym
 *      in Madrid/Barcelona, synonym-only elsewhere). We reuse it and
 *      pass each query as `term`, with `cityName` as `location`.
 *   2. Paginate via `offset` up to MAX_PAGES (Yelp caps offset+limit at
 *      1000; we stop earlier to stay polite).
 *   3. Dedup per-target by `business.id` (same business reappears across
 *      barrios for dense cities).
 *
 * Limits:
*   - Daily quota cap is 5000 calls (default); halt-on-429 protects us
 *     if the actual plan ceiling is lower. Tune via YELP_DAILY_BUDGET.
 *   - Yelp's geo coverage is strong in US/CA, partial in EU, sparse in
 *     MX/ES — empty results in those locales are expected, not a bug.
 */

const ENDPOINT = "https://api.yelp.com/v3/businesses/search";
const PAGE_SIZE = 50;
const MAX_PAGES = 4; // 4 × 50 = 200 rows per query (offset 0,50,100,150)
const REQUEST_DELAY_MS = 150;

const BUDGET_DEFAULT = 5000;
const BUDGET_RAW = Number(process.env.YELP_DAILY_BUDGET || BUDGET_DEFAULT);
const BUDGET =
  Number.isFinite(BUDGET_RAW) && BUDGET_RAW > 0 ? BUDGET_RAW : BUDGET_DEFAULT;

let requestsUsed = 0;
let budgetWarned = false;
// Module-level halt flag. Once tripped (budget exhausted OR a 429
// from Yelp), every subsequent `fetch(target)` call returns [] without
// touching the API. Without this, the orchestrator keeps iterating
// 4000+ remaining targets and each one fires a fresh request → mass
// 429 storm and possible IP-level throttling.
let halted = false;

interface YelpBusiness {
  id: string;
  alias?: string;
  name: string;
  url?: string;
  phone?: string;
  display_phone?: string;
  rating?: number;
  review_count?: number;
  coordinates?: { latitude?: number; longitude?: number };
  location?: {
    address1?: string;
    address2?: string;
    address3?: string;
    city?: string;
    zip_code?: string;
    country?: string;
    state?: string;
    display_address?: string[];
  };
  categories?: Array<{ alias: string; title: string }>;
  is_closed?: boolean;
  image_url?: string;
}

interface YelpSearchResponse {
  businesses?: YelpBusiness[];
  total?: number;
  error?: { code?: string; description?: string };
}

const LOCALE_BY_COUNTRY: Record<ScrapeTarget["country"], string> = {
  ES: "es_ES",
  CA: "en_CA",
  US: "en_US",
  FR: "fr_FR",
  MX: "es_MX",
  GB: "en_GB",
  CO: "es_CO",
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(
  apiKey: string,
  term: string,
  location: string,
  offset: number,
  locale: string,
): Promise<YelpSearchResponse> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("term", term);
  url.searchParams.set("location", location);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("locale", locale);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (response.status === 429) {
    // Daily quota exhausted — surface so caller halts the whole run.
    throw new Error("yelp_fusion 429: daily quota exhausted");
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `yelp_fusion ${response.status}: ${text.slice(0, 200)} (term="${term}" location="${location}")`,
    );
  }
  return (await response.json()) as YelpSearchResponse;
}

function formatAddress(business: YelpBusiness): string | undefined {
  const display = business.location?.display_address;
  if (display && display.length > 0) return display.join(", ");
  const loc = business.location;
  if (!loc) return undefined;
  return [loc.address1, loc.address2, loc.address3, loc.city, loc.zip_code]
    .filter(Boolean)
    .join(", ") || undefined;
}

export function getYelpFusionRequestsUsed(): number {
  return requestsUsed;
}

export const yelpFusionSource: ScraperSource = {
  name: "yelp_fusion",

  enabled() {
    if (process.env.PROLIO_SCRAPE_YELP === "false") return false;
    return Boolean(process.env.YELP_API_KEY);
  },

  async fetch(target: ScrapeTarget): Promise<ScrapedProfessional[]> {
    if (halted) return [];
    const apiKey = process.env.YELP_API_KEY;
    if (!apiKey) return [];
    // Yelp coverage outside US/CA is sparse and burns daily quota for
    // near-zero results. US-only by default; override with
    // YELP_COUNTRIES="US,CA,ES,FR,MX" if you ever want to widen.
    const allowed = (process.env.YELP_COUNTRIES || "US")
      .split(",")
      .map((s) => s.trim().toUpperCase());
    if (!allowed.includes(target.country)) return [];

    const queries = buildQueries(
      target.categoryKey,
      target.citySlug,
      target.cityName,
      target.queryLocale,
    );
    if (queries.length === 0) return [];

    const locale = LOCALE_BY_COUNTRY[target.country];
    const byId = new Map<string, ScrapedProfessional>();

    for (const query of queries) {
      // `buildQueries` returns strings like "<synonym> en <barrio> <city>";
      // for Yelp we pass the synonym as `term` and the geographic suffix
      // as `location`. Rather than re-parse, send the full query as term
      // and rely on Yelp's relevance ranking — empirically returns the
      // same top results as splitting them.
      const term = query;
      const location = target.cityName;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        if (requestsUsed >= BUDGET) {
          if (!budgetWarned) {
            console.warn(
              `[yelp_fusion] budget exhausted (${BUDGET} requests) — halting`,
            );
            budgetWarned = true;
          }
          halted = true;
          return Array.from(byId.values());
        }
        requestsUsed += 1;

        let data: YelpSearchResponse;
        try {
          data = await fetchPage(apiKey, term, location, page * PAGE_SIZE, locale);
        } catch (error) {
          const msg = (error as Error).message;
          console.error(`[yelp_fusion] ${msg}`);
          // Halt the whole run on 429 so we don't burn budget on errors.
          if (msg.includes("429")) {
            budgetWarned = true;
            halted = true;
            return Array.from(byId.values());
          }
          break;
        }

        const businesses = data.businesses ?? [];
        if (businesses.length === 0) break;

        for (const biz of businesses) {
          if (!biz.id || !biz.name) continue;
          if (biz.is_closed) continue;
          if (byId.has(biz.id)) continue;

          byId.set(
            biz.id,
            normalise({
              source: "yelp_fusion",
              country: target.country,
              sourceId: biz.id,
              name: biz.name,
              categoryKey: target.categoryKey,
              citySlug: target.citySlug,
              address: formatAddress(biz),
              lat: biz.coordinates?.latitude,
              lng: biz.coordinates?.longitude,
              phone: biz.phone || biz.display_phone,
              website: biz.url,
              rating: biz.rating,
              reviewCount: biz.review_count,
              photoUrl: biz.image_url,
              metadata: {
                query,
                alias: biz.alias,
                categories: biz.categories?.map((c) => c.alias),
                yelp_state: biz.location?.state,
                yelp_country: biz.location?.country,
              },
            }),
          );
        }

        // Stop if we got a short page (no more results).
        if (businesses.length < PAGE_SIZE) break;
        await delay(REQUEST_DELAY_MS);
      }
      await delay(REQUEST_DELAY_MS);
    }

    return Array.from(byId.values());
  },
};
