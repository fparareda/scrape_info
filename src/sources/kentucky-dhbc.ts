import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * Kentucky Department of Housing, Buildings and Construction (DHBC).
 *
 * Public licensee search at:
 *   https://dhbc.ky.gov/Search/HBC_List_Licensees.aspx
 *
 * No robots.txt (404), no login, no CAPTCHA. Returns paginated HTML via
 * ASP.NET WebForms (50 rows/page). Divisions covered:
 *   49 = Division of Electrical  → electricidad
 *   53 = Division of HVAC        → hvac
 *   52 = Division of Plumbing    → fontaneria
 *
 * Pre-flight 2026-05-21:
 *   - robots.txt → 404 (no restrictions)
 *   - Electrical alone: 70+ pages × 50 ≈ 3,500+ licensees (all statuses)
 *   - No CAPTCHA, no auth, no Cloudflare
 *   - Covered categories: electricidad, hvac, fontaneria
 *   - KY not previously covered
 *
 * Enable: PROLIO_RUN_KENTUCKY_DHBC=true
 * Limit:  PROLIO_KENTUCKY_DHBC_LIMIT (default 5000)
 */

const BASE_URL =
  "https://dhbc.ky.gov/Search/HBC_List_Licensees.aspx";
const DEFAULT_LIMIT = 5000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

interface DivisionConfig {
  id: string;
  category: CategoryKey;
  label: string;
}

const DIVISIONS: DivisionConfig[] = [
  { id: "49", category: "electricidad", label: "Electrical" },
  { id: "53", category: "hvac", label: "HVAC" },
  { id: "52", category: "fontaneria", label: "Plumbing" },
];

/** Extract a hidden ASP.NET form field from HTML. */
function extractField(html: string, id: string): string {
  const m = html.match(new RegExp(`id="${id}"\\s+value="([^"]*)"`, "s"));
  return m ? m[1] : "";
}

/**
 * Parse an HTML table with id="MainContent_grdData" into rows.
 * Returns header row as first element (if present), then data rows.
 */
function parseTable(
  html: string,
): { header: string[]; rows: string[][] } {
  const tableMatch = html.match(
    /<table[^>]*id="MainContent_grdData"[^>]*>([\s\S]*?)<\/table>/i,
  );
  if (!tableMatch) return { header: [], rows: [] };
  const tableHtml = tableMatch[1];

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const tagStripRegex = /<[^>]+>/g;

  const allRows: string[][] = [];
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const rowHtml = rowMatch[1];
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRegex.lastIndex = 0;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      const text = cellMatch[1]
        .replace(tagStripRegex, "")
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
    if (cells.length > 0) allRows.push(cells);
  }

  if (allRows.length === 0) return { header: [], rows: [] };
  const [header, ...rows] = allRows;
  return { header, rows };
}

/** Check if pagination row (all cells are page numbers / "..."). */
function isPaginationRow(cells: string[]): boolean {
  return cells.every(
    (c) =>
      c === "" ||
      /^\d+$/.test(c) ||
      c === "..." ||
      c === "<<" ||
      c === ">>",
  );
}

interface FetchResult {
  rows: ScrapedProfessional[];
  nextPageAvailable: boolean;
  viewstate: string;
  viewstateGenerator: string;
  eventValidation: string;
}

async function fetchPage(
  viewstate: string,
  viewstateGenerator: string,
  eventValidation: string,
  cookieHeader: string,
  pageArg: string | null,
  divisionId: string,
  category: CategoryKey,
  limit: number,
  alreadyFetched: number,
): Promise<FetchResult & { cookies: string }> {
  const body = new URLSearchParams();
  body.set("__VIEWSTATE", viewstate);
  body.set("__VIEWSTATEGENERATOR", viewstateGenerator);
  body.set("__EVENTVALIDATION", eventValidation);

  if (pageArg) {
    // Pagination POST
    body.set("__EVENTTARGET", "ctl00$MainContent$grdData");
    body.set("__EVENTARGUMENT", pageArg);
    // Preserve search state via hidden fields
    body.set("ctl00$MainContent$drpProfTrade", divisionId);
    body.set("ctl00$MainContent$drpLictype", "0");
    body.set("ctl00$MainContent$txtLicName", "");
    body.set("ctl00$MainContent$txtLicNum", "");
    body.set("ctl00$MainContent$drpStatus", "Active");
  } else {
    // Initial search POST
    body.set("__EVENTTARGET", "");
    body.set("__EVENTARGUMENT", "");
    body.set("ctl00$MainContent$drpProfTrade", divisionId);
    body.set("ctl00$MainContent$drpLictype", "0");
    body.set("ctl00$MainContent$txtLicName", "");
    body.set("ctl00$MainContent$txtLicNum", "");
    body.set("ctl00$MainContent$drpStatus", "Active");
    body.set("ctl00$MainContent$btnContinue", "Search");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": USER_AGENT,
    Referer: BASE_URL,
  };
  if (cookieHeader) headers["Cookie"] = cookieHeader;

  const response = await fetch(BASE_URL, {
    method: "POST",
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(60_000),
  });

  // Capture cookies from response
  const setCookieRaw = response.headers.get("set-cookie") ?? "";
  const newCookies: string[] = [];
  for (const part of setCookieRaw.split(",")) {
    const m = part.match(/^\s*([^;]+)/);
    if (m) newCookies.push(m[1].trim());
  }
  // Merge new cookies with existing
  const existingCookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const [k, ...rest] = pair.trim().split("=");
    if (k) existingCookies[k.trim()] = rest.join("=");
  }
  for (const c of newCookies) {
    const [k, ...rest] = c.split("=");
    if (k) existingCookies[k.trim()] = rest.join("=");
  }
  const mergedCookies = Object.entries(existingCookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  if (!response.ok) {
    console.error(`[kentucky-dhbc] HTTP ${response.status}`);
    return {
      rows: [],
      nextPageAvailable: false,
      viewstate: "",
      viewstateGenerator: "",
      eventValidation: "",
      cookies: mergedCookies,
    };
  }

  const html = await response.text();
  const newViewstate = extractField(html, "__VIEWSTATE");
  const newGenerator = extractField(html, "__VIEWSTATEGENERATOR");
  const newEventValidation = extractField(html, "__EVENTVALIDATION");

  const { rows: rawRows } = parseTable(html);
  const out: ScrapedProfessional[] = [];

  for (const cells of rawRows) {
    if (alreadyFetched + out.length >= limit) break;
    if (isPaginationRow(cells)) continue;
    // Columns: [Name, LicenseType, DBAName, LicenseNumber, Status, IssuedDate, ExpirationDate]
    if (cells.length < 4) continue;

    const [rawName, licenseType, dbaName, licenseNumber, status] = cells;
    if (!rawName || !licenseNumber) continue;
    // Filter active only (server filter may not fully apply on pagination)
    if (status && status !== "Active") continue;
    // Skip pagination rows that crept in
    if (/^\d+$/.test(rawName.trim())) continue;

    const displayName = (dbaName || rawName).trim();
    if (!displayName) continue;

    // We don't have city from this endpoint — use state slug
    // Kentucky city slugs aren't reliably parseable from name/license data
    // We'll use empty citySlug and annotate with state metadata
    const citySlug = "";

    out.push(
      normalise({
        source: "kentucky-dhbc",
        country: "US",
        sourceId: `kentucky-dhbc:${licenseNumber}`,
        name: displayName,
        categoryKey: category,
        citySlug,
        licenseNumber: licenseNumber.trim(),
        metadata: {
          country: "US",
          state: "KY",
          province_slug: "kentucky",
          authority: "Kentucky DHBC",
          verified_by_authority: true,
          license_type: licenseType?.trim() ?? "",
          license_status: status?.trim() ?? "",
          source_name: rawName.trim(),
        },
      }),
    );
  }

  // Check if there are more pages
  const nextPageAvailable =
    html.includes("Page$") &&
    newViewstate.length > 0;

  return {
    rows: out,
    nextPageAvailable,
    viewstate: newViewstate,
    viewstateGenerator: newGenerator,
    eventValidation: newEventValidation,
    cookies: mergedCookies,
  };
}

async function fetchDivision(
  div: DivisionConfig,
  limit: number,
): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];

  // Step 1: GET the initial form page
  let initResponse: Response;
  try {
    initResponse = await fetch(BASE_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    console.error(
      `[kentucky-dhbc] network error on init: ${(e as Error).message}`,
    );
    return [];
  }
  if (!initResponse.ok) {
    console.error(`[kentucky-dhbc] init HTTP ${initResponse.status}`);
    return [];
  }
  const initHtml = await initResponse.text();

  // Extract VIEWSTATE fields from initial form
  let viewstate = extractField(initHtml, "__VIEWSTATE");
  let viewstateGenerator = extractField(initHtml, "__VIEWSTATEGENERATOR");
  let eventValidation = extractField(initHtml, "__EVENTVALIDATION");

  if (!viewstate) {
    console.error(
      `[kentucky-dhbc] could not extract VIEWSTATE from initial form`,
    );
    return [];
  }

  // Capture initial cookies
  const rawCookie = initResponse.headers.get("set-cookie") ?? "";
  const cookieParts: string[] = [];
  for (const part of rawCookie.split(",")) {
    const m = part.match(/^\s*([^;]+)/);
    if (m) cookieParts.push(m[1].trim());
  }
  let cookies = cookieParts.join("; ");

  // Step 2: POST search form (page 1)
  let pageNum = 1;
  let firstPost = true;

  while (out.length < limit) {
    const pageArg = firstPost ? null : `Page$${pageNum}`;
    let result: FetchResult & { cookies: string };

    try {
      result = await fetchPage(
        viewstate,
        viewstateGenerator,
        eventValidation,
        cookies,
        pageArg,
        div.id,
        div.category,
        limit,
        out.length,
      );
    } catch (e) {
      console.error(
        `[kentucky-dhbc] error on page ${pageNum}: ${(e as Error).message}`,
      );
      break;
    }

    out.push(...result.rows);
    cookies = result.cookies;
    viewstate = result.viewstate;
    viewstateGenerator = result.viewstateGenerator;
    eventValidation = result.eventValidation;

    if (firstPost) {
      firstPost = false;
      pageNum = 2;
    } else {
      pageNum += 1;
    }

    if (!result.nextPageAvailable || out.length >= limit) break;

    // Polite delay between pages
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(
    `[kentucky-dhbc] Division ${div.label}: fetched=${out.length}`,
  );
  return out;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  for (const div of DIVISIONS) {
    if (out.length >= limit) break;
    const remaining = limit - out.length;
    const divLimit = Math.ceil(remaining / (DIVISIONS.length - DIVISIONS.indexOf(div)));
    const rows = await fetchDivision(div, Math.min(remaining, divLimit));
    out.push(...rows);
  }
  return out;
}

export const kentuckyDhbcSource: ScraperSource = {
  name: "kentucky-dhbc",
  enabled() {
    return process.env.PROLIO_RUN_KENTUCKY_DHBC === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runKentuckyDhbc(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
} | null> {
  if (!kentuckyDhbcSource.enabled()) return null;

  const rawLimit = Number(
    process.env.PROLIO_KENTUCKY_DHBC_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0) {
    console.warn(
      "[kentucky-dhbc] zero records fetched — site may have changed",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[kentucky-dhbc] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
