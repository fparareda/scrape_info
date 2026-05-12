import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * CGAE — Consejo General de la Abogacía Española.
 *
 * Pre-flight: robots.txt blocks several specific bots (GPTBot,
 * SemrushBot, AhrefsBot, bingbot…) but no Disallow for User-agent: *.
 * Our `Prolio-Bot/1.0` UA isn't in the blocklist; respectful UA + low
 * concurrency.
 *
 * Public buscador: abogacia.es/servicios/abogados/buscador-de-letrados/
 * (verify on first run). National census ⇒ covers all 28 provincial
 * colegios via a single endpoint.
 *
 * Routed to `extranjeria` (Prolio's lawyer category). Off by default;
 * `PROLIO_RUN_CGAE=true` to enable. Cap with `PROLIO_CGAE_LIMIT_PER_CITY`
 * (default 1000).
 */

const BASE = process.env.PROLIO_CGAE_BASE || "https://www.abogacia.es";
const PATH =
  process.env.PROLIO_CGAE_PATH ||
  "/servicios/abogados/buscador-de-letrados";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_DELAY_MS = 2000;
const DEFAULT_LIMIT_PER_CITY = 1000;
const MAX_PAGES = 300;

/** Spanish capitals + Madrid metro — verify against cities seed. */
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
  /(?:n[º°o]?\s*coleg[^<]*?[:>]\s*|colegiad[oa][^<]*?[:>]\s*)?(\d{3,7})[\s\S]{0,300}?<[^>]+class="[^"]*(?:nombre|name|abogado|letrado|colegiado)[^"]*"[^>]*>\s*([^<]+?)\s*</gi;

interface Letrado {
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
  if (!response.ok) throw new Error(`CGAE ${url.pathname} → ${response.status}`);
  return response.text();
}

function parseRows(html: string): Letrado[] {
  const out: Letrado[] = [];
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
              sourceId: `cgae:${city.slug}:${r.num}`,
              name: toTitleCase(r.name),
              categoryKey: "extranjeria",
              citySlug: city.slug,
              licenseNumber: r.num,
              metadata: {
                country: "ES",
                authority: "CGAE",
                colegio: "CGAE",
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
        `[cgae] ${city.slug} fetch failed: ${(error as Error).message}`,
      );
    }
    console.log(`[cgae] ${city.slug} → ${collected} rows`);
  }
  return out;
}

export const cgaeSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_CGAE === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCgae(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cgaeSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_CGAE_LIMIT_PER_CITY ?? DEFAULT_LIMIT_PER_CITY,
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
    `[cgae] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
