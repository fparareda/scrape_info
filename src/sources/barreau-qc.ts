import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * Barreau du Québec — public lawyer directory.
 *
 * Pre-flight: robots.txt only Disallows /umbraco. Public lookup at
 * barreau.qc.ca/fr/avocats (verify on first run; structure may vary).
 *
 * Routed to `extranjeria` since that's Prolio's lawyer category. Off
 * by default; `PROLIO_RUN_BARREAU_QC=true` to enable.
 */

const BASE = process.env.PROLIO_BARREAU_QC_BASE || "https://www.barreau.qc.ca";
const PATH = process.env.PROLIO_BARREAU_QC_PATH || "/fr/trouver-avocat";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_DELAY_MS = 1500;
const DEFAULT_LIMIT_PER_CITY = 500;
const MAX_PAGES = 200;

const QC_CITIES: Array<{ slug: string; query: string }> = [
  { slug: "montreal", query: "Montréal" },
  { slug: "quebec-city", query: "Québec" },
  { slug: "gatineau", query: "Gatineau" },
  { slug: "laval", query: "Laval" },
  { slug: "longueuil", query: "Longueuil" },
  { slug: "sherbrooke", query: "Sherbrooke" },
];

const ROW_RE =
  /(?:n[°o]?\s*(?:de\s*)?membre[^<]*?[:>]\s*)?(\d{5,7})[\s\S]{0,300}?<[^>]+class="[^"]*(?:nom|name|avocat|membre)[^"]*"[^>]*>\s*([^<]+?)\s*</gi;

interface Member {
  num: string;
  name: string;
}

async function fetchPage(query: string, page: number): Promise<string> {
  const url = new URL(`${BASE}${PATH}`);
  url.searchParams.set("ville", query);
  if (page > 1) url.searchParams.set("page", String(page));
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Barreau QC ${url.pathname} → ${response.status}`);
  }
  return response.text();
}

function parseRows(html: string): Member[] {
  const out: Member[] = [];
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
  for (const city of QC_CITIES) {
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
              source: "barreau-qc",
              country: "CA",
              sourceId: `barreau-qc:${r.num}`,
              name: toTitleCase(r.name),
              categoryKey: "extranjeria",
              citySlug: city.slug,
              licenseNumber: r.num,
              metadata: {
                country: "CA",
                province: "QC",
                authority: "Barreau du Québec",
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
        `[barreau-qc] ${city.slug} fetch failed: ${(error as Error).message}`,
      );
    }
    console.log(`[barreau-qc] ${city.slug} → ${collected} rows`);
  }
  return out;
}

export const barreauQcSource: ScraperSource = {
  name: "barreau-qc",
  enabled() {
    return process.env.PROLIO_RUN_BARREAU_QC === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runBarreauQc(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!barreauQcSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_BARREAU_QC_LIMIT_PER_CITY ?? DEFAULT_LIMIT_PER_CITY,
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
    `[barreau-qc] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
