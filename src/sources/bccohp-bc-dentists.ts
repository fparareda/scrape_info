import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * BCCOHP — BC College of Oral Health Professionals · public register.
 *
 * The four legacy BC oral-health colleges (CDSBC, CDHBC, CADBC, BCDTA)
 * merged into BCCOHP on 2022-09-01. The unified public register at
 *   https://apps.oralhealthbc.ca/apps/public-register/
 * is an ASP.NET WebForms application. Searching for "Dentist" with
 * empty name filters returns all 4,352 BC-registered dentists in a
 * single server-rendered HTML table (no pagination needed for the
 * dentist slice; the page dumps the entire matching roster at once).
 *
 * Pre-flight 2026-05-24 (datacenter IP):
 *   1. GET https://apps.oralhealthbc.ca/apps/public-register/
 *      → HTTP 200, 24 KB HTML. Form fields: ddlClass, txtFirstName,
 *        txtLastName, cbLimitations, cbFormer, btnSearch. Hidden ASP.NET
 *        tokens: __VIEWSTATE, __VIEWSTATEGENERATOR, __EVENTVALIDATION.
 *   2. POST with ddlClass=Dentist, txtLastName="" (all others empty)
 *      → 4.1 MB HTML, ~4,352 <tr> rows inside a <table>.
 *      Columns: (empty) | Name | Licence Class | Certified Specialty |
 *               Practice Location | Additional Language(s) | (action).
 *   3. robots.txt: 404 (no file). No Cloudflare challenge, no login.
 *   4. Privacy policy: FOIPPA-compliant; no explicit prohibition on
 *      reading the public register. No user-agreement page guards the
 *      /apps/ subdomain. No commercial-use restriction on the public
 *      register (unlike CPABC which explicitly blocks commercial use).
 *
 * No registration number appears in the list view. We build a stable
 * sourceId from a slug of "name + licence_class" to avoid collisions.
 * Practice Location (city) is present for ~85% of rows; rows without
 * a mappable BC city fall back to "vancouver" (largest BC city).
 *
 * Category: dentista. Province: BC. Authority: BCCOHP.
 * Off by default — PROLIO_RUN_BCCOHP_BC_DENTISTS=true.
 * Cap via PROLIO_BCCOHP_BC_DENTISTS_LIMIT (default 6_000).
 */

const BASE_URL = "https://apps.oralhealthbc.ca/apps/public-register/";
const AUTHORITY = "BCCOHP";
const PROVINCE = "BC";
const CATEGORY: CategoryKey = "dentista";
const DEFAULT_LIMIT = 6_000;
const DEFAULT_CITY = "vancouver";
const REQUEST_TIMEOUT_MS = 120_000; // large HTML response (~4 MB)

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── City mapping ──────────────────────────────────────────────────────────────

interface CityIndex {
  exact: Map<string, string>;
  aliases: Map<string, string>;
}

let cityIndexCache: CityIndex | null = null;

async function loadCityIndex(): Promise<CityIndex> {
  if (cityIndexCache) return cityIndexCache;
  const cities = await getCities({ country: "CA" });
  const exact = new Map<string, string>();
  for (const city of cities) {
    exact.set(city.name.toLowerCase(), city.slug);
    exact.set(city.slug.toLowerCase(), city.slug);
  }
  const aliases = new Map<string, string>([
    // Metro Vancouver sub-municipalities
    ["north vancouver", "north-vancouver"],
    ["west vancouver", "west-vancouver"],
    ["new westminster", "new-westminster"],
    ["maple ridge", "maple-ridge"],
    ["port coquitlam", "port-coquitlam"],
    ["port moody", "port-moody"],
    ["white rock", "white-rock"],
    ["langley city", "langley"],
    ["langley township", "langley"],
    ["pitt meadows", "pitt-meadows"],
    ["bowen island", "bowen-island"],
    // Fraser Valley / Interior
    ["prince george", "prince-george"],
    ["campbell river", "campbell-river"],
    ["salmon arm", "salmon-arm"],
    ["fort st. john", "fort-st-john"],
    ["fort st john", "fort-st-john"],
    ["williams lake", "williams-lake"],
    ["100 mile house", "100-mile-house"],
    ["terrace", "terrace"],
    ["trail", "trail"],
  ]);
  cityIndexCache = { exact, aliases };
  return cityIndexCache;
}

function mapCity(idx: CityIndex, raw: string | undefined): string {
  if (!raw) return DEFAULT_CITY;
  const key = raw.trim().toLowerCase();
  if (!key) return DEFAULT_CITY;
  const alias = idx.aliases.get(key);
  if (alias) return alias;
  const exact = idx.exact.get(key);
  if (exact) return exact;
  return DEFAULT_CITY;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function extractToken(html: string, name: string): string {
  // Handles both attribute orderings: name=".." value=".." and value=".." name=".."
  const m =
    html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`, "i")) ??
    html.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`, "i"));
  return m ? m[1] : "";
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

interface HttpResult {
  ok: boolean;
  body: string;
  /** Cookies from Set-Cookie headers (name=value pairs joined by "; "). */
  cookieHeader: string;
}

async function httpGet(
  url: string,
  cookies: string,
): Promise<HttpResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": CHROME_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-CA,en;q=0.9",
        ...(cookies ? { Cookie: cookies } : {}),
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, body: "", cookieHeader: "" };
    const body = await res.text();
    const cookieHeader = parseSetCookies(res.headers);
    return { ok: true, body, cookieHeader };
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[bccohp-bc-dentists] GET ${url} failed: ${(err as Error).message}`,
    );
    return null;
  }
}

async function httpPost(
  url: string,
  params: Record<string, string>,
  cookies: string,
): Promise<HttpResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const body = new URLSearchParams(params).toString();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": CHROME_UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: url,
        ...(cookies ? { Cookie: cookies } : {}),
      },
      body,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(
        `[bccohp-bc-dentists] POST ${url} → HTTP ${res.status}`,
      );
      return { ok: false, body: "", cookieHeader: "" };
    }
    const responseBody = await res.text();
    const cookieHeader = parseSetCookies(res.headers);
    return { ok: true, body: responseBody, cookieHeader };
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[bccohp-bc-dentists] POST ${url} failed: ${(err as Error).message}`,
    );
    return null;
  }
}

function parseSetCookies(headers: Headers): string {
  // Node fetch may return multiple Set-Cookie headers
  const raw =
    typeof (headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie === "function"
      ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [headers.get("set-cookie") ?? ""];
  const pairs: string[] = [];
  for (const entry of raw) {
    if (!entry) continue;
    // Keep only name=value (first segment before first ;)
    const pair = entry.split(";")[0].trim();
    if (pair.includes("=")) pairs.push(pair);
  }
  return pairs.join("; ");
}

function mergeCookies(existing: string, incoming: string): string {
  if (!incoming) return existing;
  const map = new Map<string, string>();
  for (const pair of existing.split(";")) {
    const [k, v] = pair.trim().split("=");
    if (k) map.set(k, v ?? "");
  }
  for (const pair of incoming.split(";")) {
    const [k, v] = pair.trim().split("=");
    if (k) map.set(k, v ?? "");
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// ── Row parsing ───────────────────────────────────────────────────────────────

interface BccohpRow {
  rawName: string; // "Last, First" or "Last, First\n Preferred Name: X"
  licenceClass: string; // "Full Dentist", "Limited Dentist", etc.
  specialty: string;
  practiceLocation: string; // city name
  languages: string;
}

/**
 * Parse the result table from the BCCOHP public register POST response.
 *
 * Table structure (7 columns):
 *   0: (empty checkbox-like)
 *   1: Name + optional preferred name / actions link
 *   2: Licence Class + optional badge
 *   3: Certified Specialty
 *   4: Practice Location (city)
 *   5: Additional Language(s)
 *   6: (view details action)
 */
function parseResultTable(html: string): BccohpRow[] {
  const out: BccohpRow[] = [];

  // Find the first <table> tag (the results table is the dominant table).
  const tableMatch = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return out;

  const tableBody = tableMatch[1];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

  let isHeader = true; // first row is the header
  for (const m of tableBody.matchAll(rowRe)) {
    const rowHtml = m[1];
    const cells: string[] = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    for (const cm of rowHtml.matchAll(cellRe)) {
      cells.push(stripTags(cm[1]));
    }
    if (cells.length < 5) continue;
    if (isHeader) {
      isHeader = false;
      continue; // skip header row ("Name", "Licence Class", …)
    }

    const rawName = cells[1] ?? "";
    if (!rawName) continue;
    // Skip header rows that sneak in (e.g. repeated headers on long tables)
    if (/^name$/i.test(rawName.trim())) continue;

    out.push({
      rawName: rawName.trim(),
      licenceClass: (cells[2] ?? "").trim(),
      specialty: (cells[3] ?? "").trim(),
      practiceLocation: (cells[4] ?? "").trim(),
      languages: (cells[5] ?? "").trim(),
    });
  }

  return out;
}

/**
 * Convert "Last, First\n Preferred Name: X" → "First Last".
 * Strips the "Preferred Name:" suffix that BCCOHP sometimes appends.
 */
function normaliseName(raw: string): string {
  // Strip preferred name annotation
  const clean = raw.replace(/\s*preferred\s+name\s*:\s*.+$/i, "").trim();
  const parts = clean.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 2) {
    return `${parts[1]} ${parts[0]}`;
  }
  // Fallback: return as-is
  return clean;
}

/**
 * Build a stable slug for the sourceId from name + licenceClass.
 * We have no registration number in the list view.
 */
function makeSlug(name: string, licenceClass: string): string {
  return `${name}|${licenceClass}`
    .toLowerCase()
    .replace(/[^a-z0-9|]/g, "-")
    .replace(/-{2,}/g, "-");
}

// ── Main fetch logic ──────────────────────────────────────────────────────────

async function fetchDentists(cap: number): Promise<ScrapedProfessional[]> {
  // Step 1: GET the form page to acquire ASP.NET session cookie + tokens.
  let cookieJar = "";
  const getResult = await httpGet(BASE_URL, cookieJar);
  if (!getResult || !getResult.ok) {
    console.warn(
      "[bccohp-bc-dentists] initial GET failed — register may be down",
    );
    return [];
  }
  cookieJar = mergeCookies(cookieJar, getResult.cookieHeader);
  const initHtml = getResult.body;

  const viewState = extractToken(initHtml, "__VIEWSTATE");
  const vsGenerator = extractToken(initHtml, "__VIEWSTATEGENERATOR");
  const eventValidation = extractToken(initHtml, "__EVENTVALIDATION");

  if (!viewState) {
    console.warn(
      "[bccohp-bc-dentists] __VIEWSTATE not found — page structure may have changed",
    );
    // Try polite UA if Chrome UA was perhaps blocked
    const retryResult = await fetch(BASE_URL, {
      headers: { "User-Agent": POLITE_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);
    if (!retryResult?.ok) return [];
    return [];
  }

  // Step 2: POST with ddlClass=Dentist to retrieve all BC dentists.
  const postParams: Record<string, string> = {
    __EVENTTARGET: "",
    __EVENTARGUMENT: "",
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: vsGenerator,
    __EVENTVALIDATION: eventValidation,
    ddlClass: "Dentist",
    txtFirstName: "",
    txtLastName: "",
    cbLimitations: "",
    cbFormer: "",
    btnSearch: "Search",
  };

  const postResult = await httpPost(BASE_URL, postParams, cookieJar);
  if (!postResult || !postResult.ok) {
    console.warn(
      "[bccohp-bc-dentists] POST search failed — register may be down",
    );
    return [];
  }

  const rows = parseResultTable(postResult.body);
  if (rows.length === 0) {
    console.warn(
      "[bccohp-bc-dentists] 0 rows parsed — HTML structure may have changed",
    );
    return [];
  }
  console.log(`[bccohp-bc-dentists] parsed ${rows.length} raw rows`);

  // Step 3: Map to ScrapedProfessional.
  const cityIdx = await loadCityIndex();
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoName = 0;

  for (const row of rows) {
    if (out.length >= cap) break;
    const displayName = normaliseName(row.rawName);
    if (!displayName || displayName === "-") {
      droppedNoName += 1;
      continue;
    }

    const citySlug = mapCity(cityIdx, row.practiceLocation || undefined);
    const slug = makeSlug(displayName, row.licenceClass);
    const sourceId = `bccohp:${slug}`;

    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const rec = normalise({
      source: "bccohp-bc-dentists" as ScrapeSource,
      country: "CA",
      sourceId,
      name: displayName,
      categoryKey: CATEGORY,
      citySlug,
      metadata: {
        country: "CA",
        province: PROVINCE,
        authority: AUTHORITY,
        verified_by_authority: true,
        licence_class: row.licenceClass || null,
        certified_specialty: row.specialty || null,
        practice_location_raw: row.practiceLocation || null,
        additional_languages: row.languages || null,
      },
    });
    out.push(rec);
  }

  console.log(
    `[bccohp-bc-dentists] normalised=${out.length} droppedNoName=${droppedNoName}`,
  );
  return out;
}

// ── Public exports ────────────────────────────────────────────────────────────

export const bccohpBcDentistsSource: ScraperSource = {
  name: "bccohp-bc-dentists" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_BCCOHP_BC_DENTISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runBccohpBcDentists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!bccohpBcDentistsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_BCCOHP_BC_DENTISTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchDentists(cap);

  if (records.length === 0) {
    console.warn(
      "[bccohp-bc-dentists] fetched 0 records — register may be down or schema changed",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[bccohp-bc-dentists] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
