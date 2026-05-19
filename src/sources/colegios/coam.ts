import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeTarget,
} from "../../types.js";
import { normalise } from "../../normalise.js";

/**
 * Colegio Oficial de Arquitectos de Madrid (COAM) — public registry
 * of colegiated architects.
 *
 * Source candidates (verify on first run):
 *   - https://www.coam.org/es/profesionales/buscador
 *   - https://www.coam.org/es/colegiados
 *
 * COAM publishes name + colegiate number per colegiado. Like COPC and
 * COPM, no contact details — but the licence number is the trust
 * signal that distinguishes these from Google Places entries.
 */

const BASE = process.env.PROLIO_COAM_BASE || "https://www.coam.org";
const PATH = process.env.PROLIO_COAM_PATH || "/es/profesionales/buscador";
const USER_AGENT =
  "Mozilla/5.0 (compatible; ProlioBot/1.0; +https://prolio.co/bot)";
const REQUEST_DELAY_MS = 800;
const MAX_PAGES = 200;

const SUPPORTED_CITIES = new Set([
  "madrid",
  "alcala-henares",
  "mostoles",
  "fuenlabrada",
  "leganes",
  "getafe",
  "alcorcon",
]);

const ROW_RE =
  /(?:nº?\s*coleg[^<]*?[:>]\s*|colegiad[oa][^<]*?[:>]\s*)?(\d{4,6})[\s\S]{0,200}?<[^>]+class="[^"]*(?:nombre|name|profesional|arquitecto)[^"]*"[^>]*>\s*([^<]+?)\s*</gi;

interface ColegiatRow {
  numCol: string;
  name: string;
}

async function fetchPage(cityName: string, page: number): Promise<string> {
  const url = new URL(`${BASE}${PATH}`);
  url.searchParams.set("localidad", cityName);
  if (page > 1) url.searchParams.set("page", String(page));

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  if (!response.ok) {
    throw new Error(
      `COAM ${url.pathname}?${url.searchParams} → ${response.status}`,
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

export const coamSource: ScraperSource = {
  name: "colegio",

  enabled() {
    return process.env.PROLIO_SCRAPE_COLEGIOS === "true";
  },

  async fetch(target: ScrapeTarget): Promise<ScrapedProfessional[]> {
    if (target.categoryKey !== "arquitecto") return [];
    if (!SUPPORTED_CITIES.has(target.citySlug)) return [];

    const seen = new Set<string>();
    const out: ScrapedProfessional[] = [];

    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const html = await fetchPage(target.cityName, page);
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
              country: "ES",
              sourceId: `coam:${row.numCol}`,
              name: toTitleCase(row.name),
              categoryKey: "arquitecto",
              citySlug: target.citySlug,
              licenseNumber: row.numCol,
              metadata: { colegio: "COAM" },
            }),
          );
        }

        if (newThisPage === 0) break;
        if (page < MAX_PAGES) await delay(REQUEST_DELAY_MS);
      }
    } catch (error) {
      console.error("[coam] fetch failed:", error);
    }

    return out;
  },
};
