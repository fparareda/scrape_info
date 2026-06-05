import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay } from "./_bulk-utils.js";

/**
 * College of Pharmacists of British Columbia — public licensee register.
 *
 * The College maintains a server-rendered Drupal HTML roster of all
 * registrants at bcpharmacists.org/list-pharmacists. Pages are indexed
 * via ?page=N (0-based). No auth, no CAPTCHA, no Cloudflare.
 *
 * Pre-flight (2026-06-05):
 *   URL: https://www.bcpharmacists.org/list-pharmacists
 *   robots.txt: Crawl-delay: 10. /list-pharmacists is NOT in any Disallow.
 *   Only disallowed: /wp-content/ and /admin/. Confirmed live.
 *   Total pages: ~255 at 30 rows/page → ~7,650 registrants total.
 *   Active categories kept: "Full Pharmacist" / "Pharmacist" (~7.4k).
 *
 * Limitations:
 *   - Public roster exposes: Surname, Legal First Name, Category only.
 *   - No registration number, address, or city data.
 *   - sourceId derived from name slug — change of name = new row.
 *   - citySlug = "" (province-level BC); downstream enrichment can resolve
 *     address/city once available via access-to-information request.
 *
 * Maps to `farmacia` — only CA province-specific pharmacy roster added so far
 * (OCP Ontario is gated by Akamai BMP). Off by default; enable via
 * PROLIO_RUN_BCPHARMACISTS_BC=true. Monthly cadence (6th of month).
 */

const BASE_URL = "https://www.bcpharmacists.org";
const LIST_URL = `${BASE_URL}/list-pharmacists`;
const CRAWL_DELAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_LIMIT = 10_000;
const MAX_PAGES = 300;
const INCLUDE_CATEGORIES = new Set(["full pharmacist", "pharmacist"]);
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

async function fetchPage(page: number): Promise<string | null> {
  const url = page === 0 ? LIST_URL : `${LIST_URL}?page=${page}`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[bcpharmacists-bc] HTTP ${response.status} on page ${page}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    console.error(
      `[bcpharmacists-bc] fetch error (page ${page}): ${(error as Error).message}`,
    );
    return null;
  }
}

interface PharmacistRow {
  surname: string;
  legalFirstName: string;
  category: string;
}

function parseTableRows(html: string): PharmacistRow[] {
  const rows: PharmacistRow[] = [];
  // Match <tr> blocks containing <td> cells in the registrant table.
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const cells: string[] = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
      cells.push(tdMatch[1].replace(/<[^>]+>/g, "").trim());
    }
    if (cells.length < 3) continue;
    rows.push({
      surname: cells[0] ?? "",
      legalFirstName: cells[1] ?? "",
      category: cells[2] ?? "",
    });
  }
  return rows;
}

function buildDisplayName(surname: string, legalFirstName: string): string {
  // Some rows have a literal "." as the Surname column, indicating the full
  // name is in Legal First Name (e.g. "Pharmacy Corp Name").
  if (surname === "." || surname === "") {
    return legalFirstName.trim();
  }
  const s = surname.trim();
  const f = legalFirstName.trim();
  if (!f) return s;
  return `${f} ${s}`;
}

function toNameSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const bcpharmacistsBcSource: ScraperSource = {
  name: "bcpharmacists-bc" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_BCPHARMACISTS_BC === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runBcpharmacistsBc(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!bcpharmacistsBcSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_BCPHARMACISTS_BC_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedCategory = 0;
  let droppedNoName = 0;
  let emptyPages = 0;

  for (let page = 0; page < MAX_PAGES && records.length < cap; page++) {
    if (page > 0) await delay(CRAWL_DELAY_MS);

    const html = await fetchPage(page);
    if (!html) {
      console.warn(`[bcpharmacists-bc] null response on page ${page} — stopping`);
      break;
    }

    const rows = parseTableRows(html);
    if (rows.length === 0) {
      emptyPages += 1;
      if (emptyPages >= 2) {
        console.log(`[bcpharmacists-bc] 2 consecutive empty pages — done at page ${page}`);
        break;
      }
      continue;
    }
    emptyPages = 0;

    for (const row of rows) {
      if (records.length >= cap) break;

      const category = row.category.toLowerCase().trim();
      if (!INCLUDE_CATEGORIES.has(category)) {
        droppedCategory += 1;
        continue;
      }

      const displayName = buildDisplayName(row.surname, row.legalFirstName);
      if (!displayName) {
        droppedNoName += 1;
        continue;
      }

      const sourceId = `bcpharmacists-bc:${toNameSlug(displayName)}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      records.push(
        normalise({
          source: "bcpharmacists-bc" as ScrapeSource,
          country: "CA",
          sourceId,
          name: displayName,
          categoryKey: "farmacia",
          citySlug: "",
          metadata: {
            country: "CA",
            province: "BC",
            province_slug: "BC",
            authority: "College of Pharmacists of BC",
            verified_by_authority: true,
            pharmacist_category: row.category.trim(),
          },
        }),
      );
    }

    if (page % 20 === 0) {
      console.log(`[bcpharmacists-bc] page=${page} accumulated=${records.length}`);
    }
  }

  console.log(
    `[bcpharmacists-bc] parsed=${records.length} ` +
      `droppedCategory=${droppedCategory} droppedNoName=${droppedNoName}`,
  );

  if (records.length === 0) {
    console.log("[bcpharmacists-bc] no records — HTML structure may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[bcpharmacists-bc] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
