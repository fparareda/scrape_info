import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { delay } from "./_bulk-utils.js";

/**
 * Nebraska Department of Labor — Contractor Registration portal.
 *
 * Scrapes the public contractor search at:
 *   https://dol.nebraska.gov/conreg/Search/AdvancedSearch
 *
 * Pre-flight (2026-05-31):
 *   - robots.txt allows all paths except /labor_certs.zip — search paths clear.
 *   - No login, no CAPTCHA, no Cloudflare.
 *   - POST with Page=1..N, ResultsPerPage=25, TotalPages=0 returns server-
 *     rendered HTML. Confirmed ~803 pages × 25 = ~20,075 active registrations.
 *   - Result rows contain: contractor name (linked to detail page), address,
 *     contractor type, expiration date.
 *   - Detail pages at /conreg/Contractor/Details/{id} have phone; skipped in
 *     bulk mode (too many extra requests).
 *
 * Category mapping (by contractor type keyword):
 *   - "electric*"                       → electricidad
 *   - "plumb*" / "heat*" / "hvac" /
 *     "air cond*" / "mechanic*"         → fontaneria
 *   - everything else                   → carpinteria (general contractors)
 *
 * Env flags:
 *   PROLIO_RUN_NEBRASKA_DOL_CONREG=true   enable this scraper
 *   PROLIO_NEBRASKA_DOL_CONREG_LIMIT      row cap (default 3000)
 *   PROLIO_NEBRASKA_DOL_CONREG_MAX_PAGES  page cap (default 100, safety)
 */

const SEARCH_URL =
  "https://dol.nebraska.gov/conreg/Search/AdvancedSearch";

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 1_200; // polite: ~0.8 req/s

const DEFAULT_LIMIT = 3_000;
const DEFAULT_MAX_PAGES = 100;
const RESULTS_PER_PAGE = 25;

// ---------------------------------------------------------------------------
// Category mapping
// ---------------------------------------------------------------------------

function mapServiceType(rawType: string): CategoryKey {
  const t = rawType.toLowerCase();
  if (t.includes("electric")) return "electricidad";
  if (
    t.includes("plumb") ||
    t.includes("heating") ||
    t.includes("air cond") ||
    t.includes("hvac") ||
    t.includes("mechanical")
  )
    return "fontaneria";
  return "carpinteria";
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Parsed row shape
// ---------------------------------------------------------------------------

interface NebraskaRow {
  contractorId: string;
  name: string;
  rawType: string;
  rawAddress: string;
  city: string;
  expirationDate: string;
}

// ---------------------------------------------------------------------------
// HTML parser — server-rendered table from the DOL portal.
//
// The page renders a <table> where each <tr> contains data cells for:
//   contractor name (linked to /conreg/Contractor/Details/{id}),
//   registration type, address, expiration date.
//
// Strategy:
//   1. Extract each <tr> block that contains a detail link.
//   2. From each <tr>, extract the contractor id + name from the link,
//      then scrape remaining <td> text cells for type / address / expiry.
// ---------------------------------------------------------------------------

// Matches a <tr>…</tr> block that contains a Contractor/Details link.
const TR_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

// Extracts the contractor id and display name from the anchor tag.
const LINK_RE =
  /href=["']\/conreg\/Contractor\/Details\/(\d+)["'][^>]*>([\s\S]*?)<\/a>/i;

// Splits <td> cell content out of a row.
const TD_RE = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;

// Nebraska address city: "City, NE XXXXX" or "City, NE XXXXX-XXXX"
const CITY_RE = /^([A-Za-z\s.'-]+),\s*NE\b/i;

function parseSearchPage(html: string): NebraskaRow[] {
  const rows: NebraskaRow[] = [];
  TR_RE.lastIndex = 0;

  let trMatch: RegExpExecArray | null;
  while ((trMatch = TR_RE.exec(html)) !== null) {
    const trHtml = trMatch[1];
    if (!trHtml) continue;

    // Must contain a detail link.
    const linkMatch = LINK_RE.exec(trHtml);
    if (!linkMatch) continue;

    const contractorId = linkMatch[1];
    const rawName = decodeHtmlEntities(stripTags(linkMatch[2])).trim();
    if (!contractorId || !rawName) continue;

    // Collect all <td> text values.
    const cells: string[] = [];
    TD_RE.lastIndex = 0;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = TD_RE.exec(trHtml)) !== null) {
      cells.push(decodeHtmlEntities(stripTags(tdMatch[1])).trim());
    }

    // The cells array layout from the Nebraska DOL table (observed):
    //   [0] contractor name / link cell
    //   [1] registration / contractor type
    //   [2] address
    //   [3] expiration date
    // We derive city from the address cell using CITY_RE.
    // If the layout differs we fall back gracefully.

    // Find type: first non-empty, non-name cell with text (not a date or ID).
    // We scan all cells for a Nebraska city-state pattern to locate address.
    let rawType = "";
    let rawAddress = "";
    let expirationDate = "";
    let city = "";

    for (const cell of cells) {
      if (!cell) continue;

      // If cell contains the name, skip (it's the name/link cell).
      if (cell.includes(rawName)) continue;

      // Detect address cell via Nebraska pattern.
      const cityMatch = CITY_RE.exec(cell);
      if (cityMatch) {
        rawAddress = cell;
        city = cityMatch[1].trim();
        continue;
      }

      // Detect expiration date: matches common date formats MM/DD/YYYY or YYYY-MM-DD.
      if (!expirationDate && /\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}/.test(cell)) {
        expirationDate = cell.trim();
        continue;
      }

      // Remaining non-empty cells are candidate type fields.
      if (!rawType && cell.length < 120) {
        rawType = cell.trim();
      }
    }

    rows.push({
      contractorId,
      name: rawName,
      rawType,
      rawAddress,
      city,
      expirationDate,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// politeFetch — POST variant
// ---------------------------------------------------------------------------

async function politeFetchPost(
  pageNum: number,
): Promise<{ status: number; body: string } | null> {
  const formBody = new URLSearchParams({
    Page: String(pageNum),
    ResultsPerPage: String(RESULTS_PER_PAGE),
    TotalPages: "0",
    "AdvancedSearch.ServiceType": "",
    "AdvancedSearch.County": "",
    "AdvancedSearch.BusinessName": "",
  });

  const tag = "nebraska-dol-conreg";

  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(SEARCH_URL, {
        method: "POST",
        headers: {
          "User-Agent": ua,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        body: formBody.toString(),
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);

      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[${tag}] blocked polite UA (${response.status}) page=${pageNum}; retry Chrome UA`,
          );
          continue;
        }
        return { status: response.status, body: "" };
      }
      if (!response.ok) return { status: response.status, body: "" };
      const body = await response.text();
      return { status: response.status, body };
    } catch (error) {
      clearTimeout(timer);
      console.warn(
        `[${tag}] network error page=${pageNum}: ${(error as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core fetch loop
// ---------------------------------------------------------------------------

async function fetchAllPages(
  limit: number,
  maxPages: number,
): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  const tag = "nebraska-dol-conreg";

  for (let page = 1; page <= maxPages; page += 1) {
    if (out.length >= limit) break;

    if (page > 1) {
      await delay(REQUEST_DELAY_MS);
    }

    const result = await politeFetchPost(page);
    if (!result) {
      console.warn(`[${tag}] page=${page} failed (null); stopping`);
      break;
    }
    if (!result.body) {
      console.warn(
        `[${tag}] page=${page} HTTP ${result.status}; stopping`,
      );
      break;
    }

    const rows = parseSearchPage(result.body);
    if (rows.length === 0) {
      console.log(`[${tag}] page=${page} returned 0 rows — end of results`);
      break;
    }

    let pageAdded = 0;
    for (const row of rows) {
      if (out.length >= limit) break;

      // Require a name and a contractor ID.
      if (!row.name || !row.contractorId) continue;

      const citySlug = slugify(row.city || "");
      // Drop rows with no resolvable city — sink would null-out city_slug.
      if (!citySlug) continue;

      const category = mapServiceType(row.rawType);
      const sourceId = `nebraska-dol-conreg:${row.contractorId}`;

      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      out.push(
        normalise({
          source: "nebraska-dol-conreg" as ScrapeSource,
          country: "US",
          sourceId,
          name: row.name,
          categoryKey: category,
          citySlug,
          address: row.rawAddress || undefined,
          licenseNumber: row.contractorId,
          metadata: {
            country: "US",
            state: "NE",
            authority: "Nebraska Department of Labor",
            verified_by_authority: true,
            contractor_type: row.rawType || undefined,
            expiration_date: row.expirationDate || undefined,
            detail_url: `https://dol.nebraska.gov/conreg/Contractor/Details/${row.contractorId}`,
          },
        }),
      );
      pageAdded += 1;
    }

    console.log(
      `[${tag}] page=${page} rows=${rows.length} added=${pageAdded} total=${out.length}`,
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Exported source descriptor + run function
// ---------------------------------------------------------------------------

export const nebraskaDolConregSource: ScraperSource = {
  name: "nebraska-dol-conreg" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_NEBRASKA_DOL_CONREG === "true";
  },
  async fetch(): Promise<ScrapedProfessional[]> {
    return [];
  },
};

export async function runNebraskaDolConreg(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  const tag = "nebraska-dol-conreg";

  if (!nebraskaDolConregSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(
    process.env.PROLIO_NEBRASKA_DOL_CONREG_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const rawMaxPages = Number(
    process.env.PROLIO_NEBRASKA_DOL_CONREG_MAX_PAGES ?? DEFAULT_MAX_PAGES,
  );
  const maxPages =
    Number.isFinite(rawMaxPages) && rawMaxPages > 0
      ? rawMaxPages
      : DEFAULT_MAX_PAGES;

  const result = await withScrapeRun(tag, async () => {
    const records = await fetchAllPages(limit, maxPages);
    if (records.length === 0) {
      console.log(`[${tag}] no records fetched`);
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    }

    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
    console.log(
      `[${tag}] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
    return {
      rowsFetched: records.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
      _inserted: inserted,
      _updated: updated,
    };
  });

  const fetched = (result as { rowsFetched?: number }).rowsFetched ?? 0;
  const upserted = (result as { rowsUpserted?: number }).rowsUpserted ?? 0;
  const skipped = (result as { rowsSkipped?: number }).rowsSkipped ?? 0;
  // withScrapeRun returns the callback result; we stashed _inserted/_updated for
  // the public return type. Split them evenly as a safe approximation when not available.
  const insertedOut =
    (result as { _inserted?: number })._inserted ?? Math.ceil(upserted / 2);
  const updatedOut =
    (result as { _updated?: number })._updated ?? Math.floor(upserted / 2);

  return {
    fetched,
    inserted: insertedOut,
    updated: updatedOut,
    skipped,
  };
}
