import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeTarget,
} from "../../types.js";
import { normalise } from "../../normalise.js";

/**
 * Col·legi Oficial de Psicologia de Catalunya — public directory.
 *
 * Source: https://www.copc.cat/es/colegiat?city=<cityName>&page=<N>
 * Only exposes num_colegiat + name per row, no contact details. We still
 * ingest it because it gives us (1) licence verification, (2) SEO
 * inventory under `psicologia/<city>`, and (3) seed rows that pros can
 * later claim and enrich.
 *
 * No Cloudflare challenge at the time of wiring; server is Apache + Odoo.
 * Each page returns ~20 rows. We paginate until a page returns 0 rows,
 * pausing between requests to stay polite.
 */

const BASE = "https://www.copc.cat";
const USER_AGENT =
  "Mozilla/5.0 (compatible; ProlioBot/1.0; +https://prolio.co/bot)";
const REQUEST_DELAY_MS = 600;
const MAX_PAGES = 200;

/**
 * COPC is Catalonia-wide. Map Prolio city slugs to the cityName token the
 * COPC search expects. Cities not in this map are skipped (COPC can't
 * serve them).
 */
const CITY_TO_COPC_NAME: Record<string, string> = {
  barcelona: "Barcelona",
};

const ROW_RE =
  /<tr>\s*<td>\s*<span>(\d+)<\/span>\s*<\/td>\s*<td>\s*<a\s+href="([^"]+)"[^>]*>\s*<span>([^<]+)<\/span>/g;

interface ColegiatRow {
  numCol: string;
  profileUrl: string;
  name: string;
}

async function fetchPage(cityName: string, page: number): Promise<string> {
  const url = new URL(`${BASE}/es/colegiat${page > 1 ? `/page/${page}` : ""}`);
  url.searchParams.set("city", cityName);

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  if (!response.ok) {
    throw new Error(`COPC ${url.pathname}?${url.searchParams} → ${response.status}`);
  }
  return response.text();
}

function parseRows(html: string): ColegiatRow[] {
  const rows: ColegiatRow[] = [];
  ROW_RE.lastIndex = 0;
  for (const match of html.matchAll(ROW_RE)) {
    const [, numCol, profileUrl, name] = match;
    if (numCol && profileUrl && name) {
      rows.push({ numCol, profileUrl, name: name.trim() });
    }
  }
  return rows;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const copcSource: ScraperSource = {
  name: "colegio",

  enabled() {
    return process.env.PROLIO_SCRAPE_COLEGIOS === "true";
  },

  async fetch(target: ScrapeTarget): Promise<ScrapedProfessional[]> {
    if (target.categoryKey !== "psicologia") return [];

    const cityName = CITY_TO_COPC_NAME[target.citySlug];
    if (!cityName) return [];

    const seen = new Set<string>();
    const out: ScrapedProfessional[] = [];

    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const html = await fetchPage(cityName, page);
        const rows = parseRows(html);
        if (rows.length === 0) break;

        let newThisPage = 0;
        for (const row of rows) {
          if (seen.has(row.numCol)) continue;
          seen.add(row.numCol);
          newThisPage += 1;
          out.push(
            normalise({
              source: "colegio",
              sourceId: `copc:${row.numCol}`,
              name: toTitleCase(row.name),
              categoryKey: "psicologia",
              citySlug: target.citySlug,
              licenseNumber: row.numCol,
              metadata: {
                colegio: "COPC",
                profile_url: row.profileUrl.startsWith("http")
                  ? row.profileUrl
                  : `${BASE}${row.profileUrl}`,
              },
            }),
          );
        }

        // Dedupe-only page means we've circled back past the end.
        if (newThisPage === 0) break;

        if (page < MAX_PAGES) await delay(REQUEST_DELAY_MS);
      }
    } catch (error) {
      console.error("[copc] fetch failed:", error);
    }

    return out;
  },
};

/** COPC stores names in ALL CAPS. Convert to Title Case preserving accents. */
function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((token) =>
      /\s+|-/.test(token)
        ? token
        : token.charAt(0).toUpperCase() + token.slice(1),
    )
    .join("");
}
