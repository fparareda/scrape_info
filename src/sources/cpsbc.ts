import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * CPSBC — College of Physicians and Surgeons of British Columbia.
 *
 * Pre-flight: robots.txt is Drupal-default. Disallow list blocks
 * /admin/, /search/, /user/* — but the public registrant lookup at
 * cpsbc.ca/registrant-search is NOT in the disallow list, so this is
 * permitted. Verify HTML structure on first run.
 *
 * Off by default; `PROLIO_RUN_CPSBC=true` to enable.
 */

const BASE = process.env.PROLIO_CPSBC_BASE || "https://www.cpsbc.ca";
const PATH = process.env.PROLIO_CPSBC_PATH || "/registrant-search";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_DELAY_MS = 1500;
const DEFAULT_LIMIT_PER_CITY = 500;
const MAX_PAGES = 200;

const BC_CITIES: Array<{ slug: string; query: string }> = [
  { slug: "vancouver", query: "Vancouver" },
  { slug: "surrey", query: "Surrey" },
  { slug: "burnaby", query: "Burnaby" },
  { slug: "richmond", query: "Richmond" },
  { slug: "victoria", query: "Victoria" },
  { slug: "abbotsford", query: "Abbotsford" },
  { slug: "coquitlam", query: "Coquitlam" },
  { slug: "kelowna", query: "Kelowna" },
];

/** CPSBC uses 5-digit registrant numbers. */
const ROW_RE =
  /(?:registration[^<]*?[:>]\s*|reg\.?\s*#?\s*)?(\d{4,6})[\s\S]{0,300}?<[^>]+class="[^"]*(?:name|registrant)[^"]*"[^>]*>\s*([^<]+?)\s*</gi;

interface Member {
  num: string;
  name: string;
}

async function fetchPage(query: string, page: number): Promise<string> {
  const url = new URL(`${BASE}${PATH}`);
  url.searchParams.set("city", query);
  if (page > 1) url.searchParams.set("page", String(page));
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`CPSBC ${url.pathname} → ${response.status}`);
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
  for (const city of BC_CITIES) {
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
              source: "cpsbc",
              sourceId: `cpsbc:${r.num}`,
              name: toTitleCase(r.name),
              categoryKey: "medicina",
              citySlug: city.slug,
              licenseNumber: r.num,
              metadata: {
                country: "CA",
                province: "BC",
                authority: "CPSBC",
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
        `[cpsbc] ${city.slug} fetch failed: ${(error as Error).message}`,
      );
    }
    console.log(`[cpsbc] ${city.slug} → ${collected} rows`);
  }
  return out;
}

export const cpsbcSource: ScraperSource = {
  name: "cpsbc",
  enabled() {
    return process.env.PROLIO_RUN_CPSBC === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCpsbc(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cpsbcSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_CPSBC_LIMIT_PER_CITY ?? DEFAULT_LIMIT_PER_CITY,
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
    `[cpsbc] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
