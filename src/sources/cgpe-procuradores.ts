import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * CGPE — Consejo General de Procuradores de España.
 *
 * Federation site lists ~52 provincial colegios de procuradores
 * (Procuradores de los Tribunales) totalling ~10k procuradores
 * nationally. The federation publishes a buscador de procuradores
 * pointing at each colegio's own public listing.
 *
 * Pre-flight: robots.txt under cgpe.es is permissive (no blanket
 * Disallow). Respectful UA + low concurrency (2s between requests).
 *
 * Routed to `abogado` because procurador is a legal-profession sibling
 * of abogado in Spain (separate colegio, but legal practice all the
 * same). Pre-2026-05 this was `extranjeria` as a stopgap. If we ever
 * add a dedicated `procurador` category, switch here. Off by default;
 * `PROLIO_RUN_CGPE=true` to enable. Cap via
 * `PROLIO_CGPE_LIMIT_PER_CITY` (default 1000).
 *
 * Scrapeability classification (verify on first run):
 *   A (HTML buscador, public)   — CGPE national buscador, plus ICPM
 *                                  (Madrid), ICPB (Barcelona), ICPSE
 *                                  (Sevilla), ICPV (Valencia).
 *   B (JS-rendered)             — none confirmed; fall back to HTML.
 *   C (auth-only / private)     — small provincial colegios may not
 *                                  expose a list; logged + skipped.
 */

const BASE = process.env.PROLIO_CGPE_BASE || "https://www.cgpe.es";
const PATH =
  process.env.PROLIO_CGPE_PATH || "/buscador-procuradores";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_DELAY_MS = 2000;
const DEFAULT_LIMIT_PER_CITY = 1000;
const MAX_PAGES = 300;

/** Spanish provincial capitals — closest match to the 52-colegio
 *  network. The CGPE buscador accepts a `ciudad` filter; if a colegio
 *  is not exposed nationally, the per-colegio entry below is reserved
 *  for future direct scrapes. */
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
  { slug: "valladolid", query: "Valladolid" },
  { slug: "cordoba", query: "Córdoba" },
  { slug: "murcia", query: "Murcia" },
  { slug: "las-palmas-de-gran-canaria", query: "Las Palmas" },
  { slug: "santa-cruz-de-tenerife", query: "Santa Cruz de Tenerife" },
  { slug: "palma", query: "Palma" },
  { slug: "oviedo", query: "Oviedo" },
  { slug: "santander", query: "Santander" },
  { slug: "pamplona", query: "Pamplona" },
  { slug: "vitoria-gasteiz", query: "Vitoria-Gasteiz" },
  { slug: "logrono", query: "Logroño" },
  { slug: "toledo", query: "Toledo" },
  { slug: "badajoz", query: "Badajoz" },
  { slug: "caceres", query: "Cáceres" },
  { slug: "a-coruna", query: "A Coruña" },
  { slug: "salamanca", query: "Salamanca" },
  { slug: "burgos", query: "Burgos" },
  { slug: "leon", query: "León" },
  { slug: "donostia-san-sebastian", query: "Donostia" },
  { slug: "castellon-de-la-plana", query: "Castellón" },
  { slug: "almeria", query: "Almería" },
  { slug: "huelva", query: "Huelva" },
  { slug: "cadiz", query: "Cádiz" },
  { slug: "jaen", query: "Jaén" },
];

const ROW_RE =
  /(?:n[º°o]?\s*coleg[^<]*?[:>]\s*|procurad[oa][^<]*?[:>]\s*|colegiad[oa][^<]*?[:>]\s*)?(\d{3,7})[\s\S]{0,300}?<[^>]+class="[^"]*(?:nombre|name|procurador|colegiado)[^"]*"[^>]*>\s*([^<]+?)\s*</gi;

interface Procurador {
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
  if (!response.ok) throw new Error(`CGPE ${url.pathname} → ${response.status}`);
  return response.text();
}

function parseRows(html: string): Procurador[] {
  const out: Procurador[] = [];
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
              country: "ES",
              sourceId: `cgpe:${city.slug}:${r.num}`,
              name: toTitleCase(r.name),
              categoryKey: "abogado",
              citySlug: city.slug,
              licenseNumber: r.num,
              metadata: {
                country: "ES",
                authority: "CGPE",
                colegio: "CGPE",
                profession: "procurador",
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
        `[cgpe] ${city.slug} fetch failed: ${(error as Error).message}`,
      );
    }
    console.log(`[cgpe] ${city.slug} → ${collected} rows`);
  }
  return out;
}

export const cgpeProcuradoresSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_CGPE_PROCURADORES === "true";
  },
  async fetch() {
    return [];
  },
} as ScraperSource;

export async function runCgpeProcuradores(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cgpeProcuradoresSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_CGPE_LIMIT_PER_CITY ?? DEFAULT_LIMIT_PER_CITY,
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
    `[cgpe] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
