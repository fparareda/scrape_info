import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, frPostalCodeToCitySlug, toTitleCase } from "./_bulk-utils.js";

/**
 * OEC — Ordre des Experts-Comptables. National French registry of
 * tax/accounting professionals (~22 000 firms, the only authority that
 * can certify "expert-comptable" status under French law).
 *
 * Pre-flight 2026-05-07:
 *   - https://annuaire.experts-comptables.org/  → 200 OK, plain Apache,
 *     CSRF cookie only, no Cloudflare/Imperva.
 *   - https://www.experts-comptables.fr/trouver-un-expert-comptable
 *     → 404 (page retired by OEC).
 *   - data.gouv.fr `q=experts comptables` → 0 datasets, no bulk CSV.
 *   → Annuaire HTML scrape is the only viable path.
 *
 * Strategy:
 *   1. Iterate top FR metro postal codes (Paris arrondissements + 7
 *      other major metros — same set architectes-fr uses).
 *   2. For each CP hit GET /recherche/ville/{citySlug}/{page}?departmentCode={dept}
 *      and walk paginations.
 *   3. The site's listing card embeds the cabinet slug (id-name-city-cp)
 *      in /expert-comptable/{id}-{slug}-{cp} hrefs — that's enough for
 *      name + city + CP + sourceId without needing a fiche fetch per row.
 *      Phone/email require fiche fetches; deferred to a future v2 to
 *      keep the run under workflow timeout.
 *
 * The annuaire uses a `seed` query param so server-side ordering is
 * stable for a given seed; we read whatever seed the first page returns
 * to keep all pages of a CP consistent.
 *
 * Off by default. `PROLIO_RUN_OEC_FR=true` to enable. Cap with
 * `PROLIO_OEC_FR_LIMIT` (default 2000). 1.5s delay between requests
 * to stay polite — at 10 rows/page that's ~5min for the cap.
 *
 * Prolio category: `fiscal` (asesor-fiscal, key in DB: fiscal). FR has
 * zero rows in this category before this scraper.
 */

const BASE = "https://annuaire.experts-comptables.org";
const DEFAULT_LIMIT = 2000;
const REQUEST_DELAY_MS = 1500;
const MAX_PAGES_PER_CITY = 50; // 10 rows/page → 500/city max
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

interface CityTarget {
  /** URL slug used by the annuaire (e.g. "paris", "lyon") */
  urlSlug: string;
  /** Département code, used as departmentCode query param */
  dept: string;
  /** Prolio city slug (paris, lyon, marseille…) */
  prolioCitySlug: string;
}

/**
 * Top-9 FR metros, ordered by population. Architectes-fr iterates CPs
 * but OEC paginates by city slug rather than CP, so one entry per
 * metro suffices. We rely on the cabinet's own slug-suffix CP for the
 * actual department bucketing in case the annuaire returns nearby
 * communes within the city's drill-down.
 */
const TARGET_CITIES: CityTarget[] = [
  { urlSlug: "paris", dept: "75", prolioCitySlug: "paris" },
  { urlSlug: "marseille", dept: "13", prolioCitySlug: "marseille" },
  { urlSlug: "lyon", dept: "69", prolioCitySlug: "lyon" },
  { urlSlug: "toulouse", dept: "31", prolioCitySlug: "toulouse" },
  { urlSlug: "nice", dept: "06", prolioCitySlug: "nice" },
  { urlSlug: "nantes", dept: "44", prolioCitySlug: "nantes" },
  { urlSlug: "strasbourg", dept: "67", prolioCitySlug: "strasbourg" },
  { urlSlug: "bordeaux", dept: "33", prolioCitySlug: "bordeaux" },
  { urlSlug: "lille", dept: "59", prolioCitySlug: "lille" },
];

/**
 * Listing card href:
 *   /expert-comptable/{numericId}-{name-slug}-{citySlug}-{cp5}
 * Anchor at end: postal code is exactly 5 digits, city slug is the
 * trailing dash-separated segments before it. We split on the last
 * 5-digit code to recover name + city.
 */
const FICHE_HREF_RE =
  /href="\/expert-comptable\/(\d+)-([a-z0-9-]+)-(\d{5})"/g;

/**
 * Pagination link pattern:
 *   /recherche/ville/{slug}/{N}?departmentCode={dept}&seed={seed}
 * We extract the max N and the seed.
 */
const PAGINATION_RE =
  /\/recherche\/ville\/[a-z0-9-]+\/(\d+)\?departmentCode=\d+(?:&amp;seed=(\d+))?/g;

interface ListingPage {
  rows: Array<{ id: string; nameSlug: string; cp: string }>;
  maxPage: number;
  seed: string | null;
}

function parseListing(html: string): ListingPage {
  const seenIds = new Set<string>();
  const rows: ListingPage["rows"] = [];
  FICHE_HREF_RE.lastIndex = 0;
  for (const match of html.matchAll(FICHE_HREF_RE)) {
    const [, id, nameSlug, cp] = match;
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    rows.push({ id, nameSlug, cp });
  }

  let maxPage = 1;
  let seed: string | null = null;
  PAGINATION_RE.lastIndex = 0;
  for (const match of html.matchAll(PAGINATION_RE)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > maxPage) maxPage = n;
    if (!seed && match[2]) seed = match[2];
  }
  return { rows, maxPage, seed };
}

async function fetchPage(
  citySlug: string,
  page: number,
  dept: string,
  seed: string | null,
  cookie: string | null,
): Promise<{ html: string; setCookie: string | null } | null> {
  const path =
    page === 1
      ? `/recherche/ville/${citySlug}?departmentCode=${dept}`
      : `/recherche/ville/${citySlug}/${page}?departmentCode=${dept}${seed ? `&seed=${seed}` : ""}`;
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    console.error(
      `[oec-fr] ${citySlug} page=${page} network: ${(error as Error).message}`,
    );
    return null;
  }
  if (!response.ok) {
    console.error(`[oec-fr] ${citySlug} page=${page} ${response.status}`);
    return null;
  }
  const html = await response.text();
  // Apache sets a single CSRF cookie; preserve for subsequent calls
  const setCookieHeader = response.headers.get("set-cookie");
  let cookieOut: string | null = null;
  if (setCookieHeader) {
    const m = /(csoec_annuaire=[^;]+)/.exec(setCookieHeader);
    if (m) cookieOut = m[1];
  }
  return { html, setCookie: cookieOut };
}

function nameFromSlug(slug: string): string {
  // The annuaire slug includes the cabinet name + city — but the city
  // suffix is the URL slug we already know. Strip the last 1-2 dash
  // tokens that match the city slug.
  return toTitleCase(slug.replace(/-/g, " "));
}

async function fetchCity(
  city: CityTarget,
  remaining: number,
): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  let cookie: string | null = null;
  let seed: string | null = null;
  let totalPages = 1;

  for (let page = 1; page <= totalPages && page <= MAX_PAGES_PER_CITY; page++) {
    if (out.length >= remaining) break;
    const result = await fetchPage(city.urlSlug, page, city.dept, seed, cookie);
    if (!result) break;
    if (result.setCookie) cookie = result.setCookie;
    const parsed = parseListing(result.html);
    if (page === 1) {
      seed = parsed.seed;
      totalPages = Math.min(parsed.maxPage, MAX_PAGES_PER_CITY);
      console.log(
        `[oec-fr] ${city.urlSlug} totalPages=${parsed.maxPage} (capped at ${totalPages}) seed=${seed}`,
      );
    }
    if (parsed.rows.length === 0) {
      console.warn(`[oec-fr] ${city.urlSlug} page=${page} returned 0 rows`);
      break;
    }
    for (const row of parsed.rows) {
      if (out.length >= remaining) break;
      // Use the cabinet's actual postal code (from its own slug) to
      // bucket — covers commune-level matches that drilled into the
      // city page but live in a neighbouring postal area.
      const citySlug =
        frPostalCodeToCitySlug(row.cp) ?? city.prolioCitySlug;
      // Cabinet name slug = full slug minus trailing city tokens. The
      // annuaire's slug pattern is `{name-slug}-{city-slug}-{cp}`. We
      // can't reliably split name vs. city from the URL alone, so use
      // the entire name slug as the displayed name; it's already a
      // human-readable "Cabinet xyz Paris" form.
      const name = nameFromSlug(row.nameSlug);
      if (!name) continue;
      out.push(
        normalise({
          source: "oec-fr",
          sourceId: `oec-fr:${row.id}`,
          name,
          categoryKey: "fiscal",
          citySlug,
          licenseNumber: row.id,
          metadata: {
            country: "FR",
            authority: "Ordre des Experts-Comptables (OEC)",
            verified_by_authority: true,
            postal_code: row.cp,
            department: city.dept,
            url: `${BASE}/expert-comptable/${row.id}-${row.nameSlug}-${row.cp}`,
          },
        }),
      );
    }
    await delay(REQUEST_DELAY_MS);
  }
  return out;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (const city of TARGET_CITIES) {
    if (out.length >= limit) break;
    const remaining = limit - out.length;
    const records = await fetchCity(city, remaining);
    for (const rec of records) {
      if (out.length >= limit) break;
      if (seen.has(rec.sourceId)) continue;
      seen.add(rec.sourceId);
      out.push(rec);
    }
    console.log(
      `[oec-fr] city=${city.urlSlug} +${records.length} (total=${out.length})`,
    );
  }
  console.log(`[oec-fr] total parsed=${out.length}`);
  return out;
}

export const oecFrSource: ScraperSource = {
  name: "oec-fr",
  enabled() {
    return process.env.PROLIO_RUN_OEC_FR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOecFr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!oecFrSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_OEC_FR_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[oec-fr] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
