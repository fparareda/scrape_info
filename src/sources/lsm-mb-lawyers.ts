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
 * Law Society of Manitoba — Lawyer Lookup.
 *
 * Public portal embedded as an iframe at
 *   https://lawsociety.mb.ca/for-the-public/lawyer-lookup/
 * The actual data endpoint is a plain PHP script:
 *   https://portal.lawsociety.mb.ca/lookup/action.php
 *
 * Pre-flight 2026-05-26 (datacenter IP):
 *   GET https://portal.lawsociety.mb.ca/lookup/action.php?query=sm&sort=&dir=&page=1&rp=1
 *   → 200 OK, server-rendered HTML fragment containing a <table> of lawyer
 *     records (name, address, firm, status, call date) and a total count
 *     `<span id="rc">63</span> matches found.`
 *   No login, no CAPTCHA enforcement on GET requests, no Cloudflare.
 *
 * robots.txt at lawsociety.mb.ca (main site):
 *   Disallow: /wp-admin/   Disallow: /wp-login.php
 *   The lookup portal (portal.lawsociety.mb.ca) has NO robots.txt (404).
 *   Both paths are therefore unrestricted.
 *
 * Enumeration strategy:
 *   The query is a fuzzy full-text search across name + firm + city; a
 *   minimum of 2 alphanumeric characters is required. We iterate all 676
 *   two-letter lowercase combos `aa`..`zz`. For any pair whose result count
 *   exceeds PAGE_SIZE * MAX_PAGES_PER_QUERY we skip sub-queries (the large
 *   ones are rare and would mostly duplicate records already captured by
 *   adjacent queries). Deduplication is handled by a name+call-date key so
 *   records appearing in multiple queries (e.g. a lawyer named "Anderson"
 *   appears in both `an` and `de` results) are counted once.
 *
 * Estimated total: ~3,000–5,000 lawyers (practising + non-practising).
 *   Query `an` alone returns 1,814; `re` returns 735; `th` returns 607.
 *   Manitoba has ~3,500 active lawyers per LSM annual reports.
 *
 * Category: `abogado`. Province MB. Authority LSM.
 * Off by default — `PROLIO_RUN_LSM_MB_LAWYERS=true` to enable.
 * Cap via `PROLIO_LSM_MB_LAWYERS_LIMIT` (default 8_000).
 */

const BASE_URL =
  "https://portal.lawsociety.mb.ca/lookup/action.php";
const PORTAL_REFERER = "https://portal.lawsociety.mb.ca/lookup/";
const AUTHORITY = "LSM";
const PROVINCE = "MB";
const CATEGORY: CategoryKey = "abogado";
const DEFAULT_CITY = "winnipeg"; // largest MB city; roster is province-wide
const DEFAULT_LIMIT = 8_000;
const PAGE_SIZE = 15;
const MAX_PAGES_PER_QUERY = 50; // 750 records per prefix query max
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 1_200;
const QUERY_DELAY_MS = 800;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

export const lsmMbLawyersSource: ScraperSource = {
  name: "lsm-mb-lawyers" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_LSM_MB_LAWYERS === "true";
  },
  async fetch() {
    return [];
  },
};

interface LsmRow {
  name: string;
  address?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  firm?: string;
  status?: string;
  callDate?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parseTotalCount(html: string): number | null {
  const m = html.match(/id="rc">([\d,]+)<\/span>/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse lawyer rows from the action.php HTML fragment.
 * Each row is a <tr> with 4 <td> cells:
 *   [0] Contact block: <strong>Name</strong><br />address<br />city prov postal<br />Phone:...<br/>Email:...
 *   [1] Firm name
 *   [2] Status (Practising / Non-practising / Articling Student / Suspended)
 *   [3] History: Call date: YYYY-MM-DD
 */
function parseRows(html: string): LsmRow[] {
  const out: LsmRow[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const rowMatch of html.matchAll(rowRe)) {
    const rowHtml = rowMatch[1];
    const cells: string[] = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    for (const cellMatch of rowHtml.matchAll(cellRe)) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 2) continue;

    // Cell 0: contact block
    const contactHtml = cells[0];
    // Name: first <strong>
    const nameMatch = contactHtml.match(/<strong>([^<]+(?:\s*\([^)]*\))?)<\/strong>/i);
    if (!nameMatch) continue;
    const rawName = cleanText(nameMatch[1]);
    if (!rawName) continue;

    // Address lines: strip tags and split by <br>
    const addrPart = contactHtml
      .replace(/<strong>[^<]*<\/strong>/i, "")
      .replace(/<a\s[^>]*>[\s\S]*?<\/a>/gi, "");
    const lines = addrPart
      .split(/<br\s*\/?>/i)
      .map((s) => cleanText(s))
      .filter(Boolean);

    // First line is typically the street address (if it looks like a street)
    let address: string | undefined;
    let city: string | undefined;
    let province: string | undefined;
    let postalCode: string | undefined;
    let phone: string | undefined;
    let email: string | undefined;

    for (const line of lines) {
      if (/^Phone:/i.test(line)) {
        phone = line.replace(/^Phone:\s*/i, "").trim();
        continue;
      }
      if (/^Fax:/i.test(line)) continue; // skip fax
      if (/^Email:/i.test(line)) {
        // email may be inline text after tag stripping
        email = line.replace(/^Email:\s*/i, "").trim();
        continue;
      }
      // City/province line: matches "CITY  MB  R3C 3N9" or "CITY ON  M5H1J8"
      const cityProvinceMatch = line.match(
        /^(.*?)\s{2,}([A-Z]{2})\s{2,}([A-Z]\d[A-Z]\s*\d[A-Z]\d)$/,
      );
      if (cityProvinceMatch) {
        city = cityProvinceMatch[1].trim();
        province = cityProvinceMatch[2].trim();
        postalCode = cityProvinceMatch[3].replace(/\s/g, "");
        continue;
      }
      // Also try looser pattern: "CITY MB" without postal
      const cityProvLoose = line.match(/^(.+?)\s+([A-Z]{2})\s*$/);
      if (cityProvLoose && cityProvLoose[2].length === 2) {
        city = cityProvLoose[1].trim();
        province = cityProvLoose[2].trim();
        continue;
      }
      // Otherwise treat as a street address line (take the first one)
      if (!address && line.length > 3 && !/^n\/a$/i.test(line)) {
        address = line;
      }
    }

    // Try to extract email from the anchor tag in the original HTML
    const emailAnchor = contactHtml.match(/href="mailto:([^"]+)"/i);
    if (emailAnchor) email = emailAnchor[1].trim();

    // Cell 1: firm
    const firm = cells[1] ? cleanText(cells[1]) : undefined;
    const firmClean = firm && !/^n\/a$/i.test(firm) ? firm : undefined;

    // Cell 2: status
    const status = cells[2] ? cleanText(cells[2]) : undefined;

    // Cell 3: history / call date
    let callDate: string | undefined;
    if (cells[3]) {
      const cdMatch = cleanText(cells[3]).match(/Call date:\s*(\d{4}-\d{2}-\d{2})/i);
      if (cdMatch) callDate = cdMatch[1];
    }

    out.push({
      name: rawName,
      address,
      city: city || undefined,
      province: province || undefined,
      postalCode,
      phone,
      email,
      firm: firmClean,
      status,
      callDate,
    });
  }
  return out;
}

/** Convert "Last, First Middle (KC)" → "First Middle Last" */
function normaliseDisplayName(lastFirstRaw: string): string {
  // Strip honorific suffix like " (KC)", " Q.C."
  const stripped = lastFirstRaw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const parts = stripped.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 2) {
    return `${parts[1]} ${parts[0]}`;
  }
  return stripped;
}

async function fetchPage(query: string, page: number): Promise<string | null> {
  const url =
    `${BASE_URL}?query=${encodeURIComponent(query)}&sort=&dir=&page=${page}&rp=${page === 1 ? 1 : 0}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,*/*",
        Referer: PORTAL_REFERER,
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[lsm-mb-lawyers] query=${query} page=${page} HTTP ${res.status}`,
      );
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(
      `[lsm-mb-lawyers] query=${query} page=${page} fetch error: ${(e as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchQueryRows(
  query: string,
  cap: number,
  seen: Set<string>,
): Promise<LsmRow[]> {
  const out: LsmRow[] = [];
  let total: number | null = null;

  for (let page = 1; page <= MAX_PAGES_PER_QUERY; page += 1) {
    if (out.length >= cap) break;
    const html = await fetchPage(query, page);
    if (!html) break;

    if (page === 1) {
      total = parseTotalCount(html);
      if (total !== null) {
        const pages = Math.ceil(total / PAGE_SIZE);
        console.log(
          `[lsm-mb-lawyers] query=${query} total=${total} (~${pages} pages)`,
        );
      }
      // If "at least 2 alphanumeric" error, skip
      if (html.includes("must have at least 2 alphanumeric")) break;
    }

    const rows = parseRows(html);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (out.length >= cap) break;
      // Dedup key: name + callDate (or just name if no call date)
      const key = `${row.name.toLowerCase()}|${row.callDate ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }

    if (total !== null && out.length + (seen.size - out.length) >= total) break;
    if (rows.length < PAGE_SIZE) break; // last page

    await delay(PAGE_DELAY_MS);
  }
  return out;
}

/** Build all 2-letter query combinations a-z × a-z */
function buildQueryPairs(): string[] {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const pairs: string[] = [];
  for (const a of letters) {
    for (const b of letters) {
      pairs.push(a + b);
    }
  }
  return pairs;
}

export async function runLsmMbLawyers(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!lsmMbLawyersSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_LSM_MB_LAWYERS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  // Build city slug lookup for CA
  const cities = await getCities({ country: "CA" });
  const cityIndex = new Map<string, string>();
  for (const c of cities) {
    cityIndex.set(c.name.toLowerCase(), c.slug);
    cityIndex.set(c.slug.toLowerCase(), c.slug);
  }
  // MB-specific aliases
  const aliases = new Map<string, string>([
    ["st. boniface", "winnipeg"],
    ["saint boniface", "winnipeg"],
    ["east st. paul", "winnipeg"],
    ["west st. paul", "winnipeg"],
    ["headingley", "winnipeg"],
    ["birds hill", "winnipeg"],
  ]);

  function resolveCity(rawCity: string | undefined): string {
    if (!rawCity) return DEFAULT_CITY;
    const key = rawCity.trim().toLowerCase();
    if (!key) return DEFAULT_CITY;
    const alias = aliases.get(key);
    if (alias) return alias;
    const exact = cityIndex.get(key);
    if (exact) return exact;
    // Slug-form attempt: replace spaces with hyphens
    const slugForm = key.replace(/\s+/g, "-");
    const slugLookup = cityIndex.get(slugForm);
    if (slugLookup) return slugLookup;
    return DEFAULT_CITY;
  }

  const allRows: LsmRow[] = [];
  const seen = new Set<string>();
  const queries = buildQueryPairs();

  for (const query of queries) {
    if (allRows.length >= cap) break;
    const rows = await fetchQueryRows(query, cap - allRows.length, seen);
    allRows.push(...rows);
    await delay(QUERY_DELAY_MS);
  }

  console.log(
    `[lsm-mb-lawyers] enumeration done — ${allRows.length} unique records`,
  );

  if (allRows.length === 0) {
    console.warn(
      `[lsm-mb-lawyers] fetched 0 records — endpoint may be down or blocked`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const records: ScrapedProfessional[] = [];
  const seenSourceIds = new Set<string>();

  for (const row of allRows) {
    const displayName = normaliseDisplayName(row.name);
    if (!displayName) continue;

    const sourceId = `lsm:${displayName.toLowerCase()}|${row.callDate ?? "no-date"}`;
    if (seenSourceIds.has(sourceId)) continue;
    seenSourceIds.add(sourceId);

    const citySlug = resolveCity(row.city);

    const rec = normalise({
      source: "lsm-mb-lawyers" as ScrapeSource,
      country: "CA",
      sourceId,
      name: displayName,
      categoryKey: CATEGORY,
      citySlug,
      phone: row.phone,
      email: row.email,
      address: row.address,
      metadata: {
        country: "CA",
        province: row.province ?? PROVINCE,
        authority: AUTHORITY,
        verified_by_authority: true,
        firm: row.firm ?? null,
        status: row.status ?? null,
        call_date: row.callDate ?? null,
        raw_city: row.city ?? null,
        postal_code: row.postalCode ?? null,
      },
    });
    if (rec) records.push(rec);
  }

  if (records.length === 0) {
    console.warn(`[lsm-mb-lawyers] 0 normalisable records — check parser`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[lsm-mb-lawyers] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
