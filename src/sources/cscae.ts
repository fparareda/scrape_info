import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * CSCAE — Consejo Superior de los Colegios de Arquitectos de España.
 *
 * Pre-flight: robots.txt is Joomla-default (blocks /administrator/,
 * /cache/, etc.). Public buscador not under those paths.
 *
 * National census ⇒ covers all 16 colegios autonómicos via single
 * endpoint. Off by default; `PROLIO_RUN_CSCAE=true` to enable.
 */

const BASE = process.env.PROLIO_CSCAE_BASE || "https://www.cscae.com";
const PATH = process.env.PROLIO_CSCAE_PATH || "/buscador-arquitectos";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_DELAY_MS = 2000;
const DEFAULT_LIMIT_PER_CITY = 1000;
const MAX_PAGES = 300;

const ES_CITIES: Array<{ slug: string; query: string }> = [
  { slug: "madrid", query: "Madrid" },
  { slug: "barcelona", query: "Barcelona" },
  { slug: "valencia", query: "Valencia" },
  { slug: "sevilla", query: "Sevilla" },
  { slug: "zaragoza", query: "Zaragoza" },
  { slug: "malaga", query: "Málaga" },
  { slug: "bilbao", query: "Bilbao" },
  { slug: "alicante", query: "Alicante" },
  { slug: "vigo", query: "Vigo" },
  { slug: "granada", query: "Granada" },
];

const ROW_RE =
  /(?:n[º°o]?\s*coleg[^<]*?[:>]\s*|colegiad[oa][^<]*?[:>]\s*)?(\d{3,7})[\s\S]{0,300}?<[^>]+class="[^"]*(?:nombre|name|arquitecto|colegiado)[^"]*"[^>]*>\s*([^<]+?)\s*</gi;

interface Arquitecto {
  num: string;
  name: string;
}

async function fetchPage(query: string, page: number): Promise<string> {
  const url = new URL(`${BASE}${PATH}`);
  url.searchParams.set("ciudad", query);
  if (page > 1) url.searchParams.set("page", String(page));
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`CSCAE ${url.pathname} → ${response.status}`);
  return response.text();
}

function parseRows(html: string): Arquitecto[] {
  const out: Arquitecto[] = [];
  const seen = new Set<string>();
  ROW_RE.lastIndex = 0;
  for (const m of html.matchAll(ROW_RE)) {
    const [, num, name] = m;
    if (num && name && !seen.has(num)) {
      seen.add(num);
      out.push({ num, name: name.trim() });
    }
  }
  return out;
}

async function fetchAll(limitPerCity: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  for (const city of ES_CITIES) {
    const seen = new Set<string>();
    let collected = 0;
    try {
      for (let p = 1; p <= MAX_PAGES; p += 1) {
        if (collected >= limitPerCity) break;
        const html = await fetchPage(city.query, p);
        const rows = parseRows(html);
        if (rows.length === 0) break;
        let added = 0;
        for (const r of rows) {
          if (seen.has(r.num)) continue;
          seen.add(r.num);
          out.push(
            normalise({
              source: "colegio",
              sourceId: `cscae:${city.slug}:${r.num}`,
              name: toTitleCase(r.name),
              categoryKey: "arquitecto",
              citySlug: city.slug,
              licenseNumber: r.num,
              metadata: {
                country: "ES",
                authority: "CSCAE",
                colegio: "CSCAE",
                verified_by_authority: true,
              },
            }),
          );
          collected += 1;
          added += 1;
          if (collected >= limitPerCity) break;
        }
        if (added === 0) break;
        if (p < MAX_PAGES) await delay(REQUEST_DELAY_MS);
      }
    } catch (error) {
      console.error(
        `[cscae] ${city.slug} fetch failed: ${(error as Error).message}`,
      );
    }
    console.log(`[cscae] ${city.slug} → ${collected} rows`);
  }
  return out;
}

export const cscaeSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_CSCAE === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCscae(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cscaeSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_CSCAE_LIMIT_PER_CITY ?? DEFAULT_LIMIT_PER_CITY,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT_PER_CITY;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[cscae] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
