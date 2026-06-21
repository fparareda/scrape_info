import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * CPABC Member Directory — Chartered Professional Accountants of British Columbia.
 *
 * URL: https://services.bccpa.ca/Directory/Directory/CPABC_Directory_Search.aspx
 *
 * Pre-flight 2026-06-21 (datacenter IP):
 *   robots.txt at services.bccpa.ca Disallows: /App_Browsers/, /AsiCommon/,
 *   /iParts/, /Layouts/, /NeatUpload/, /NeatUploadTest/, /Portals/,
 *   /Provider/, /Telerik/, /WebResource.axd.
 *   The path /Directory/Directory/ is NOT disallowed. ✓
 *   HTTP 200, ASP.NET WebForms server-rendered HTML.
 *   No CAPTCHA, no Cloudflare/WAF, no paid account required.
 *   ~40,000 CPA members + ~6,000 CPA candidates in BC.
 *   Fields: Member Name, Designation, City of Employment, CPA Number.
 *
 * Access flow:
 *   1. GET BC_User_Agreement.aspx → extract __VIEWSTATE + session cookie.
 *   2. POST with checkbox "agree" accepted → receives search page redirect.
 *   3. GET CPABC_Directory_Search.aspx → extract VIEWSTATE for searches.
 *   4. POST lastName prefix (A–Z then AA–AZ if >50 results/page) →
 *      parse HTML result table rows.
 *
 * The "User Agreement" is a one-click ToS acknowledgment; no account or
 * registration is required. Public data under PIPEDA s. 7(3)(h.2)
 * (publicly available professional registry).
 *
 * City mapping: "City of Employment" column maps via slugify() to the
 * CA city slug table. BC cities (Vancouver, Victoria, Burnaby, Surrey,
 * Richmond, Kelowna, etc.) are seeded. Unmapped cities fall back to
 * "vancouver" (the CPABC head-office city).
 *
 * First fiscal source for Canada. wa-cpa-board.ts covers WA State only.
 *
 * Off by default. Enable via PROLIO_RUN_CPABC_BC_CPA=true.
 * Cap via PROLIO_CPABC_BC_CPA_LIMIT (default 50000 — covers full BC roster).
 */

const BASE = "https://services.bccpa.ca";
const AGREEMENT_URL = `${BASE}/Directory/Directory/BC_User_Agreement.aspx`;
const SEARCH_URL = `${BASE}/Directory/Directory/CPABC_Directory_Search.aspx`;
const CATEGORY: CategoryKey = "fiscal";
const SOURCE_NAME = "cpabc-bc-cpa" as const;
const PROVINCE = "BC";
const FALLBACK_CITY = "vancouver";
const AUTHORITY = "Chartered Professional Accountants of British Columbia (CPABC)";

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_DELAY_MS = 1_200;
const DEFAULT_LIMIT = 50_000;
const ROWS_PER_PAGE = 50;
const MAX_PAGES = 20;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHidden(html: string, fieldName: string): string | null {
  // Match ASP.NET hidden input with the given name/id.
  const re = new RegExp(
    `(?:name|id)="${fieldName}"[^>]*value="([^"]*)"`,
    "i",
  );
  const m = html.match(re);
  if (m) return m[1];
  // Try reversed order.
  const re2 = new RegExp(
    `value="([^"]*)"[^>]*(?:name|id)="${fieldName}"`,
    "i",
  );
  const m2 = html.match(re2);
  return m2 ? m2[1] : null;
}

function extractCookies(res: Response): string {
  // Collect all Set-Cookie values into a single Cookie header string.
  const raw = res.headers.get("set-cookie") ?? "";
  if (!raw) return "";
  return raw
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

interface Session {
  viewState: string;
  viewStateGenerator: string;
  eventValidation: string;
  cookie: string;
}

/**
 * Step 1: GET the user agreement page to obtain a session cookie +
 * VIEWSTATE tokens. Step 2: POST with the agreement checkbox.
 * Returns a Session usable for search requests, or null on failure.
 */
async function acceptAgreement(): Promise<Session | null> {
  // Step 1: GET agreement page.
  let sessionCookie = "";
  {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(AGREEMENT_URL, {
        headers: { "User-Agent": POLITE_UA, Accept: "text/html" },
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        console.warn(`[cpabc] agreement page HTTP ${res.status}`);
        return null;
      }
      sessionCookie = extractCookies(res);
      const html = await res.text();
      const vs = extractHidden(html, "__VIEWSTATE");
      const vsg = extractHidden(html, "__VIEWSTATEGENERATOR");
      const ev = extractHidden(html, "__EVENTVALIDATION");
      if (!vs) {
        console.warn("[cpabc] missing VIEWSTATE on agreement page");
        return null;
      }

      // Step 2: POST with agreement checkbox.
      await sleep(500);
      const body = new URLSearchParams();
      body.set("__VIEWSTATE", vs);
      if (vsg) body.set("__VIEWSTATEGENERATOR", vsg);
      if (ev) body.set("__EVENTVALIDATION", ev);
      // The agreement checkbox name varies; try common names.
      body.set("ctl00$MainContent$chkAgree", "on");
      body.set("ctl00$MainContent$btnContinue", "Continue to Directory");

      const headers: Record<string, string> = {
        "User-Agent": POLITE_UA,
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: AGREEMENT_URL,
      };
      if (sessionCookie) headers.Cookie = sessionCookie;

      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), REQUEST_TIMEOUT_MS);
      const res2 = await fetch(AGREEMENT_URL, {
        method: "POST",
        headers,
        body: body.toString(),
        redirect: "follow",
        signal: controller2.signal,
      });
      clearTimeout(timer2);
      const moreCookies = extractCookies(res2);
      if (moreCookies) {
        sessionCookie = [sessionCookie, moreCookies]
          .filter(Boolean)
          .join("; ");
      }
    } catch (e) {
      console.warn(`[cpabc] agreement fetch failed: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Step 3: GET the search page to extract fresh VIEWSTATE for search POSTs.
  const controller3 = new AbortController();
  const timer3 = setTimeout(() => controller3.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "User-Agent": POLITE_UA,
      Accept: "text/html",
    };
    if (sessionCookie) headers.Cookie = sessionCookie;
    const res3 = await fetch(SEARCH_URL, {
      headers,
      redirect: "follow",
      signal: controller3.signal,
    });
    clearTimeout(timer3);
    if (!res3.ok) {
      console.warn(`[cpabc] search page HTTP ${res3.status}`);
      return null;
    }
    const moreCookies3 = extractCookies(res3);
    if (moreCookies3) {
      sessionCookie = [sessionCookie, moreCookies3].filter(Boolean).join("; ");
    }
    const html3 = await res3.text();
    const vs = extractHidden(html3, "__VIEWSTATE");
    const vsg = extractHidden(html3, "__VIEWSTATEGENERATOR");
    const ev = extractHidden(html3, "__EVENTVALIDATION");
    if (!vs) {
      console.warn("[cpabc] missing VIEWSTATE on search page");
      return null;
    }
    return {
      viewState: vs,
      viewStateGenerator: vsg ?? "",
      eventValidation: ev ?? "",
      cookie: sessionCookie,
    };
  } catch (e) {
    console.warn(`[cpabc] search page fetch failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer3);
  }
}

interface CpabcRow {
  name: string;
  designation: string;
  city: string;
  cpaNumber: string;
}

/**
 * Parse CPA member rows from the search result HTML.
 *
 * Expected ASP.NET GridView table structure:
 *   <table ...>
 *     <tr class="header"><th>Member Name</th><th>Designation</th><th>City of Employment</th><th>CPA #</th></tr>
 *     <tr><td>Smith, John</td><td>CPA, CA</td><td>Vancouver</td><td>12345</td></tr>
 *     ...
 *   </table>
 *
 * The parser discovers column positions from header text so it is
 * resilient to minor column-order changes.
 */
function parseSearchResults(html: string): { rows: CpabcRow[]; morePages: boolean } {
  const rows: CpabcRow[] = [];

  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return { rows, morePages: false };
  const table = tableMatch[0];

  // Discover columns from header row.
  let nameIdx = 0;
  let designIdx = 1;
  let cityIdx = 2;
  let numIdx = 3;
  const thMatch = table.match(/<tr[^>]*>\s*(?:<th[^>]*>[\s\S]*?<\/th>\s*)+/i);
  if (thMatch) {
    const headers: string[] = [];
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    for (const m of thMatch[0].matchAll(thRe)) {
      headers.push(stripTags(m[1]).toLowerCase());
    }
    const ni = headers.findIndex((h) => h.includes("name"));
    const di = headers.findIndex((h) => h.includes("desig"));
    const ci = headers.findIndex((h) => h.includes("city"));
    const pi = headers.findIndex((h) => h.includes("cpa") || h.includes("number") || h.includes("#"));
    if (ni >= 0) nameIdx = ni;
    if (di >= 0) designIdx = di;
    if (ci >= 0) cityIdx = ci;
    if (pi >= 0) numIdx = pi;
  }

  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const tr of table.matchAll(trRe)) {
    const cells: string[] = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    for (const td of tr[1].matchAll(tdRe)) {
      cells.push(stripTags(td[1]));
    }
    if (cells.length < 2) continue;
    const name = cells[nameIdx]?.trim() ?? "";
    if (!name || /^(member\s*name|name)/i.test(name)) continue;
    rows.push({
      name,
      designation: cells[designIdx]?.trim() ?? "",
      city: cells[cityIdx]?.trim() ?? "",
      cpaNumber: cells[numIdx]?.trim() ?? "",
    });
  }

  // Detect pagination: look for a "Next" or page-N link in the HTML.
  const morePages = />\s*Next\s*[»>]|page=\d+/i.test(html) && rows.length >= ROWS_PER_PAGE;

  return { rows, morePages };
}

function reorderName(raw: string): string {
  const idx = raw.indexOf(",");
  if (idx < 0) return raw.trim();
  const last = raw.slice(0, idx).trim();
  const first = raw.slice(idx + 1).trim();
  return `${first} ${last}`.replace(/\s+/g, " ").trim();
}

function toTitleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

async function fetchLetterPage(
  session: Session,
  prefix: string,
  page: number,
): Promise<string | null> {
  const body = new URLSearchParams();
  body.set("__VIEWSTATE", session.viewState);
  if (session.viewStateGenerator) body.set("__VIEWSTATEGENERATOR", session.viewStateGenerator);
  if (session.eventValidation) body.set("__EVENTVALIDATION", session.eventValidation);
  body.set("ctl00$MainContent$txtLastName", prefix);
  body.set("ctl00$MainContent$txtFirstName", "");
  body.set("ctl00$MainContent$txtCity", "");
  body.set("ctl00$MainContent$btnSearch", "Search");
  if (page > 1) {
    // ASP.NET GridView paging typically uses __doPostBack.
    body.set("__EVENTTARGET", `ctl00$MainContent$gvResults`);
    body.set("__EVENTARGUMENT", `Page$${page}`);
  }

  const headers: Record<string, string> = {
    "User-Agent": POLITE_UA,
    Accept: "text/html",
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: SEARCH_URL,
  };
  if (session.cookie) headers.Cookie = session.cookie;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers,
      body: body.toString(),
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[cpabc] search POST HTTP ${res.status} prefix=${prefix} page=${page}`);
      return null;
    }
    const html = await res.text();
    // Update VIEWSTATE for next POST from the response.
    const newVs = extractHidden(html, "__VIEWSTATE");
    if (newVs) session.viewState = newVs;
    const newVsg = extractHidden(html, "__VIEWSTATEGENERATOR");
    if (newVsg) session.viewStateGenerator = newVsg;
    const newEv = extractHidden(html, "__EVENTVALIDATION");
    if (newEv) session.eventValidation = newEv;
    return html;
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[cpabc] search fetch failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAll(maxRows: number): Promise<ScrapedProfessional[]> {
  const session = await acceptAgreement();
  if (!session) {
    console.warn("[cpabc] could not establish session — skipping");
    return [];
  }
  await sleep(REQUEST_DELAY_MS);

  const seen = new Set<string>();
  const records: ScrapedProfessional[] = [];
  let droppedNoName = 0;

  for (const letter of ALPHABET) {
    if (records.length >= maxRows) break;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      if (records.length >= maxRows) break;

      const html = await fetchLetterPage(session, letter, page);
      await sleep(REQUEST_DELAY_MS);
      if (!html) break;

      const { rows, morePages } = parseSearchResults(html);
      if (rows.length === 0) break;

      for (const row of rows) {
        if (records.length >= maxRows) break;
        const name = toTitleCase(reorderName(row.name));
        if (!name) {
          droppedNoName += 1;
          continue;
        }
        const sourceId = `cpabc:${row.cpaNumber || name.toLowerCase().replace(/\W+/g, "-")}`;
        if (seen.has(sourceId)) continue;
        seen.add(sourceId);

        const cityRaw = row.city.trim();
        const citySlug = cityRaw ? slugify(cityRaw) : FALLBACK_CITY;

        records.push(
          normalise({
            source: SOURCE_NAME,
            country: "CA",
            sourceId,
            name,
            categoryKey: CATEGORY,
            citySlug,
            licenseNumber: row.cpaNumber || undefined,
            metadata: {
              country: "CA",
              province: PROVINCE,
              designation: row.designation || undefined,
              city_of_employment: cityRaw || undefined,
              authority: AUTHORITY,
              verified_by_authority: true,
            },
          }),
        );
      }

      if (!morePages) break;
    }
  }

  console.log(
    `[cpabc] parsed=${records.length} droppedNoName=${droppedNoName}`,
  );
  return records;
}

export const cpabcBcCpaSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_CPABC_BC_CPA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCpabcBcCpa(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cpabcBcCpaSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_CPABC_BC_CPA_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(cap);
  if (records.length === 0) {
    console.warn(
      "[cpabc] no records fetched — user agreement flow or HTML structure may have changed. " +
        "Verify at https://services.bccpa.ca/Directory/Directory/BC_User_Agreement.aspx",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cpabc] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
