import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * 411.ca — Canadian general-purpose business directory.
 *
 * Public search at:
 *   https://411.ca/business/search?what=<term>&where=<city>&p=<N>
 *
 * Pre-flight 2026-05-26 (datacenter IP):
 *   HTTP 200 in ~1s, ~260 KB HTML, no Cloudflare/Akamai challenge.
 *   The site is an Angular SPA but the **first server-side render**
 *   already contains the 25 listings as schema.org markup (`itemprop=
 *   "name|streetAddress|telephone"`). No JS execution needed.
 *
 * Result-page anatomy (verified plumber+toronto = 348 results):
 *   - `<div class="search-result-message">… <strong>N</strong> results</div>`
 *   - 25 cards per page, sponsors interleaved (~30 anchors total)
 *   - Card link:  `<a class="listing-card-link" href="/business/profile/<id>">`
 *   - Inside: `<h4 itemprop="name">`, `<address>` with itemprop chain,
 *     `<a class="btn-listing-phone" href="tel:…"><span itemprop="telephone">`,
 *     `<a class="btn-listing-website" href="https://…">`.
 *   - Pagination: `?p=2`, `?p=3`, … Site caps at ~40 pages (~1k results).
 *
 * Strategy: enumerate (category, city) pairs against the cities DB
 * filtered to CA. One textual term per CategoryKey. For QC cities we
 * pass the French term when available; 411 is bilingual and accepts
 * both. Pagination stops on the first empty page or when we reach the
 * declared `N results` count.
 *
 * Rate limit: 2 s between requests. The site doesn't publish a robots
 * stance against business search but we stay conservative — full run
 * ≈ 10 cats × 20 cities × 5 pages × 2 s ≈ 35 min.
 *
 * Off by default — `PROLIO_RUN_411_CA=true` to enable.
 * Cap via `PROLIO_411_CA_LIMIT` (global, default 25_000).
 * Per-combo page cap `PROLIO_411_CA_PAGES_PER_COMBO` (default 5).
 * Subset (debug) `PROLIO_411_CA_ONLY_CATEGORIES=plumber,electrician`.
 */

const BASE_URL = "https://411.ca/business/search";
const SOURCE_NAME = "411-ca" as ScrapeSource;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 2000;
const DEFAULT_GLOBAL_LIMIT = 25_000;
const DEFAULT_PAGES_PER_COMBO = 5;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

/**
 * Category mapping: Prolio CategoryKey → 411.ca search term.
 * EN term used as primary; FR variant used for QC cities to improve
 * recall on Quebec-only listings.
 */
interface CategoryQuery {
  key: CategoryKey;
  en: string;
  fr: string;
}

const CATEGORY_MAP: CategoryQuery[] = [
  { key: "fontaneria", en: "plumber", fr: "plombier" },
  { key: "electricidad", en: "electrician", fr: "electricien" },
  { key: "hvac", en: "hvac contractor", fr: "chauffage climatisation" },
  { key: "carpinteria", en: "carpenter", fr: "menuisier" },
  { key: "cerrajero", en: "locksmith", fr: "serrurier" },
  { key: "mecanica", en: "auto mechanic", fr: "mecanicien auto" },
  { key: "abogado", en: "lawyer", fr: "avocat" },
  { key: "dentista", en: "dentist", fr: "dentiste" },
  { key: "medicina", en: "doctor", fr: "medecin" },
  { key: "veterinario", en: "veterinarian", fr: "veterinaire" },
  { key: "fisioterapia", en: "physiotherapist", fr: "physiotherapeute" },
  { key: "psicologia", en: "psychologist", fr: "psychologue" },
  { key: "arquitecto", en: "architect", fr: "architecte" },
  { key: "fiscal", en: "accountant", fr: "comptable" },
  { key: "notario", en: "notary", fr: "notaire" },
];

export const fourElevenCaSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_411_CA === "true";
  },
  async fetch() {
    return [];
  },
};

interface RawCard {
  profileId: string;
  name: string;
  street?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  telephone?: string;
  website?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function clean(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPage(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-CA,en;q=0.9,fr-CA;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[411-ca] ${url} HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(`[411-ca] ${url} fetch error: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseTotalResults(html: string): number | null {
  // <div class="search-result-message">…<strong>348</strong> results</div>
  const m = html.match(
    /<div\s+class="search-result-message"[^>]*>([\s\S]{0,500}?)<\/div>/i,
  );
  if (!m) return null;
  const text = clean(m[1]);
  const m2 = text.match(/([\d,]+)\s+results?/i);
  if (!m2) return null;
  const n = Number(m2[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractItemProp(
  block: string,
  prop: string,
  tag = "span",
): string | undefined {
  const re = new RegExp(
    `<${tag}[^>]+itemprop="${prop}"[^>]*>([\\s\\S]*?)</${tag}>`,
    "i",
  );
  const m = block.match(re);
  return m ? clean(m[1]) : undefined;
}

function parseCards(html: string): RawCard[] {
  const out: RawCard[] = [];
  const seen = new Set<string>();
  // Match each listing-card-link anchor along with its sibling card-controls.
  // Cards are siblings inside a `card listing-card` wrapper. We pin the
  // window to the next sibling `card-controls` div which holds tel/site.
  const cardRe =
    /<a\s+class="listing-card-link"[^>]*href="\/business\/profile\/(\d+)"[^>]*>([\s\S]*?)<\/a>\s*<div\s+class="card-controls"[^>]*>([\s\S]*?)<\/div>/gi;

  for (const m of html.matchAll(cardRe)) {
    const profileId = m[1];
    if (seen.has(profileId)) continue;
    const inner = m[2];
    const controls = m[3];

    const nameMatch = inner.match(
      /<h[1-6][^>]+itemprop="name"[^>]*>([\s\S]*?)<\/h[1-6]>/i,
    );
    const name = nameMatch ? clean(nameMatch[1]) : "";
    if (!name) continue;

    const street = extractItemProp(inner, "streetAddress");
    const locality = extractItemProp(inner, "addressLocality");
    const region = extractItemProp(inner, "addressRegion");
    const postalCode = extractItemProp(inner, "postalCode");
    const telephone = extractItemProp(controls, "telephone");

    // Website: <a class="btn-listing-website" href="http(s)://…" rel=…>
    let website: string | undefined;
    const siteMatch = controls.match(
      /<a[^>]*class="[^"]*btn-listing-website[^"]*"[^>]*href="(https?:[^"]+)"/i,
    );
    if (siteMatch) {
      website = siteMatch[1];
    }

    seen.add(profileId);
    out.push({
      profileId,
      name,
      street,
      locality,
      region,
      postalCode,
      telephone,
      website,
    });
  }
  return out;
}

interface ComboPlan {
  cat: CategoryQuery;
  citySlug: string;
  cityName: string;
  term: string;
}

function buildPlan(
  cities: Array<{ slug: string; name: string; queryLocale: string }>,
  categories: CategoryQuery[],
): ComboPlan[] {
  const out: ComboPlan[] = [];
  for (const cat of categories) {
    for (const c of cities) {
      const term = c.queryLocale === "fr" ? cat.fr : cat.en;
      out.push({ cat, citySlug: c.slug, cityName: c.name, term });
    }
  }
  return out;
}

function parseEnvList(env: string | undefined): Set<string> | null {
  if (!env) return null;
  const items = env
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length > 0 ? new Set(items) : null;
}

function filterCategories(only: Set<string> | null): CategoryQuery[] {
  if (!only) return CATEGORY_MAP;
  return CATEGORY_MAP.filter(
    (c) =>
      only.has(c.key.toLowerCase()) ||
      only.has(c.en.toLowerCase()) ||
      only.has(c.fr.toLowerCase()),
  );
}

export async function run411Ca(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!fourElevenCaSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const globalLimit = Number(
    process.env.PROLIO_411_CA_LIMIT ?? DEFAULT_GLOBAL_LIMIT,
  );
  const cap =
    Number.isFinite(globalLimit) && globalLimit > 0
      ? globalLimit
      : DEFAULT_GLOBAL_LIMIT;

  const pagesPerCombo = Number(
    process.env.PROLIO_411_CA_PAGES_PER_COMBO ?? DEFAULT_PAGES_PER_COMBO,
  );
  const pagesCap =
    Number.isFinite(pagesPerCombo) && pagesPerCombo > 0
      ? pagesPerCombo
      : DEFAULT_PAGES_PER_COMBO;

  const onlyCats = parseEnvList(process.env.PROLIO_411_CA_ONLY_CATEGORIES);
  const cats = filterCategories(onlyCats);

  const allCities = await getCities({ country: "CA" });
  if (allCities.length === 0) {
    console.warn("[411-ca] no CA cities seeded — aborting");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const plan = buildPlan(allCities, cats);
  console.log(
    `[411-ca] plan: ${cats.length} cats × ${allCities.length} cities = ${plan.length} combos, pagesPerCombo=${pagesCap}, cap=${cap}`,
  );

  const records: ScrapedProfessional[] = [];
  const seenSourceIds = new Set<string>();
  let combosDone = 0;

  outer: for (const combo of plan) {
    if (records.length >= cap) break;
    let comboYield = 0;
    let comboTotal: number | null = null;

    for (let page = 1; page <= pagesCap; page += 1) {
      if (records.length >= cap) break outer;
      const url =
        `${BASE_URL}?what=${encodeURIComponent(combo.term)}` +
        `&where=${encodeURIComponent(combo.cityName)}` +
        `&p=${page}`;
      const html = await fetchPage(url);
      if (!html) break;
      if (page === 1) comboTotal = parseTotalResults(html);
      const cards = parseCards(html);
      if (cards.length === 0) break;

      for (const card of cards) {
        const sourceId = `411:${card.profileId}`;
        if (seenSourceIds.has(sourceId)) continue;
        seenSourceIds.add(sourceId);

        const addressParts = [
          card.street,
          card.locality,
          card.region,
          card.postalCode,
        ]
          .filter(Boolean)
          .join(", ");

        records.push(
          normalise({
            source: SOURCE_NAME,
            country: "CA",
            sourceId,
            name: card.name,
            categoryKey: combo.cat.key,
            citySlug: combo.citySlug,
            phone: card.telephone,
            website: card.website,
            address: addressParts || undefined,
            metadata: {
              country: "CA",
              province: card.region ?? null,
              postal_code: card.postalCode ?? null,
              locality: card.locality ?? null,
              search_term: combo.term,
              search_city: combo.cityName,
              source_url: `https://411.ca/business/profile/${card.profileId}`,
            },
          }),
        );
        comboYield += 1;
        if (records.length >= cap) break outer;
      }

      // Stop early if we already covered the declared total
      if (comboTotal !== null && comboYield >= comboTotal) break;
      await delay(REQUEST_DELAY_MS);
    }

    combosDone += 1;
    if (combosDone % 25 === 0) {
      console.log(
        `[411-ca] progress: ${combosDone}/${plan.length} combos, records=${records.length}`,
      );
    }
  }

  if (records.length === 0) {
    console.warn(`[411-ca] no records — search returned empty across plan`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[411-ca] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped} combos=${combosDone}/${plan.length}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
