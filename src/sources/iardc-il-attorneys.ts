import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";
import { withScrapeRun } from "../telemetry.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * IARDC — Illinois Attorney Registration and Disciplinary Commission.
 *
 * Pre-flight (2026-06-04):
 *
 *   robots.txt at iardc.org only Disallows /files/pdf/, /files/sampledata/,
 *   /bin/, /content/, /fonts/, /scripts/, /file/. The /Lawyer/ path is
 *   explicitly permitted. No Cloudflare; server is Microsoft-IIS/10.0 /
 *   ASP.NET MVC.
 *
 *   Public search at https://www.iardc.org/Lawyer/Search — fully server-
 *   rendered HTML. Search requires a two-step POST flow:
 *     1. GET /Lawyer/Search → session cookie + CSRF token in HTML form
 *     2. POST /Lawyer/SearchResults (LastName + LastNameMatch=StartsWith
 *        + __RequestVerificationToken) → PageKey (GUID) + result count
 *     3. POST /Lawyer/SearchGrid (PageKey + page + __RequestVerificationToken)
 *        → HTML fragment with rows: GUID, name, city, state, admitted, status
 *
 *   Individual detail pages (no login required):
 *     https://www.iardc.org/Lawyer/PrintableDetails/{GUID}?includeFormerNames=False
 *   Expose: firm name, street address, city, state, ZIP, phone, email,
 *   admission date, registration status, malpractice insurance status.
 *
 *   Record count: ~97k total attorney roll (active + inactive).
 *   Session note: .NET MVC CSRF cookie persists for the browser session —
 *   one GET per letter to refresh the pairing is the safe approach.
 *
 *   Enumeration strategy: iterate A–Z last-name initial with
 *   LastNameMatch=StartsWith. Each letter ~1k–6k results; paginated at
 *   10 rows/page by default. Optional detail-page fetch for top N records
 *   (cap: PROLIO_IARDC_DETAILS_PER_RUN, default 500).
 *
 *   Category: `abogado`. Off by default; `PROLIO_RUN_IARDC_IL_ATTORNEYS=true`.
 *   Monthly cron (bar renewals are annual). Cap: PROLIO_IARDC_LIMIT (default
 *   10000 — full 97k sweep would need ~200 runs; cap covers 1–2 letters/run).
 */

const BASE = "https://www.iardc.org";
const SEARCH_URL = `${BASE}/Lawyer/Search`;
const SEARCH_RESULTS_URL = `${BASE}/Lawyer/SearchResults`;
const SEARCH_GRID_URL = `${BASE}/Lawyer/SearchGrid`;
const DETAIL_BASE = `${BASE}/Lawyer/PrintableDetails`;

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 1_200;
const DEFAULT_LIMIT = 10_000;
const DEFAULT_DETAILS_PER_RUN = 500;
const PAGE_SIZE = 10;
const MAX_PAGES_PER_LETTER = 1_000; // safety cap (~10k per letter max)

const CATEGORY: CategoryKey = "abogado";

// --- Cookie / session helpers ------------------------------------------

interface Session {
  cookieJar: Map<string, string>;
  csrfToken: string;
}

function mergeSetCookies(jar: Map<string, string>, setCookies: string[]): void {
  for (const raw of setCookies) {
    const segment = raw.split(";")[0]?.trim() ?? "";
    const eq = segment.indexOf("=");
    if (eq > 0) {
      jar.set(segment.slice(0, eq).trim(), segment.slice(eq + 1).trim());
    }
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function extractCsrfToken(html: string): string | null {
  const match = html.match(
    /<input[^>]+name="__RequestVerificationToken"[^>]+value="([^"]+)"/i,
  );
  return match ? (match[1] ?? null) : null;
}

// --- HTTP helpers -------------------------------------------------------

async function fetchHtml(
  url: string,
  init: RequestInit,
): Promise<{ body: string; status: number; setCookies: string[] } | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const headers = {
      ...(init.headers as Record<string, string>),
      "User-Agent": ua,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, headers, signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 403 || res.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(`[iardc] ${new URL(url).host} blocked polite UA (${res.status}); retrying`);
          continue;
        }
        return { body: "", status: res.status, setCookies: [] };
      }
      if (!res.ok) return { body: "", status: res.status, setCookies: [] };
      const body = await res.text();
      const setCookies = (res.headers as unknown as { getSetCookie?(): string[] })
        .getSetCookie?.() ?? [];
      return { body, status: res.status, setCookies };
    } catch (err) {
      clearTimeout(timer);
      console.warn(`[iardc] network error on ${url}: ${(err as Error).message}`);
      return null;
    }
  }
  return null;
}

// --- Session acquisition -----------------------------------------------

async function acquireSession(): Promise<Session | null> {
  const result = await fetchHtml(SEARCH_URL, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!result || !result.body) {
    console.warn("[iardc] failed to fetch search page");
    return null;
  }
  const jar = new Map<string, string>();
  mergeSetCookies(jar, result.setCookies);
  const csrf = extractCsrfToken(result.body);
  if (!csrf) {
    console.warn("[iardc] CSRF token not found in search page HTML");
    return null;
  }
  return { cookieJar: jar, csrfToken: csrf };
}

// --- SearchResults (one POST per letter) --------------------------------

interface SearchResultsData {
  pageKey: string;
  totalCount: number;
  csrfToken: string; // refreshed from response
}

function extractPageKey(html: string): string | null {
  // PageKey may appear as hidden input, JSON value, or JS variable.
  // Try all three common patterns.
  const fromInput = html.match(
    /<input[^>]+name="PageKey"[^>]+value="([0-9a-fA-F-]{36})"/i,
  );
  if (fromInput) return fromInput[1] ?? null;
  const fromJson = html.match(/"PageKey"\s*:\s*"([0-9a-fA-F-]{36})"/);
  if (fromJson) return fromJson[1] ?? null;
  const fromHidden = html.match(/pageKey\s*=\s*"([0-9a-fA-F-]{36})"/i);
  if (fromHidden) return fromHidden[1] ?? null;
  return null;
}

function extractTotalCount(html: string): number {
  // Look for patterns like "1392 results" or "data-total-results='1392'"
  const fromAttr = html.match(/data-total-results[='":\s]+(\d+)/i);
  if (fromAttr) return parseInt(fromAttr[1] ?? "0", 10);
  const fromText = html.match(/(\d[\d,]*)\s+(?:results?|attorneys?|records?)/i);
  if (fromText) return parseInt((fromText[1] ?? "0").replace(/,/g, ""), 10);
  return 0;
}

async function postSearchResults(
  letter: string,
  session: Session,
): Promise<SearchResultsData | null> {
  const body = new URLSearchParams({
    __RequestVerificationToken: session.csrfToken,
    LastName: letter,
    LastNameMatch: "StartsWith",
    FirstName: "",
    Status: "All",
    LawyerCounty: "",
    City: "",
    State: "IL",
    Country: "",
    IncludeFormerNames: "false",
    IsRecentSearch: "false",
  });

  const result = await fetchHtml(SEARCH_RESULTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: cookieHeader(session.cookieJar),
      Referer: SEARCH_URL,
    },
    body: body.toString(),
  });
  if (!result || !result.body) return null;
  mergeSetCookies(session.cookieJar, result.setCookies);

  const pageKey = extractPageKey(result.body);
  if (!pageKey) {
    console.warn(`[iardc] letter=${letter} pageKey not found`);
    return null;
  }
  const totalCount = extractTotalCount(result.body);
  const refreshedCsrf = extractCsrfToken(result.body) ?? session.csrfToken;
  session.csrfToken = refreshedCsrf;

  return { pageKey, totalCount, csrfToken: refreshedCsrf };
}

// --- SearchGrid (paginated rows) ----------------------------------------

interface GridRow {
  guid: string;
  rawName: string;
  city: string;
  state: string;
  admitted: string;
  status: string;
}

function parseGridRows(html: string): GridRow[] {
  const rows: GridRow[] = [];
  // Rows typically contain a link to the detail page with the GUID:
  //   href="/Lawyer/PrintableDetails/{GUID}"
  // and cells with name, city, state, admitted, status.
  const rowRe =
    /PrintableDetails\/([0-9a-fA-F-]{36})[^"]*"[^>]*>\s*([^<]+)<\/a>[\s\S]{0,500}?<\/tr>/gi;
  const cellRe = /<td[^>]*>\s*([^<]*?)\s*<\/td>/gi;

  let rowMatch: RegExpExecArray | null;
  rowRe.lastIndex = 0;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const guid = rowMatch[1];
    if (!guid) continue;
    // Extract remaining cells from this row's context
    const rowHtml = rowMatch[0];
    cellRe.lastIndex = 0;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push((cellMatch[1] ?? "").trim());
    }
    // Expected columns: [name-link-cell(skip), city, state, admitted, status]
    // but parseGridRows gets the full row content; pick last 4 cells.
    const len = cells.length;
    rows.push({
      guid,
      rawName: rowMatch[2] ?? "",
      city: len >= 4 ? (cells[len - 4] ?? "") : "",
      state: len >= 3 ? (cells[len - 3] ?? "") : "IL",
      admitted: len >= 2 ? (cells[len - 2] ?? "") : "",
      status: len >= 1 ? (cells[len - 1] ?? "") : "",
    });
  }
  return rows;
}

async function postSearchGrid(
  pageKey: string,
  page: number,
  session: Session,
): Promise<{ rows: GridRow[]; hasMore: boolean } | null> {
  const body = new URLSearchParams({
    __RequestVerificationToken: session.csrfToken,
    PageKey: pageKey,
    page: String(page),
    pageSize: String(PAGE_SIZE),
    sortColumn: "",
    sortDirection: "",
  });

  const result = await fetchHtml(SEARCH_GRID_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: cookieHeader(session.cookieJar),
      Referer: SEARCH_RESULTS_URL,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
  });
  if (!result || !result.body) return null;
  mergeSetCookies(session.cookieJar, result.setCookies);

  const rows = parseGridRows(result.body);
  // If response has fewer rows than PAGE_SIZE, we're on the last page.
  const hasMore = rows.length >= PAGE_SIZE;
  return { rows, hasMore };
}

// --- Detail page (optional, enriches with address/phone/email) ----------

interface DetailData {
  firm?: string;
  address?: string;
  phone?: string;
  email?: string;
}

function parseDetailPage(html: string): DetailData {
  // Detail page is a plain HTML printable layout with labeled fields.
  const out: DetailData = {};

  const firmMatch = html.match(/(?:Firm|Employer|Business Name)[^:]*:\s*<\/[^>]+>\s*([^<\n]+)/i);
  if (firmMatch) out.firm = firmMatch[1]?.trim();

  const addrMatch = html.match(
    /(?:Registered\s+)?Address[^:]*:\s*<\/[^>]+>([\s\S]{0,300}?)(?=<\/(?:div|p|td))/i,
  );
  if (addrMatch) {
    out.address = addrMatch[1]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const phoneMatch = html.match(/(?:Phone|Telephone)[^:]*:\s*<\/[^>]+>\s*([+\d()\s.-]{7,20})/i);
  if (phoneMatch) out.phone = phoneMatch[1]?.trim();

  const emailMatch = html.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch && !/iardc\.org/i.test(emailMatch[1] ?? "")) {
    out.email = emailMatch[1]?.toLowerCase();
  }

  return out;
}

async function fetchDetailPage(guid: string): Promise<DetailData> {
  const url = `${DETAIL_BASE}/${guid}?includeFormerNames=False`;
  const result = await fetchHtml(url, {
    method: "GET",
    headers: {
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!result || !result.body) return {};
  return parseDetailPage(result.body);
}

// --- City slug loader (US / IL) ----------------------------------------

let ilCitySlugsCache: Set<string> | null = null;

async function loadIlCitySlugs(): Promise<Set<string>> {
  if (ilCitySlugsCache) return ilCitySlugsCache;
  const cities = await getCities({ country: "US" });
  const set = new Set<string>();
  for (const c of cities) set.add(c.slug.toLowerCase());
  ilCitySlugsCache = set;
  return set;
}

function mapCitySlug(slugs: Set<string>, rawCity: string, rawState: string): string | undefined {
  if (!rawCity) return undefined;
  const slug = rawCity.trim().toLowerCase().replace(/\s+/g, "-");
  if (slugs.has(slug)) return slug;
  // City not seeded — drop if state is not IL (out-of-state lawyers).
  if (rawState && rawState.trim().toUpperCase() !== "IL") return undefined;
  return undefined;
}

// --- Public entrypoint -------------------------------------------------

export const iardcIlAttorneysSource: ScraperSource = {
  name: "iardc-il-attorneys" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_IARDC_IL_ATTORNEYS === "true";
  },
  async fetch() {
    return [];
  },
};

export function iardcIlAttorneysEnabled(): boolean {
  return iardcIlAttorneysSource.enabled();
}

export async function runIardcIlAttorneys(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
} | null> {
  if (!iardcIlAttorneysSource.enabled()) return null;

  const limit = Number(
    process.env.PROLIO_IARDC_LIMIT ?? String(DEFAULT_LIMIT),
  );
  const effectiveLimit =
    Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const detailsCap = Number(
    process.env.PROLIO_IARDC_DETAILS_PER_RUN ?? String(DEFAULT_DETAILS_PER_RUN),
  );
  const effectiveDetails =
    Number.isFinite(detailsCap) && detailsCap >= 0 ? detailsCap : DEFAULT_DETAILS_PER_RUN;

  const citySlugs = await loadIlCitySlugs();
  const sink = getSink();
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let detailsFetched = 0;
  const seenGuids = new Set<string>();

  for (const letter of letters) {
    if (totalFetched >= effectiveLimit) break;

    // Fresh session per letter to avoid CSRF expiry.
    await delay(REQUEST_DELAY_MS);
    const session = await acquireSession();
    if (!session) {
      console.warn(`[iardc] letter=${letter} — could not acquire session, skipping`);
      continue;
    }
    await delay(REQUEST_DELAY_MS);

    const srData = await postSearchResults(letter.toUpperCase(), session);
    if (!srData) {
      console.warn(`[iardc] letter=${letter} — SearchResults failed, skipping`);
      continue;
    }

    const totalPages = Math.ceil(srData.totalCount / PAGE_SIZE);
    console.log(
      `[iardc] letter=${letter.toUpperCase()} total=${srData.totalCount} pages=${totalPages}`,
    );

    const rowsForLetter: GridRow[] = [];

    for (let page = 1; page <= Math.min(totalPages, MAX_PAGES_PER_LETTER); page += 1) {
      if (totalFetched + rowsForLetter.length >= effectiveLimit) break;
      await delay(REQUEST_DELAY_MS);
      const grid = await postSearchGrid(srData.pageKey, page, session);
      if (!grid) {
        console.warn(`[iardc] letter=${letter} page=${page} grid fetch failed`);
        break;
      }
      for (const row of grid.rows) {
        if (!seenGuids.has(row.guid)) {
          seenGuids.add(row.guid);
          rowsForLetter.push(row);
        }
      }
      if (!grid.hasMore) break;
    }

    // Build ScrapedProfessional records.
    const records: ScrapedProfessional[] = [];
    for (const row of rowsForLetter) {
      if (totalFetched >= effectiveLimit) break;

      const citySlug = mapCitySlug(citySlugs, row.city, row.state);
      if (!citySlug) continue;

      let detail: DetailData = {};
      if (detailsFetched < effectiveDetails) {
        await delay(REQUEST_DELAY_MS);
        detail = await fetchDetailPage(row.guid);
        detailsFetched += 1;
      }

      records.push(
        normalise({
          source: "iardc-il-attorneys",
          country: "US",
          sourceId: `iardc:${row.guid}`,
          name: toTitleCase(row.rawName),
          categoryKey: CATEGORY,
          citySlug,
          address: detail.address,
          phone: detail.phone,
          email: detail.email,
          licenseNumber: row.guid, // ARDC uses GUID as public identifier
          metadata: {
            country: "US",
            state: "IL",
            authority: "IARDC",
            verified_by_authority: true,
            admission_date: row.admitted || undefined,
            registration_status: row.status || undefined,
            firm: detail.firm || undefined,
          },
        }),
      );
      totalFetched += 1;
    }

    if (records.length > 0) {
      const { inserted, updated, skipped } = await sink.upsert(records);
      totalInserted += inserted;
      totalUpdated += updated;
      totalSkipped += skipped;
      console.log(
        `[iardc] letter=${letter.toUpperCase()} fetched=${rowsForLetter.length} ` +
          `upserted=${records.length} inserted=${inserted} updated=${updated}`,
      );
    }
  }

  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    skipped: totalSkipped,
  };
}

export async function runIardcIlAttorneysScrapeRun(): Promise<void> {
  await withScrapeRun("iardc-il-attorneys", async () => {
    const res = await runIardcIlAttorneys();
    if (!res) return {};
    return {
      rowsFetched: res.fetched,
      rowsUpserted: res.inserted + res.updated,
      rowsSkipped: res.skipped,
    };
  }).catch((e) =>
    console.error("[iardc] crashed:", (e as Error).message),
  );
}
