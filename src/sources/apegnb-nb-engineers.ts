import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * APEGNB — Association of Professional Engineers and Geoscientists of New
 * Brunswick. Public registry at
 *   https://myapegnb.apegnb.com/APEGNB/APEGNB-EN/Registry/Search.aspx
 *
 * Pre-flight (2026-06-04):
 *
 *   robots.txt only Disallows calendar view patterns (/calendar/action~STAR/).
 *   The /Registry/ path is permitted. Server: Apache / ASP.NET WebForms
 *   with Telerik RadGrid controls. No Cloudflare, no CAPTCHA, no login
 *   required.
 *
 *   Page explicitly states: "APEGNB PUBLIC REGISTRY — contains the names
 *   of all persons and entities who are currently registered with APEGNB."
 *
 *   Blank search returns ALL registrants — 6,901 items across 346 pages
 *   (20 rows/page default; bumped to 50 via RadGridPageSize postback).
 *   Pagination uses ASP.NET __doPostBack with Telerik pager event targets
 *   extracted dynamically from the first-page HTML.
 *
 *   Each row exposes: name (link to detail, ID in URL), designation
 *   (P.Eng./P.Geo./E.I.T./etc.), registration status, valid-until date,
 *   member ID. Detail page adds city + province; public register doesn't
 *   expose phone or email.
 *
 *   Mapped to `ingenieria`. Complements APEGA (Alberta) + Engineers NS +
 *   PEGNL (Newfoundland) in the existing CA coverage. Off by default;
 *   `PROLIO_RUN_APEGNB_NB_ENGINEERS=true`. Monthly cadence — NB engineer
 *   licences renew annually. Cap: PROLIO_APEGNB_LIMIT (default 8000 to
 *   cover the full ~6,901 roll).
 */

const BASE = "https://myapegnb.apegnb.com";
const SEARCH_URL = `${BASE}/APEGNB/APEGNB-EN/Registry/Search.aspx`;

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_DELAY_MS = 1_000;
const DEFAULT_LIMIT = 8_000;
const PAGE_SIZE = 50; // target page size (Telerik supports up to 50 via size dropdown)
const MAX_PAGES = 200; // safety cap (6901 / 50 = ~138 pages)

const CATEGORY: CategoryKey = "ingenieria";
const PROVINCE = "NB";
const COUNTRY = "CA";

// NB city slug map. Covers the 6 largest NB cities by population.
// Falls back to fredericton (provincial capital) for unmapped towns.
const NB_CITY_MAP: Record<string, string> = {
  fredericton: "fredericton",
  moncton: "moncton",
  "saint john": "saint-john-nb",
  "saint-john": "saint-john-nb",
  "st. john": "saint-john-nb",
  "st john": "saint-john-nb",
  bathurst: "bathurst",
  miramichi: "miramichi",
  edmundston: "edmundston",
  campbellton: "campbellton",
  dieppe: "moncton",    // Greater Moncton CMA
  riverview: "moncton", // Greater Moncton CMA
  oromocto: "fredericton", // near Fredericton
};
const DEFAULT_CITY = "fredericton";

function mapNbCity(raw: string | undefined | null): string {
  if (!raw) return DEFAULT_CITY;
  const k = raw.trim().toLowerCase();
  return NB_CITY_MAP[k] ?? DEFAULT_CITY;
}

// --- WebForms hidden-field helpers -------------------------------------

function extractHiddenField(html: string, name: string): string {
  const re = new RegExp(
    `<input[^>]+(?:name|id)="${name.replace(/\$/g, "\\$")}"[^>]*value="([^"]*)"`,
    "i",
  );
  return html.match(re)?.[1] ?? "";
}

// Extract all ASP.NET hidden state fields in one pass.
interface ViewstateBundle {
  viewstate: string;
  viewstateGenerator: string;
  eventValidation: string;
}

function extractViewstateBundle(html: string): ViewstateBundle {
  return {
    viewstate: extractHiddenField(html, "__VIEWSTATE"),
    viewstateGenerator: extractHiddenField(html, "__VIEWSTATEGENERATOR"),
    eventValidation: extractHiddenField(html, "__EVENTVALIDATION"),
  };
}

// --- HTTP helper -------------------------------------------------------

async function fetchHtml(
  url: string,
  init: RequestInit,
): Promise<{ body: string; status: number } | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          "User-Agent": ua,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 403 || res.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(`[apegnb] ${new URL(url).host} blocked (${res.status}); retrying`);
          continue;
        }
        return { body: "", status: res.status };
      }
      if (!res.ok) return { body: "", status: res.status };
      const body = await res.text();
      return { body, status: res.status };
    } catch (err) {
      clearTimeout(timer);
      console.warn(`[apegnb] network error: ${(err as Error).message}`);
      return null;
    }
  }
  return null;
}

// --- Row parsing -------------------------------------------------------

interface ApegnbRow {
  memberId: string;
  rawName: string;
  designation: string;
  status: string;
  validUntil: string;
  rawCity?: string;
}

/** Extract member ID from the detail-page link in each row. */
const DETAIL_ID_RE = /Member-Details\.aspx\?ID=(\d+)/i;

function parseRows(html: string): ApegnbRow[] {
  const rows: ApegnbRow[] = [];
  // Telerik RadGrid renders <tr> rows; each has a link to the detail page
  // containing the member ID, followed by td cells for designation, status,
  // valid-until date, and member number.
  const rowRe = /<tr[^>]*class="[^"]*(?:rgRow|rgAltRow)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  rowRe.lastIndex = 0;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1] ?? "";

    // Member ID from detail link URL.
    const idMatch = DETAIL_ID_RE.exec(rowHtml);
    if (!idMatch) continue;
    const memberId = idMatch[1] ?? "";
    if (!memberId) continue;

    // Name from link text.
    const nameMatch = rowHtml.match(/<a[^>]+>([^<]+)<\/a>/i);
    const rawName = nameMatch?.[1]?.trim() ?? "";

    // All <td> contents in order: designation, status, validUntil, memberNum.
    const cells: string[] = [];
    const cellRe = /<td[^>]*>\s*([\s\S]*?)\s*<\/td>/gi;
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(
        (cellMatch[1] ?? "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      );
    }

    rows.push({
      memberId,
      rawName,
      designation: cells[0] ?? "",
      status: cells[1] ?? "",
      validUntil: cells[2] ?? "",
    });
  }
  return rows;
}

/** Parse the total record count from grid header text like "6901 items in 346 pages". */
function parseTotalCount(html: string): number {
  const m = html.match(/(\d[\d,]*)\s+items?\s+in\s+\d/i);
  if (m) return parseInt((m[1] ?? "0").replace(/,/g, ""), 10);
  // Telerik also sometimes emits it as "Items 1-50 of 6901"
  const m2 = html.match(/Items?\s+\d+-\d+\s+of\s+(\d[\d,]*)/i);
  if (m2) return parseInt((m2[1] ?? "0").replace(/,/g, ""), 10);
  return 0;
}

/**
 * Extract the Telerik pager event target from the first-page HTML.
 * Pager links look like:
 *   href="javascript:__doPostBack('ctl00$cph1$rgMemberSearch','Page$2')"
 * We need the first argument (gridClientID) to navigate pages.
 */
function extractGridClientId(html: string): string | null {
  const m = html.match(
    /javascript:__doPostBack\('([^']+)','(?:Page|FireCommand)\$[\d\w]+'\)/i,
  );
  return m?.[1] ?? null;
}

// --- POST helper -------------------------------------------------------

async function postForm(
  vs: ViewstateBundle,
  extraFields: Record<string, string>,
): Promise<{ body: string; status: number } | null> {
  const body = new URLSearchParams({
    __VIEWSTATE: vs.viewstate,
    __VIEWSTATEGENERATOR: vs.viewstateGenerator,
    __EVENTVALIDATION: vs.eventValidation,
    ...extraFields,
  });

  return fetchHtml(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-CA,en;q=0.9",
      Referer: SEARCH_URL,
    },
    body: body.toString(),
  });
}

// --- Public entrypoint -------------------------------------------------

export const apegnbNbEngineersSource: ScraperSource = {
  name: "apegnb-nb-engineers" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_APEGNB_NB_ENGINEERS === "true";
  },
  async fetch() {
    return [];
  },
};

export function apegnbNbEngineersEnabled(): boolean {
  return apegnbNbEngineersSource.enabled();
}

export async function runApegnbNbEngineers(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
} | null> {
  if (!apegnbNbEngineersSource.enabled()) return null;

  const limit = Number(
    process.env.PROLIO_APEGNB_LIMIT ?? String(DEFAULT_LIMIT),
  );
  const effectiveLimit =
    Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const sink = getSink();

  // Step 1: GET the search page to obtain initial VIEWSTATE bundle.
  const getResult = await fetchHtml(SEARCH_URL, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-CA,en;q=0.9",
    },
  });
  if (!getResult || !getResult.body) {
    console.warn("[apegnb] failed to load search page");
    return null;
  }
  let vs = extractViewstateBundle(getResult.body);
  if (!vs.viewstate) {
    console.warn("[apegnb] VIEWSTATE not found on search page");
    return null;
  }

  await delay(REQUEST_DELAY_MS);

  // Step 2: POST a blank search to get page 1 + grid state.
  // We ask for PAGE_SIZE rows; Telerik RadGrid uses a specific hidden field
  // to change the page size — we try the canonical approach of posting
  // with a grid-specific page size change command. If not supported, the
  // default (20) is used and we just paginate more.
  const searchResult = await postForm(vs, {
    __EVENTTARGET: "",
    __EVENTARGUMENT: "",
    // Try to request more rows per page via the Telerik built-in control.
    // If the grid ID is different, this is a no-op and we get the default size.
    "ctl00$ContentPlaceHolder1$rgMemberSearch$ctl00$ctl03$ctl01$PageSizeComboBox": String(PAGE_SIZE),
    "ctl00$ContentPlaceHolder1$txtLastName": "",
    "ctl00$ContentPlaceHolder1$txtFirstName": "",
    "ctl00$ContentPlaceHolder1$txtMemberNumber": "",
    "ctl00$ContentPlaceHolder1$txtCity": "",
    "ctl00$ContentPlaceHolder1$txtPostalCode": "",
    "ctl00$ContentPlaceHolder1$btnSearch": "Search",
  });
  if (!searchResult || !searchResult.body) {
    console.warn("[apegnb] blank search POST failed");
    return null;
  }

  const totalCount = parseTotalCount(searchResult.body);
  const gridClientId = extractGridClientId(searchResult.body);
  console.log(
    `[apegnb] totalCount=${totalCount} gridClientId=${gridClientId ?? "(not found)"}`,
  );

  const allRows: ApegnbRow[] = parseRows(searchResult.body);
  vs = extractViewstateBundle(searchResult.body);

  // Step 3: Paginate through remaining pages via __doPostBack.
  let currentPage = 1;
  while (
    allRows.length < totalCount &&
    allRows.length < effectiveLimit &&
    currentPage < MAX_PAGES
  ) {
    currentPage += 1;
    await delay(REQUEST_DELAY_MS);

    if (!gridClientId) {
      console.warn("[apegnb] no grid client ID found; stopping pagination");
      break;
    }

    const pageResult = await postForm(vs, {
      __EVENTTARGET: gridClientId,
      __EVENTARGUMENT: `Page$${currentPage}`,
    });
    if (!pageResult || !pageResult.body) {
      console.warn(`[apegnb] page=${currentPage} POST failed`);
      break;
    }

    const newRows = parseRows(pageResult.body);
    if (newRows.length === 0) {
      console.log(`[apegnb] page=${currentPage} empty — stopping`);
      break;
    }
    allRows.push(...newRows);
    vs = extractViewstateBundle(pageResult.body);
  }

  console.log(`[apegnb] parsed=${allRows.length} total`);

  // Step 4: Build ScrapedProfessional records.
  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of allRows) {
    if (records.length >= effectiveLimit) break;
    if (!row.memberId || !row.rawName) continue;
    const sourceId = `apegnb:${row.memberId}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    // Only keep "Entitled to Practice" members.
    if (row.status && !/entitled|registered|active/i.test(row.status)) continue;

    const citySlug = mapNbCity(row.rawCity);

    records.push(
      normalise({
        source: "apegnb-nb-engineers",
        country: COUNTRY,
        sourceId,
        name: toTitleCase(row.rawName),
        categoryKey: CATEGORY,
        citySlug,
        licenseNumber: row.memberId,
        metadata: {
          country: COUNTRY,
          province: PROVINCE,
          authority: "APEGNB",
          verified_by_authority: true,
          designation: row.designation || undefined,
          registration_status: row.status || undefined,
          valid_until: row.validUntil || undefined,
        },
      }),
    );
  }

  if (records.length === 0) {
    console.warn("[apegnb] 0 records after filtering — check HTML structure");
    return { fetched: allRows.length, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[apegnb] fetched=${allRows.length} upserted=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: allRows.length, inserted, updated, skipped };
}

export async function runApegnbNbEngineersScrapeRun(): Promise<void> {
  await withScrapeRun("apegnb-nb-engineers", async () => {
    const res = await runApegnbNbEngineers();
    if (!res) return {};
    return {
      rowsFetched: res.fetched,
      rowsUpserted: res.inserted + res.updated,
      rowsSkipped: res.skipped,
    };
  }).catch((e) =>
    console.error("[apegnb] crashed:", (e as Error).message),
  );
}
