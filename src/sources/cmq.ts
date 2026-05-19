import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * CMQ — Collège des médecins du Québec.
 *
 * Pre-flight: robots.txt has no Disallow for `*`; Crawl-delay 30s
 * specified for several bots. We honour that with REQUEST_DELAY_MS
 * even though our UA isn't listed.
 *
 * Public "Bottin des médecins" lookup at cmq.org/repertoire-membres
 * (verify on first run; URL/structure may differ). The lookup is
 * paginated with city + specialty filters; we iterate the QC cities
 * Prolio has seeded.
 *
 * Off by default. `PROLIO_RUN_CMQ=true` to enable. Cap with
 * `PROLIO_CMQ_LIMIT_PER_CITY` (default 500).
 */

const BASE = process.env.PROLIO_CMQ_BASE || "https://www.cmq.org";
const PATH = process.env.PROLIO_CMQ_PATH || "/repertoire-membres";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_DELAY_MS = 30_000; // honour Crawl-delay
const DEFAULT_LIMIT_PER_CITY = 500;
const MAX_PAGES = 200;

/**
 * QC cities in Prolio's seed. Slugs come from cities.ts (CA seed
 * migration 0018 + 0035). Add more via env if needed.
 */
const QC_CITIES: Array<{ slug: string; query: string }> = [
  { slug: "montreal", query: "Montréal" },
  { slug: "quebec-city", query: "Québec" },
  { slug: "gatineau", query: "Gatineau" },
  { slug: "laval", query: "Laval" },
  { slug: "longueuil", query: "Longueuil" },
  { slug: "sherbrooke", query: "Sherbrooke" },
];

/**
 * Permissive row matcher. Looks for `<num>` (5–6 digits) paired with a
 * person-like name. Tweak when live HTML is verified.
 */
const ROW_RE =
  /(?:n[°o]?\s*(?:de\s*)?membre[^<]*?[:>]\s*)?(\d{5,7})[\s\S]{0,300}?<[^>]+class="[^"]*(?:nom|name|membre|medecin)[^"]*"[^>]*>\s*([^<]+?)\s*</gi;

interface Member {
  num: string;
  name: string;
}

async function fetchPage(cityQuery: string, page: number): Promise<string> {
  const url = new URL(`${BASE}${PATH}`);
  url.searchParams.set("ville", cityQuery);
  if (page > 1) url.searchParams.set("page", String(page));
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`CMQ ${url.pathname}?${url.searchParams} → ${response.status}`);
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
    const cityRows: Member[] = [];
    const seen = new Set<string>();
    try {
      for (let p = 1; p <= MAX_PAGES; p += 1) {
        if (cityRows.length >= limitPerCity) break;
        const html = await fetchPage(city.query, p);
        const rows = parseRows(html);
        if (rows.length === 0) break;
        let added = 0;
        for (const r of rows) {
          if (seen.has(r.num)) continue;
          seen.add(r.num);
          cityRows.push(r);
          added += 1;
          if (cityRows.length >= limitPerCity) break;
        }
        if (added === 0) break;
        if (p < MAX_PAGES) await delay(REQUEST_DELAY_MS);
      }
    } catch (error) {
      console.error(
        `[cmq] ${city.slug} fetch failed: ${(error as Error).message}`,
      );
    }
    for (const r of cityRows) {
      out.push(
        normalise({
          source: "cmq",
          country: "CA",
          sourceId: `cmq:${r.num}`,
          name: toTitleCase(r.name),
          categoryKey: "medicina",
          citySlug: city.slug,
          licenseNumber: r.num,
          metadata: {
            country: "CA",
            province: "QC",
            authority: "CMQ",
            verified_by_authority: true,
          },
        }),
      );
    }
    console.log(`[cmq] ${city.slug} → ${cityRows.length} rows`);
  }
  return out;
}

export const cmqSource: ScraperSource = {
  name: "cmq",
  enabled() {
    return process.env.PROLIO_RUN_CMQ === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCmq(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cmqSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_CMQ_LIMIT_PER_CITY ?? DEFAULT_LIMIT_PER_CITY,
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
    `[cmq] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
