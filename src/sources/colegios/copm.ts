import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeTarget,
} from "../../types.js";
import { normalise } from "../../normalise.js";

/**
 * Colegio Oficial de la Psicología de Madrid (COP Madrid) — public
 * directory of colegiados.
 *
 * Source candidates (verify on first run):
 *   - https://www.copmadrid.org/web/buscador-de-profesionales
 *   - https://www.copmadrid.org/buscador
 *
 * COP Madrid exposes a public lookup with name + colegiate number,
 * sometimes specialty + town. Like COPC, contact details are not
 * always public — but we still ingest because (1) licence
 * verification, (2) SEO inventory under `psicologia/madrid`, and (3)
 * seed rows that pros can later claim and enrich.
 *
 * Strategy: paginated GET, parse rows with a permissive regex. If the
 * site moves to a JS-only lookup, swap `fetchPage` for a Playwright
 * call — the row parser stays.
 */

const BASE = process.env.PROLIO_COPM_BASE || "https://www.copmadrid.org";
const PATH = process.env.PROLIO_COPM_PATH || "/web/buscador-de-profesionales";
const USER_AGENT =
  "Mozilla/5.0 (compatible; ProlioBot/1.0; +https://prolio.co/bot)";
const REQUEST_DELAY_MS = 800;
const MAX_PAGES = 200;

const CITY_TO_COPM_NAME: Record<string, string> = {
  madrid: "Madrid",
  alcala: "Alcalá de Henares",
  "alcala-henares": "Alcalá de Henares",
  mostoles: "Móstoles",
  fuenlabrada: "Fuenlabrada",
  leganes: "Leganés",
  getafe: "Getafe",
  alcorcon: "Alcorcón",
};

interface ColegiatRow {
  numCol: string;
  name: string;
  profileUrl?: string;
}

/**
 * Permissive row matcher. Looks for any structure that pairs a
 * colegiate number (3-6 digits) with a person-like name. Tweak when
 * the live HTML is verified.
 */
const ROW_RE =
  /(?:nº?\s*coleg[^<]*?[:>]\s*|colegiad[oa][^<]*?[:>]\s*)?(\d{3,6})[\s\S]{0,200}?<[^>]+class="[^"]*(?:nombre|name|profesional)[^"]*"[^>]*>\s*([^<]+?)\s*</gi;

async function fetchPage(cityName: string, page: number): Promise<string> {
  const url = new URL(`${BASE}${PATH}`);
  url.searchParams.set("localidad", cityName);
  if (page > 1) url.searchParams.set("page", String(page));

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  if (!response.ok) {
    throw new Error(
      `COPM ${url.pathname}?${url.searchParams} → ${response.status}`,
    );
  }
  return response.text();
}

function parseRows(html: string): ColegiatRow[] {
  const rows: ColegiatRow[] = [];
  const seen = new Set<string>();
  ROW_RE.lastIndex = 0;
  for (const match of html.matchAll(ROW_RE)) {
    const [, numCol, name] = match;
    if (numCol && name && !seen.has(numCol)) {
      seen.add(numCol);
      rows.push({ numCol, name: name.trim() });
    }
  }
  return rows;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const copmSource: ScraperSource = {
  name: "colegio",

  enabled() {
    return process.env.PROLIO_SCRAPE_COLEGIOS === "true";
  },

  async fetch(target: ScrapeTarget): Promise<ScrapedProfessional[]> {
    if (target.categoryKey !== "psicologia") return [];

    const cityName = CITY_TO_COPM_NAME[target.citySlug];
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
              sourceId: `copm:${row.numCol}`,
              name: toTitleCase(row.name),
              categoryKey: "psicologia",
              citySlug: target.citySlug,
              licenseNumber: row.numCol,
              metadata: {
                colegio: "COPM",
                profile_url: row.profileUrl,
              },
            }),
          );
        }

        if (newThisPage === 0) break;
        if (page < MAX_PAGES) await delay(REQUEST_DELAY_MS);
      }
    } catch (error) {
      console.error("[copm] fetch failed:", error);
    }

    return out;
  },
};

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
