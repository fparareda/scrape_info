import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * Maine ALMS — Electricians' Examining Board (Board 4220).
 *
 * Source: Maine Automated Licensing Management System at pfr.maine.gov.
 *
 * Pre-flight (2026-06-11):
 *   robots.txt at https://www.pfr.maine.gov/robots.txt disallows only
 *   `/*TOKEN=`. The /almsonline/almsquery/ path is unrestricted for *.
 *
 *   Access pattern: GET welcome.aspx?board=4220 → session cookie.
 *   GET SearchIndividual.aspx?Board=4220 → __VIEWSTATE tokens.
 *   POST blank search → results page with "Download the list to a
 *   comma-delimited file" link. GET that link → CSV with fields:
 *   LastName, FirstName, BusinessName, Address1, Address2, City,
 *   State, ZipCode, PhoneNumber, County, LicenseNumber,
 *   ExpirationDate, LicenseType.
 *
 *   Record count: ~5,000–15,000 (Master, Journeyman, Limited,
 *   Apprentice electricians across Maine). Maine is not covered
 *   by any existing scraper.
 *
 *   No CAPTCHA, no Cloudflare, no login required.
 *
 * Category: `electricidad`. Off by default.
 * Enable via PROLIO_RUN_MAINE_ALMS_ELECTRICIANS=true.
 * Cap via PROLIO_MAINE_ALMS_ELECTRICIANS_LIMIT (default 20000).
 * Monthly cron — electrician licenses renew annually.
 */

const BASE = "https://www.pfr.maine.gov/almsonline/almsquery";
const WELCOME_URL = `${BASE}/welcome.aspx?board=4220`;
const SEARCH_FORM_URL = `${BASE}/SearchIndividual.aspx?Board=4220`;
const AUTHORITY = "Maine Electricians' Examining Board";
const CATEGORY: CategoryKey = "electricidad";
const DEFAULT_LIMIT = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

export const maineAlmsElectriciansSource: ScraperSource = {
  name: "maine-alms-electricians" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_MAINE_ALMS_ELECTRICIANS === "true";
  },
  async fetch() {
    return [];
  },
};

function extractHidden(html: string, fieldId: string): string | null {
  const re = new RegExp(`id="${fieldId}"[^>]*value="([^"]*)"`, "i");
  const m = html.match(re);
  if (m) return m[1] ?? null;
  const re2 = new RegExp(`name="${fieldId}"[^>]*value="([^"]*)"`, "i");
  const m2 = html.match(re2);
  return m2 ? (m2[1] ?? null) : null;
}

function parseCookies(rawHeader: string | null): string {
  if (!rawHeader) return "";
  return rawHeader
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function getWithTimeout(url: string, headers: Record<string, string>): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[maine-alms-electricians] fetch ${url} failed: ${(e as Error).message}`);
    return null;
  }
}

async function postWithTimeout(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[maine-alms-electricians] POST ${url} failed: ${(e as Error).message}`);
    return null;
  }
}

interface Session {
  cookie: string;
  viewState: string;
  viewStateGenerator: string;
  eventValidation: string;
}

async function buildSession(): Promise<Session | null> {
  const baseHeaders: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // Step 1: GET welcome page → session cookie
  const welcomeResp = await getWithTimeout(WELCOME_URL, baseHeaders);
  if (!welcomeResp || !welcomeResp.ok) {
    console.warn(
      `[maine-alms-electricians] welcome page HTTP ${welcomeResp?.status ?? "network"}`,
    );
    return null;
  }
  const cookie = parseCookies(welcomeResp.headers.get("set-cookie"));

  // Step 2: GET search form → VIEWSTATE tokens
  const formHeaders: Record<string, string> = {
    ...baseHeaders,
    Referer: WELCOME_URL,
    ...(cookie ? { Cookie: cookie } : {}),
  };
  const formResp = await getWithTimeout(SEARCH_FORM_URL, formHeaders);
  if (!formResp || !formResp.ok) {
    console.warn(
      `[maine-alms-electricians] search form HTTP ${formResp?.status ?? "network"}`,
    );
    return null;
  }
  const formHtml = await formResp.text();

  // Merge any new cookies (ASP.NET may issue a fresh session on the form page)
  const formCookie = parseCookies(formResp.headers.get("set-cookie")) || cookie;

  const viewState = extractHidden(formHtml, "__VIEWSTATE");
  const viewStateGenerator = extractHidden(formHtml, "__VIEWSTATEGENERATOR");
  const eventValidation = extractHidden(formHtml, "__EVENTVALIDATION");

  if (!viewState) {
    console.warn(`[maine-alms-electricians] __VIEWSTATE not found on search form`);
    return null;
  }

  return {
    cookie: formCookie,
    viewState,
    viewStateGenerator: viewStateGenerator ?? "",
    eventValidation: eventValidation ?? "",
  };
}

function extractDownloadUrl(html: string): string | null {
  // ALMS systems typically expose a link like:
  //   href="DownloadIndividuals.aspx?Board=4220&..."
  // or a full path.
  const re =
    /href="([^"]*DownloadIndividuals[^"]*)"[^>]*>/i;
  const m = html.match(re);
  if (m && m[1]) {
    const raw = m[1].replace(/&amp;/g, "&");
    if (raw.startsWith("http")) return raw;
    return `${BASE}/${raw.replace(/^\.?\//, "")}`;
  }
  // Fallback: look for any CSV download link
  const re2 = /href="([^"]*\.csv[^"]*)"[^>]*>/i;
  const m2 = html.match(re2);
  if (m2 && m2[1]) {
    const raw2 = m2[1].replace(/&amp;/g, "&");
    return raw2.startsWith("http") ? raw2 : `${BASE}/${raw2.replace(/^\.?\//, "")}`;
  }
  // Direct try: ALMS standard download endpoint
  return `${BASE}/DownloadIndividuals.aspx?Board=4220`;
}

async function fetchCsv(session: Session): Promise<string | null> {
  const postHeaders: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml",
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: SEARCH_FORM_URL,
    ...(session.cookie ? { Cookie: session.cookie } : {}),
  };

  const body = new URLSearchParams();
  body.set("__VIEWSTATE", session.viewState);
  if (session.viewStateGenerator)
    body.set("__VIEWSTATEGENERATOR", session.viewStateGenerator);
  if (session.eventValidation)
    body.set("__EVENTVALIDATION", session.eventValidation);
  body.set("ctl00$MainContent$txtLastName", "");
  body.set("ctl00$MainContent$txtFirstName", "");
  body.set("ctl00$MainContent$btnSearch", "Search");

  const postResp = await postWithTimeout(
    SEARCH_FORM_URL,
    postHeaders,
    body.toString(),
  );
  if (!postResp || !postResp.ok) {
    console.warn(
      `[maine-alms-electricians] search POST HTTP ${postResp?.status ?? "network"}`,
    );
    return null;
  }
  const resultsHtml = await postResp.text();
  const postCookie =
    parseCookies(postResp.headers.get("set-cookie")) || session.cookie;

  const downloadUrl = extractDownloadUrl(resultsHtml);
  if (!downloadUrl) {
    console.warn(`[maine-alms-electricians] download link not found in results HTML`);
    return null;
  }
  console.log(`[maine-alms-electricians] downloading CSV from ${downloadUrl}`);

  const dlHeaders: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/csv,text/plain,*/*",
    Referer: SEARCH_FORM_URL,
    ...(postCookie ? { Cookie: postCookie } : {}),
  };
  const dlResp = await getWithTimeout(downloadUrl, dlHeaders);
  if (!dlResp || !dlResp.ok) {
    console.warn(
      `[maine-alms-electricians] download HTTP ${dlResp?.status ?? "network"}`,
    );
    return null;
  }
  return await dlResp.text();
}

interface AlmsRow {
  lastName: string;
  firstName: string;
  businessName: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  licenseNumber: string;
  expirationDate: string;
  licenseType: string;
  address: string;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(csv: string): AlmsRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Normalise header names
  const headerLine = lines[0] ?? "";
  const headers = parseCsvLine(headerLine).map((h) =>
    h.toLowerCase().replace(/[^a-z0-9]/g, ""),
  );

  const idx = (name: string): number => {
    const variants: string[] = [];
    if (name === "lastname") variants.push("lastname", "last_name", "last");
    else if (name === "firstname") variants.push("firstname", "first_name", "first");
    else if (name === "businessname") variants.push("businessname", "business_name", "business");
    else if (name === "city") variants.push("city");
    else if (name === "state") variants.push("state");
    else if (name === "zip") variants.push("zip", "zipcode", "zip_code", "postalcode");
    else if (name === "phone") variants.push("phone", "phonenumber", "phone_number");
    else if (name === "licensenumber") variants.push("licensenumber", "license_number", "licenseno");
    else if (name === "expirationdate") variants.push("expirationdate", "expiration_date", "expdate");
    else if (name === "licensetype") variants.push("licensetype", "license_type", "type");
    else if (name === "address1") variants.push("address1", "addr1", "addressline1", "address");
    else if (name === "address2") variants.push("address2", "addr2", "addressline2");
    else variants.push(name);
    for (const v of variants) {
      const i = headers.indexOf(v);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iLast = idx("lastname");
  const iFirst = idx("firstname");
  const iBusiness = idx("businessname");
  const iCity = idx("city");
  const iState = idx("state");
  const iZip = idx("zip");
  const iPhone = idx("phone");
  const iLicense = idx("licensenumber");
  const iExp = idx("expirationdate");
  const iType = idx("licensetype");
  const iAddr1 = idx("address1");
  const iAddr2 = idx("address2");

  const rows: AlmsRow[] = [];
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    const get = (i: number): string => (i >= 0 ? (fields[i] ?? "").trim() : "");
    const lastName = get(iLast);
    const firstName = get(iFirst);
    const licenseNumber = get(iLicense);
    if (!lastName && !firstName && !licenseNumber) continue;
    const addr1 = get(iAddr1);
    const addr2 = get(iAddr2);
    const city = get(iCity);
    const state = get(iState);
    const zip = get(iZip);
    const addrParts = [addr1, addr2, city, state, zip].filter((p) => p.length > 0);
    rows.push({
      lastName,
      firstName,
      businessName: get(iBusiness),
      city,
      state,
      zip,
      phone: get(iPhone),
      licenseNumber,
      expirationDate: get(iExp),
      licenseType: get(iType),
      address: addrParts.join(", "),
    });
  }
  return rows;
}

function buildName(row: AlmsRow): string | undefined {
  const first = row.firstName;
  const last = row.lastName;
  if (!first && !last) return row.businessName || undefined;
  const parts = [first, last].filter((p) => p.length > 0);
  return parts
    .join(" ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normaliseUsPhone(raw: string): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

export async function runMaineAlmsElectricians(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!maineAlmsElectriciansSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_MAINE_ALMS_ELECTRICIANS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  // Load US city slugs for mapping
  const cityIndex = new Map<string, string>();
  try {
    const usCities = await getCities({ country: "US" });
    for (const c of usCities) {
      cityIndex.set(c.name.trim().toLowerCase(), c.slug);
      cityIndex.set(c.slug.toLowerCase(), c.slug);
    }
  } catch (e) {
    console.warn(
      `[maine-alms-electricians] failed to load US cities: ${(e as Error).message}`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const session = await buildSession();
  if (!session) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const csv = await fetchCsv(session);
  if (!csv) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rows = parseCsv(csv);
  console.log(`[maine-alms-electricians] parsed ${rows.length} rows from CSV`);

  const seen = new Set<string>();
  const records: ScrapedProfessional[] = [];
  let droppedNoName = 0;
  let droppedNoCity = 0;

  for (const row of rows) {
    if (records.length >= cap) break;

    const name = buildName(row);
    if (!name) {
      droppedNoName += 1;
      continue;
    }

    const cityKey = row.city.toLowerCase().trim();
    const citySlug =
      cityIndex.get(cityKey) ??
      cityIndex.get(slugify(row.city));
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }

    const sourceId = row.licenseNumber
      ? `maine-alms-electricians:${row.licenseNumber}`
      : `maine-alms-electricians:${name}|${row.city}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    records.push(
      normalise({
        source: "maine-alms-electricians" as ScrapeSource,
        country: "US",
        sourceId,
        name,
        categoryKey: CATEGORY,
        citySlug,
        phone: normaliseUsPhone(row.phone),
        address: row.address || undefined,
        licenseNumber: row.licenseNumber || undefined,
        metadata: {
          country: "US",
          state: "ME",
          authority: AUTHORITY,
          verified_by_authority: true,
          license_type: row.licenseType || null,
          expiration_date: row.expirationDate || null,
          business_name: row.businessName || null,
          zip: row.zip || null,
        },
      }),
    );
  }

  console.log(
    `[maine-alms-electricians] parsed=${rows.length} kept=${records.length} ` +
      `droppedNoName=${droppedNoName} droppedNoCity=${droppedNoCity}`,
  );

  if (records.length === 0) {
    console.warn(
      `[maine-alms-electricians] no records kept — verify session flow and CSV format`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[maine-alms-electricians] done — fetched=${records.length} inserted=${inserted} ` +
      `updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
