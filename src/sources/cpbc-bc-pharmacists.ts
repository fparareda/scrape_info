import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * CPBC — College of Pharmacists of British Columbia.
 *
 * Public register at https://www.bcpharmacists.org/pharmacists/target
 * lists all registered BC pharmacists (full + limited registrants).
 * The site runs on Drupal 7; the paginated pharmacist list is exposed
 * via a plain GET endpoint that returns Drupal AJAX JSON — no auth,
 * no CAPTCHA, no session token required.
 *
 * Robots.txt (verified 2026-05-21) only disallows /search/, /admin/,
 * /node/add/, and standard Drupal system paths.  The pharmacist
 * directory at /pharmacists/target is NOT disallowed.
 *
 * Endpoint:  https://www.bcpharmacists.org/pharmacists/target?page=N
 * Response:  JSON array of Drupal command objects.
 *            Find: command === "insert", selector === "#search-table".
 *            The `data` field contains the rendered HTML fragment with
 *            a <table> whose <tbody> rows are:
 *              col 0 — Last Name (displayed as "." in listing)
 *              col 1 — Informal Name
 *              col 2 — Legal Name (use as primary name)
 *              col 3 — Category  (Full Pharmacist / Pharmacist Limited Registration / …)
 *              col 4 — Authorized for Injections (Yes/No)
 *              col 5 — Limit/Conditions (Yes/No)
 *
 * Universe: ~8,150 active registrants across pages 0–814 (10 per page).
 *
 * No city/address data is exposed in the listing; the scraper defaults
 * citySlug to "vancouver" (largest BC city) so every row satisfies the
 * prolio citySlug contract.  The full address lives on per-pharmacist
 * detail pages which require a separate session — not worth the cost.
 *
 * Category: farmacia. Province: BC. Country: CA.
 * Off by default — `PROLIO_RUN_CPBC_BC_PHARMACISTS=true`.
 * Cap: `PROLIO_CPBC_BC_PHARMACISTS_LIMIT` (default 10_000).
 */

const BASE_URL =
  process.env.PROLIO_CPBC_BC_BASE_URL ||
  "https://www.bcpharmacists.org/pharmacists/target";

const DEFAULT_LIMIT = 10_000;
const ROWS_PER_PAGE = 10;
const REQUEST_DELAY_MS = 2_000; // polite 2 s between pages

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// Drupal AJAX command shape (only the fields we use).
interface DrupalCommand {
  command: string;
  selector?: string;
  data?: string;
  [key: string]: unknown;
}

/**
 * Fetch one page of the CPBC pharmacist listing.
 * Returns the HTML fragment inserted into #search-table, or null on failure.
 */
async function fetchPageHtml(page: number): Promise<string | null> {
  const url = `${BASE_URL}?page=${page}`;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.warn(`[cpbc-bc-pharmacists] page ${page}: HTTP ${response.status}`);
      return null;
    }
    const commands = (await response.json()) as DrupalCommand[];
    if (!Array.isArray(commands)) return null;
    const insert = commands.find(
      (c) => c.command === "insert" && c.selector === "#search-table",
    );
    return insert?.data ?? null;
  } catch (err) {
    console.warn(
      `[cpbc-bc-pharmacists] page ${page} fetch error: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Extract last visible page number from the Drupal pager HTML.
 * Returns 0 (= single page, no pager) if no pager is found.
 */
function parseLastPage(html: string): number {
  // Drupal pager links: href="?page=N" — find the largest N.
  let max = 0;
  for (const m of html.matchAll(/\?page=(\d+)/g)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

/**
 * Parse table rows from the Drupal-rendered HTML fragment.
 * Returns an array of name strings (legal name, col 2).
 */
function parseRows(
  html: string,
): Array<{ legalName: string; category: string }> {
  const results: Array<{ legalName: string; category: string }> = [];
  // Match <tr class="odd"> or <tr class="even"> table rows.
  const rowRe = /<tr\s+class="(?:odd|even)"[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const rowMatch of html.matchAll(rowRe)) {
    const rowHtml = rowMatch[1];
    // Extract all <td> cell texts.
    const cells: string[] = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    for (const cellMatch of rowHtml.matchAll(cellRe)) {
      // Strip inner HTML tags and decode basic entities.
      const text = cellMatch[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&#039;/g, "'")
        .replace(/&quot;/g, '"')
        .trim();
      cells.push(text);
    }
    // col 2 = Legal Name, col 3 = Category
    const legalName = cells[2] ?? "";
    const category = cells[3] ?? "";
    if (legalName && legalName !== ".") {
      results.push({ legalName, category });
    }
  }
  return results;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];

  // Fetch page 0 first to discover the total number of pages.
  const firstHtml = await fetchPageHtml(0);
  if (!firstHtml) {
    console.error("[cpbc-bc-pharmacists] failed to fetch first page");
    return out;
  }

  const lastPage = parseLastPage(firstHtml);
  console.log(`[cpbc-bc-pharmacists] pages 0–${lastPage} (~${(lastPage + 1) * ROWS_PER_PAGE} rows)`);

  // Process page 0.
  for (const { legalName, category } of parseRows(firstHtml)) {
    if (out.length >= limit) break;
    const name = toTitleCase(legalName);
    const sourceId = `cpbc-bc:${legalName.toLowerCase().replace(/\s+/g, "-")}`;
    out.push(
      normalise({
        source: "cpbc-bc-pharmacists",
        country: "CA",
        sourceId,
        name,
        categoryKey: "farmacia",
        // No per-pharmacist city in the public listing.
        // Default to Vancouver (largest BC city) per prolio contract.
        citySlug: "vancouver",
        metadata: {
          country: "CA",
          province: "BC",
          authority: "CPBC — College of Pharmacists of British Columbia",
          register: "pharmacist",
          registrant_category: category || undefined,
          verified_by_authority: true,
        },
      }),
    );
  }

  // Iterate remaining pages.
  for (let page = 1; page <= lastPage && out.length < limit; page++) {
    await delay(REQUEST_DELAY_MS);
    const html = await fetchPageHtml(page);
    if (!html) continue;

    for (const { legalName, category } of parseRows(html)) {
      if (out.length >= limit) break;
      const name = toTitleCase(legalName);
      const sourceId = `cpbc-bc:${legalName.toLowerCase().replace(/\s+/g, "-")}`;
      out.push(
        normalise({
          source: "cpbc-bc-pharmacists",
          country: "CA",
          sourceId,
          name,
          categoryKey: "farmacia",
          citySlug: "vancouver",
          metadata: {
            country: "CA",
            province: "BC",
            authority: "CPBC — College of Pharmacists of British Columbia",
            register: "pharmacist",
            registrant_category: category || undefined,
            verified_by_authority: true,
          },
        }),
      );
    }

    if (page % 50 === 0) {
      console.log(
        `[cpbc-bc-pharmacists] page ${page}/${lastPage} — ${out.length} rows so far`,
      );
    }
  }

  return out;
}

export const cpbcBcPharmacistsSource: ScraperSource = {
  name: "cpbc-bc-pharmacists",
  enabled() {
    return process.env.PROLIO_RUN_CPBC_BC_PHARMACISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCpbcBcPharmacists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cpbcBcPharmacistsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_CPBC_BC_PHARMACISTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0) {
    console.warn("[cpbc-bc-pharmacists] fetched 0 records");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[cpbc-bc-pharmacists] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
