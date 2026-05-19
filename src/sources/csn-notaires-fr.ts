/**
 * Conseil Supérieur du Notariat (France) — annuaire officiel.
 *
 * Closes the TYPE_B gap "FR notario" identified in
 * audit-output/per-country-category.csv (was 0 rows pre-fix).
 *
 * Site: https://www.notaires.fr/fr/directory/notaries
 * Volume claimed by the site: 7,368 offices + 17,653 notaires.
 *
 * Strategy:
 *   1. Iterate by département (95 + DOM-TOM). Each département page
 *      returns paginated HTML with notary office cards.
 *   2. Parse each card for office name, address, phone, website, plus a
 *      detail link that holds the list of notaires inside the office.
 *   3. Emit one ScrapedProfessional per notaire (or per office if the
 *      detail page isn't followed — see TODO below).
 *
 * Status: SCAFFOLDED. The HTML selectors below are placeholders based
 * on the search-result page structure (postal_code / departement query
 * params, result cards with .annuaire-card class). Verify them with a
 * Playwright probe before turning the scraper on — the site updates
 * its markup occasionally.
 *
 * Politeness:
 *   - Single concurrent request, 1.5s delay between pages
 *   - Honest User-Agent string identifying the project
 *   - Backs off on 429/503
 */

import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeTarget,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";

const SOURCE_NAME = "csn-notaires-fr";
const CATEGORY: CategoryKey = "notario";

const ENDPOINT = "https://www.notaires.fr/fr/directory/notaries";
const USER_AGENT =
  "Prolio/0.1 (https://prolio.co; ferranp.work@gmail.com) — public-directory scrape, contact for rate complaints";
const REQUEST_DELAY_MS = 1500;

// French départements. 95 metropolitan + 5 DOM. Used to iterate the
// directory by département so we can fan out without missing pages.
const DEPARTEMENTS: ReadonlyArray<string> = [
  "01","02","03","04","05","06","07","08","09","10","11","12","13","14",
  "15","16","17","18","19","21","22","23","24","25","26","27","28","29",
  "2A","2B","30","31","32","33","34","35","36","37","38","39","40","41",
  "42","43","44","45","46","47","48","49","50","51","52","53","54","55",
  "56","57","58","59","60","61","62","63","64","65","66","67","68","69",
  "70","71","72","73","74","75","76","77","78","79","80","81","82","83",
  "84","85","86","87","88","89","90","91","92","93","94","95",
  "971","972","973","974","976",
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface NotaryListing {
  name: string;
  officeName?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  cityName?: string;
  postalCode?: string;
  detailUrl?: string;
}

/** Build the URL for a département page. */
function departementUrl(dept: string, page: number): string {
  // The site uses query params (mot-cle, departement, langues_parlees,
  // and a numeric page index). Empty mot-cle returns all matches.
  const params = new URLSearchParams({
    "mot-cle": "",
    departement: dept,
    langues_parlees: "All",
    page: String(page),
  });
  return `${ENDPOINT}?${params.toString()}`;
}

/**
 * Best-effort HTML parser. The site renders results inside cards with
 * a class like `annuaire-card` or `directory-result`. Selectors are
 * fragile — when the markup changes the parser returns 0 and we log
 * loudly instead of producing garbage.
 *
 * TODO before enabling: replace the placeholder regexes with selectors
 * verified against a live response. Recommended approach: run
 * `curl https://www.notaires.fr/fr/directory/notaries?departement=75`
 * and grep for repeating wrapper elements.
 */
function parseListings(html: string): NotaryListing[] {
  const out: NotaryListing[] = [];
  // Heuristic split: each result card lives inside a wrapper whose
  // class contains "annuaire" or "result". Until verified live, return
  // empty so the scrape is a no-op rather than emitting bad data.
  void html;
  return out;
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
      },
    });
    if (response.status === 429 || response.status === 503) {
      console.warn(`[${SOURCE_NAME}] throttled (${response.status}); waiting`);
      await delay(30_000);
      return null;
    }
    if (!response.ok) {
      console.warn(`[${SOURCE_NAME}] ${response.status} on ${url}`);
      return null;
    }
    return await response.text();
  } catch (err) {
    console.error(
      `[${SOURCE_NAME}] network error on ${url}:`,
      (err as Error).message,
    );
    return null;
  }
}

export const csnNotairesFrSource: ScraperSource = {
  name: SOURCE_NAME,

  enabled() {
    // Default-off until the parser is validated against the live site.
    // Enable via PROLIO_SCRAPE_CSN_FR=true once parseListings is wired up.
    return process.env.PROLIO_SCRAPE_CSN_FR === "true";
  },

  async fetch(target: ScrapeTarget): Promise<ScrapedProfessional[]> {
    // CSN is FR-only. The scraper runs once across all FR départements
    // regardless of which target city is being processed — emit nothing
    // for non-FR or non-notario targets to avoid duplicate work.
    if (target.country !== "FR") return [];
    if (target.categoryKey !== CATEGORY) return [];

    const out: ScrapedProfessional[] = [];
    const seen = new Set<string>();

    for (const dept of DEPARTEMENTS) {
      for (let page = 0; page < 50; page += 1) {
        const url = departementUrl(dept, page);
        const html = await fetchPage(url);
        if (!html) break;
        const listings = parseListings(html);
        if (listings.length === 0) break;

        for (const listing of listings) {
          const baseId = listing.detailUrl ?? `${listing.name}-${listing.postalCode ?? dept}`;
          const sourceId = `csn:${slugify(baseId)}`;
          if (seen.has(sourceId)) continue;
          seen.add(sourceId);

          const citySlug = listing.cityName ? slugify(listing.cityName) : "";

          out.push(
            normalise({
              source: SOURCE_NAME,
              country: "FR",
              sourceId,
              name: listing.name,
              categoryKey: CATEGORY,
              citySlug,
              address: listing.address,
              phone: listing.phone,
              email: listing.email,
              website: listing.website,
              metadata: {
                authority: "Conseil Supérieur du Notariat",
                departement: dept,
                office_name: listing.officeName,
                postal_code: listing.postalCode,
                verified_by_authority: true,
                source_url: url,
                ...(citySlug ? {} : { province_slug: `fr-${dept.toLowerCase()}`, location_granularity: "province" }),
              },
            }),
          );
        }

        await delay(REQUEST_DELAY_MS);
      }
    }

    return out;
  },
};

