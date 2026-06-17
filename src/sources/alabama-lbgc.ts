import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * Alabama Licensing Board for General Contractors (LBGC).
 *
 * ASP.NET ViewState POST pagination. ~10,643 records at ~15 per page.
 * No robots.txt (404) — fully permitted.
 * `PROLIO_RUN_ALABAMA_LBGC=true` to enable.
 * Override limit via `PROLIO_ALABAMA_LBGC_LIMIT` (default 2000).
 */

const BASE_URL = "https://genconbd.alabama.gov/database-sql/roster.aspx";
const DEFAULT_LIMIT = 2000;
const DELAY_MS = 200;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function nameToCategory(name: string): CategoryKey {
  const u = name.toUpperCase();
  if (/PLUMB|DRAIN|SEWER|WATER|PIPE/.test(u)) return "fontaneria";
  if (/ELECTR|WIRING|SOLAR/.test(u)) return "electricidad";
  if (/HVAC|AIR CONDITION|HEAT|COOLING|REFRIGER|MECHANICAL/.test(u))
    return "hvac";
  if (/CARPENT|CABINET|LUMBER|MILLWORK|WOOD FLOOR/.test(u))
    return "carpinteria";
  return "carpinteria";
}

function extractHiddenField(html: string, name: string): string {
  const m = html.match(
    new RegExp(`name="${name}"[^>]*value="([^"]*)"`, "i"),
  );
  return m ? m[1] : "";
}

interface ListingRow {
  licenseNumber: string;
  name: string;
  city: string;
  state: string;
}

function parseRows(html: string): ListingRow[] {
  const rows: ListingRow[] = [];
  // Match all <tr> elements inside the GridView table (skip header)
  const tableMatch = html.match(
    /<table[^>]*GridView[^>]*>([\s\S]*?)<\/table>/i,
  );
  if (!tableMatch) return rows;

  const trPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;
  let isFirst = true;

  while ((trMatch = trPattern.exec(tableMatch[1])) !== null) {
    if (isFirst) {
      // Skip header row
      isFirst = false;
      continue;
    }
    const rowHtml = trMatch[1];
    const cells: string[] = [];
    const tdPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdPattern.exec(rowHtml)) !== null) {
      // Strip inner HTML tags to get text content
      const text = tdMatch[1].replace(/<[^>]+>/g, "").trim();
      cells.push(text);
    }
    if (cells.length < 4) continue;

    // Extract license number from link href if possible
    const hrefMatch = rowHtml.match(/licenseno=([^"&\s]+)/i);
    const licenseNumber = hrefMatch ? hrefMatch[1] : cells[0];

    if (!licenseNumber) continue;

    rows.push({
      licenseNumber,
      name: cells[1] ?? "",
      city: cells[2] ?? "",
      state: cells[3] ?? "AL",
    });
  }
  return rows;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  // Fetch first page
  let html: string;
  try {
    const res = await fetch(BASE_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.error(`[alabama-lbgc] HTTP ${res.status} on GET ${BASE_URL}`);
      return out;
    }
    html = await res.text();
  } catch (err) {
    console.error(
      `[alabama-lbgc] network error on first page: ${(err as Error).message}`,
    );
    return out;
  }

  // Parse first page records
  const firstPageRows = parseRows(html);
  for (const row of firstPageRows) {
    if (out.length >= limit) break;
    processRow(row, seen, out);
  }

  console.log(
    `[alabama-lbgc] page 1: ${firstPageRows.length} rows, running total=${out.length}`,
  );

  // Determine max pages from limit
  const recordsPerPage = 15;
  const maxPages = Math.ceil(limit / recordsPerPage);

  // Loop subsequent pages via POST
  for (let pageNum = 2; pageNum <= maxPages && out.length < limit; pageNum++) {
    await delay(DELAY_MS);

    // Re-extract ViewState fields from latest HTML
    const viewState = extractHiddenField(html, "__VIEWSTATE");
    const viewStateGen = extractHiddenField(html, "__VIEWSTATEGENERATOR");
    const eventValidation = extractHiddenField(html, "__EVENTVALIDATION");

    if (!viewState) {
      console.warn(`[alabama-lbgc] missing __VIEWSTATE on page ${pageNum - 1}, stopping`);
      break;
    }

    const body = new URLSearchParams({
      __VIEWSTATE: viewState,
      __VIEWSTATEGENERATOR: viewStateGen,
      __EVENTVALIDATION: eventValidation,
      __EVENTTARGET:
        "ctl00$ContentPlaceHolder1$GridView1",
      __EVENTARGUMENT: `Page$${pageNum}`,
    }).toString();

    try {
      const res = await fetch(BASE_URL, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: BASE_URL,
        },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        console.error(
          `[alabama-lbgc] HTTP ${res.status} on page ${pageNum}`,
        );
        break;
      }
      html = await res.text();
    } catch (err) {
      console.error(
        `[alabama-lbgc] network error on page ${pageNum}: ${(err as Error).message}`,
      );
      break;
    }

    const pageRows = parseRows(html);
    if (pageRows.length === 0) {
      console.log(`[alabama-lbgc] page ${pageNum}: no rows found, stopping`);
      break;
    }

    for (const row of pageRows) {
      if (out.length >= limit) break;
      processRow(row, seen, out);
    }

    console.log(
      `[alabama-lbgc] page ${pageNum}: ${pageRows.length} rows, running total=${out.length}`,
    );
  }

  console.log(`[alabama-lbgc] parsed=${out.length}`);
  return out;
}

function processRow(
  row: ListingRow,
  seen: Set<string>,
  out: ScrapedProfessional[],
): void {
  const { licenseNumber, name, city, state } = row;
  if (!licenseNumber || !name) return;
  const key = `alabama-lbgc:${licenseNumber}`;
  if (seen.has(key)) return;
  seen.add(key);

  const citySlug = slugify(city);
  if (!citySlug) return;

  const category = nameToCategory(name);

  out.push(
    normalise({
      source: "alabama-lbgc",
      country: "US",
      sourceId: key,
      name,
      categoryKey: category,
      citySlug,
      licenseNumber,
      metadata: {
        state: state || "AL",
        country: "US",
        authority: "Alabama LBGC",
        verified_by_authority: true,
      },
    }),
  );
}

export const alabamaLbgcSource: ScraperSource = {
  name: "alabama-lbgc",
  enabled() {
    return process.env.PROLIO_RUN_ALABAMA_LBGC === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runAlabamaLbgc(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!alabamaLbgcSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_ALABAMA_LBGC_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[alabama-lbgc] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
