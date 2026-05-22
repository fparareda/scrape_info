import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * Nebraska Board of Engineers and Architects — licensed engineers and
 * architects in Nebraska (nationwide-resident licensees included).
 *
 * Pre-flight (2026-05-22):
 *
 *   Nebraska robots.txt (nebraska.gov):
 *     Disallow: /demo/billtrack/
 *     Disallow: /app-fsp/
 *     Allow: /   (implicit for all other paths)
 *   The /ea/ path is fully unrestricted.
 *
 *   Auth/CAPTCHA/WAF: none. Public search at
 *     https://www.nebraska.gov/ea/search/search.php
 *   Server-rendered PHP/HTML, Bootstrap 3 UI.
 *
 *   Technology: Plain PHP; form POSTs to search.php with a PHP session
 *   cookie holding the query context. Subsequent pages use a GET param
 *   `page_num=N` (0-indexed offset, 20 rows per page) with the same
 *   session cookie.
 *
 *   Records: ~11 600 Active licensees total (9 651 engineers + 1 931
 *   architects, all addresses worldwide). Updated weekly. Data was last
 *   refreshed 2026-05-13 per page footer.
 *
 *   Categories mapped:
 *     profession_name=E (Engineer) → ingenieria
 *     profession_name=A (Architect) → arquitecto
 *
 *   Strategy: POST one search per profession type (Engineer / Architect)
 *   with license_status_name=Active. Paginate with GET page_num=N until
 *   the results table is empty. Parse 20-row HTML <table> per page.
 *   Map each record's City+State to a US city slug. Rows whose city
 *   cannot be resolved are counted and logged.
 *
 *   Records outside the US (State not in our city index) are skipped at
 *   city-mapping time; this is expected behaviour — non-US engineers
 *   licensed in NE still appear in the registry but won't map to a
 *   Prolio US city. Nebraska-resident active engineers alone total
 *   ~2 634; all-states gives ~9 651.
 *
 * Off by default. Set `PROLIO_RUN_NEBRASKA_EA=true` to enable.
 * Cap with `PROLIO_NEBRASKA_EA_LIMIT` (default 5 000).
 */

const BASE_URL = "https://www.nebraska.gov/ea/search/search.php";
const DEFAULT_LIMIT = 5_000;
const PAGE_SIZE = 20;
const REQUEST_TIMEOUT_MS = 30_000;
const POLITE_DELAY_MS = 800; // polite delay between paginated requests
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const CATEGORY_INGENIERIA: CategoryKey = "ingenieria";
const CATEGORY_ARQUITECTO: CategoryKey = "arquitecto";

// ---- helpers ---------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function professionToCategory(professionCode: "E" | "A"): CategoryKey {
  return professionCode === "A" ? CATEGORY_ARQUITECTO : CATEGORY_INGENIERIA;
}

// ---- city index ------------------------------------------------------------

interface CityIndex {
  /** lower-case "<city>,<state>" → city slug */
  byNameState: Map<string, string>;
  /** lower-case city name → city slug (fallback when state ambiguous) */
  byName: Map<string, string>;
}

let cityIndexCache: CityIndex | null = null;

async function loadCityIndex(): Promise<CityIndex> {
  if (cityIndexCache) return cityIndexCache;
  const cities = await getCities({ country: "US" });
  const byNameState = new Map<string, string>();
  const byName = new Map<string, string>();

  for (const city of cities) {
    const nameLower = city.name.toLowerCase();
    const slugLower = city.slug.toLowerCase();
    // We don't have state in the cities list, so we index by name only.
    // Additionally index by slug (some cities have a slug that differs from
    // the display name, e.g. "st-louis" vs "Saint Louis").
    byName.set(nameLower, city.slug);
    byName.set(slugLower, city.slug);
  }
  cityIndexCache = { byNameState, byName };
  return cityIndexCache;
}

function mapCity(
  idx: CityIndex,
  rawCity: string | undefined | null,
): string | undefined {
  if (!rawCity) return undefined;
  const key = rawCity.trim().toLowerCase();
  if (!key) return undefined;
  if (idx.byNameState.has(key)) return idx.byNameState.get(key);
  if (idx.byName.has(key)) return idx.byName.get(key);
  // Try slugified form (converts "OMAHA" → "omaha", "ST. LOUIS" → "st-louis")
  const slg = slugify(rawCity.trim());
  if (idx.byName.has(slg)) return idx.byName.get(slg);
  return undefined;
}

// ---- HTML table parser ----------------------------------------------------

interface LicenseeRow {
  /** Full name as displayed (e.g., "Abbott, Allan L") */
  name: string;
  /** License number (e.g., "E-10327") */
  licenseNumber: string;
  /** Type: "Engineer" | "Architect" | "Organization" | "Temporary Permit" */
  type: string;
  /** Discipline (e.g., "Civil Engineering") */
  discipline: string;
  /** License status (e.g., "Licensed", "Active", "Expired") */
  status: string;
  /** City from address */
  city: string;
  /** State abbreviation (e.g., "NE", "CA") */
  state: string;
}

/**
 * Parse the HTML results table from the Nebraska EA search page.
 * The table has columns: Name | Number | Type | Profession/Discipline | Status | City | State
 */
function parseResultsTable(html: string): LicenseeRow[] {
  const rows: LicenseeRow[] = [];
  // Find the tbody and extract tr elements
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return rows;

  const tbody = tbodyMatch[1];
  // Extract each row
  const rowRe = /<tr>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(tbody)) !== null) {
    const rowHtml = rowMatch[1];
    // Extract td values
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRe.exec(rowHtml)) !== null) {
      // Strip HTML tags, decode entities, trim whitespace
      const text = tdMatch[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      cells.push(text);
    }
    if (cells.length >= 7) {
      rows.push({
        name: cells[0] ?? "",
        licenseNumber: cells[1] ?? "",
        type: cells[2] ?? "",
        discipline: cells[3] ?? "",
        status: cells[4] ?? "",
        city: cells[5] ?? "",
        state: cells[6] ?? "",
      });
    }
  }
  return rows;
}

/**
 * Returns true if the HTML page indicates no more results
 * (no tbody, empty tbody, or "0 results found").
 */
function isEmptyResults(html: string): boolean {
  if (/0 results found/i.test(html)) return true;
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return true;
  return !/<tr>/i.test(tbodyMatch[1]);
}

// ---- HTTP fetchers --------------------------------------------------------

/**
 * POST an initial search to the Nebraska EA form and return the
 * PHP session cookie + HTML of the first results page.
 */
async function postInitialSearch(
  professionCode: "E" | "A",
): Promise<{ cookie: string; html: string } | null> {
  const body = new URLSearchParams({
    page: "search",
    profession_name: professionCode,
    license_type_name: "All",
    license_status_name: "Active",
    addr_state: "All",
    first_name: "",
    last_name: "",
    license_no: "",
    org: "",
    addr_city: "",
    addr_zipcode: "",
    addr_country: "",
    sch_button: "Search",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: body.toString(),
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(
        `[nebraska-ea] POST search profession=${professionCode} status=${response.status}`,
      );
      return null;
    }
    // Extract Set-Cookie header for session
    const setCookie = response.headers.get("set-cookie") ?? "";
    // Parse PHPSESSID from set-cookie header
    const sessMatch = setCookie.match(/PHPSESSID=([^;]+)/i);
    const cookie = sessMatch ? `PHPSESSID=${sessMatch[1]}` : "";
    const html = await response.text();
    return { cookie, html };
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[nebraska-ea] network error on POST: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * GET a paginated results page using an existing session cookie.
 * pageOffset is the 0-indexed row offset (0 = first page, 20 = second, etc.)
 */
async function getResultsPage(
  cookie: string,
  pageOffset: number,
): Promise<string | null> {
  const url = `${BASE_URL}?page=search&page_num=${pageOffset}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: cookie,
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(
        `[nebraska-ea] GET page offset=${pageOffset} status=${response.status}`,
      );
      return null;
    }
    return await response.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[nebraska-ea] network error on GET page offset=${pageOffset}: ${(err as Error).message}`,
    );
    return null;
  }
}

// ---- per-profession fetcher -----------------------------------------------

async function fetchProfession(
  professionCode: "E" | "A",
  cityIndex: CityIndex,
  limit: number,
): Promise<ScrapedProfessional[]> {
  const categoryKey = professionToCategory(professionCode);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCity = 0;
  let droppedNoLicence = 0;

  // Initial POST search
  const initial = await postInitialSearch(professionCode);
  if (!initial) {
    console.warn(`[nebraska-ea] initial POST failed for profession=${professionCode}`);
    return out;
  }
  const { cookie, html: firstHtml } = initial;

  if (isEmptyResults(firstHtml)) {
    console.log(`[nebraska-ea] no results for profession=${professionCode}`);
    return out;
  }

  // Parse first page
  const firstRows = parseResultsTable(firstHtml);
  for (const row of firstRows) {
    if (out.length >= limit) break;
    if (!row.licenseNumber) { droppedNoLicence++; continue; }
    const citySlug = mapCity(cityIndex, row.city);
    if (!citySlug) { droppedNoCity++; continue; }
    const sourceId = `nebraska-ea:${row.licenseNumber}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    out.push(normalise({
      source: "nebraska-ea",
      country: "US",
      sourceId,
      name: row.name,
      categoryKey,
      citySlug,
      licenseNumber: row.licenseNumber,
      metadata: {
        state: "NE",
        country: "US",
        verified_by_authority: true,
        authority: "Nebraska Board of Engineers and Architects",
        profession_type: row.type.trim(),
        discipline: row.discipline.trim(),
        license_status: row.status.trim(),
        licensee_state: row.state.trim(),
      },
    }));
  }

  if (out.length >= limit) {
    console.log(
      `[nebraska-ea] profession=${professionCode} hit limit=${limit} on page 1`,
    );
    return out;
  }

  // Paginate: page_num increments by PAGE_SIZE
  let pageOffset = PAGE_SIZE;
  let consecutiveEmpty = 0;
  const maxOffset = 60_000; // safety cap (~3000 pages)

  while (out.length < limit && pageOffset < maxOffset) {
    await delay(POLITE_DELAY_MS);
    const html = await getResultsPage(cookie, pageOffset);
    if (!html) {
      console.warn(
        `[nebraska-ea] fetch failed at offset=${pageOffset} — stopping pagination`,
      );
      break;
    }
    if (isEmptyResults(html)) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 2) break;
      pageOffset += PAGE_SIZE;
      continue;
    }
    consecutiveEmpty = 0;

    const rows = parseResultsTable(html);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (out.length >= limit) break;
      if (!row.licenseNumber) { droppedNoLicence++; continue; }
      const citySlug = mapCity(cityIndex, row.city);
      if (!citySlug) { droppedNoCity++; continue; }
      const sourceId = `nebraska-ea:${row.licenseNumber}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      out.push(normalise({
        source: "nebraska-ea",
        country: "US",
        sourceId,
        name: row.name,
        categoryKey,
        citySlug,
        licenseNumber: row.licenseNumber,
        metadata: {
          state: "NE",
          country: "US",
          verified_by_authority: true,
          authority: "Nebraska Board of Engineers and Architects",
          profession_type: row.type.trim(),
          discipline: row.discipline.trim(),
          license_status: row.status.trim(),
          licensee_state: row.state.trim(),
        },
      }));
    }
    pageOffset += PAGE_SIZE;
  }

  console.log(
    `[nebraska-ea] profession=${professionCode} parsed=${out.length} ` +
      `droppedNoCity=${droppedNoCity} droppedNoLicence=${droppedNoLicence}`,
  );
  return out;
}

// ---- public API -----------------------------------------------------------

export const nebraskaEaSource: ScraperSource = {
  name: "nebraska-ea",
  enabled() {
    return process.env.PROLIO_RUN_NEBRASKA_EA === "true";
  },
  async fetch() {
    return [];
  },
};

export function nebraskaEaEnabled(): boolean {
  return nebraskaEaSource.enabled();
}

/**
 * Bulk runner for the Nebraska Board of Engineers and Architects.
 * Iterates over Engineer and Architect profession codes, paginates the
 * server-rendered search results, and upserts via sink.
 *
 * Enable with `PROLIO_RUN_NEBRASKA_EA=true`.
 * Cap with `PROLIO_NEBRASKA_EA_LIMIT` (default 5 000).
 */
export async function runNebraskaEa(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!nebraskaEaSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = process.env.PROLIO_NEBRASKA_EA_LIMIT;
  const limit = rawLimit && Number.isFinite(Number(rawLimit)) && Number(rawLimit) > 0
    ? Number(rawLimit)
    : DEFAULT_LIMIT;

  const cityIndex = await loadCityIndex();
  const sink = getSink();

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const prof of ["E", "A"] as const) {
    const remaining = limit - totalFetched;
    if (remaining <= 0) break;

    const rows = await fetchProfession(prof, cityIndex, remaining);
    if (rows.length === 0) continue;

    totalFetched += rows.length;
    const { inserted, updated, skipped } = await sink.upsert(rows);
    totalInserted += inserted;
    totalUpdated += updated;
    totalSkipped += skipped;

    console.log(
      `[nebraska-ea] profession=${prof} upserted=${rows.length} ` +
        `inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
  }

  console.log(
    `[nebraska-ea] total fetched=${totalFetched} ` +
      `inserted=${totalInserted} updated=${totalUpdated} skipped=${totalSkipped}`,
  );
  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    skipped: totalSkipped,
  };
}
