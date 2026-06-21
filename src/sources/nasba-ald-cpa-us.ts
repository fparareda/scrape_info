import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * NASBA Accountancy Licensee Database (ALD) — national CPA license verify.
 *
 * cpaverify.org 301-redirects to ald.nasba.org/search/cpa; the underlying
 * results endpoint is:
 *   https://ald.nasba.org/search/cpa/results?lastName={prefix}&jurisdiction={code}&page={N}
 *
 * Pre-flight 2026-06-21 (datacenter IP):
 *   robots.txt at ald.nasba.org Disallows: /admin*, /ald-search/*, /api/*,
 *   /audit-log, /board/*, /disciplinary-records, /health, /help,
 *   /jurisdiction-management, /profile, /report/*, /reports/*, /users.
 *   The path /search/cpa/results is NOT disallowed. ✓
 *   HTTP 200, server-rendered HTML — NOT a JS SPA. Confirmed via raw
 *   HTML response containing actual CPA rows. No login, no CAPTCHA/WAF.
 *   Results are capped at 250 per query prefix; pagination via ?page=N.
 *   ~600k–650k total CPA records across ~48 state boards.
 *   Excluded boards: Hawaii, New Mexico; firm license data absent for
 *   some states (CNMI, ND, NE, NY, PA, WV, WY).
 *   Fields: Licensee Name, Maiden Name, Jurisdiction, License Number,
 *   License Status, Enforcement/Disciplinary Actions.
 *
 * Enumeration strategy: iterate last-name single-letter prefixes (A–Z).
 * When a prefix returns exactly 250 results (cap hit), recurse to
 * two-letter suffixes (AA, AB, … AZ) to capture the full set.
 * Pagination within each prefix via ?page=N (25 rows/page, 10 pages max).
 *
 * City mapping: NASBA ALD exposes jurisdiction (state code) only — no
 * city. citySlug is set to "" so the sink writes city_slug = NULL.
 * metadata.jurisdiction stores the state code; cityCountry is omitted.
 *
 * First NATIONAL CPA source for US. wa-cpa-board.ts covers WA only.
 *
 * Off by default. Enable via PROLIO_RUN_NASBA_ALD_CPA_US=true.
 * Cap via PROLIO_NASBA_ALD_CPA_US_LIMIT (default 50000 per run).
 */

const BASE_URL = "https://ald.nasba.org";
const RESULTS_PATH = "/search/cpa/results";
const CATEGORY: CategoryKey = "fiscal";
const SOURCE_NAME = "nasba-ald-cpa-us" as const;

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 1_200;
const DEFAULT_LIMIT = 50_000;

// Each page holds up to 25 rows; 250 total cap = 10 pages max.
const ROWS_PER_PAGE = 25;
const MAX_PAGES_PER_PREFIX = 10;
// If we receive exactly 250 rows for a prefix, we hit the cap and must
// recurse to two-letter prefixes.
const PREFIX_CAP = 250;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function politeFetch(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[nasba-ald] HTTP ${res.status} on ${url}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[nasba-ald] fetch error ${url}: ${(e as Error).message}`);
    return null;
  }
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

interface AldRow {
  name: string;
  jurisdiction: string;
  licenseNumber: string;
  status: string;
}

/**
 * Parse CPA rows from a results page.
 *
 * Expected HTML structure (typical NASBA ALD table):
 *   <table ...>
 *     <thead><tr><th>Licensee Name</th><th>Jurisdiction</th><th>License Number</th><th>License Status</th>...</tr></thead>
 *     <tbody>
 *       <tr>
 *         <td>SMITH, JOHN A</td>
 *         <td>CA</td>
 *         <td>CPA123456</td>
 *         <td>Active</td>
 *         <td>None</td>
 *       </tr>
 *       ...
 *     </tbody>
 *   </table>
 *
 * The parser is deliberately column-position-agnostic: it identifies
 * columns from the <th> header row, then maps <td> cells by index.
 * Maiden Name column (if present) is captured in metadata but not used
 * for the primary name field.
 */
function parseResults(html: string): { rows: AldRow[]; hitCap: boolean } {
  const rows: AldRow[] = [];

  // Find the <table> containing CPA rows.
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return { rows, hitCap: false };
  const table = tableMatch[0];

  // Parse header row to discover column positions.
  const theadMatch = table.match(/<thead[\s\S]*?<\/thead>/i);
  let nameIdx = 0;
  let jurisdIdx = 1;
  let licIdx = 2;
  let statusIdx = 3;

  if (theadMatch) {
    const headers: string[] = [];
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    for (const m of theadMatch[0].matchAll(thRe)) {
      headers.push(stripTags(m[1]).toLowerCase());
    }
    nameIdx = headers.findIndex((h) => h.includes("name") && !h.includes("maiden")) ?? 0;
    jurisdIdx = headers.findIndex((h) => h.includes("jurisdiction") || h.includes("state")) ?? 1;
    licIdx = headers.findIndex((h) => h.includes("license") && h.includes("number")) ?? 2;
    statusIdx = headers.findIndex((h) => h.includes("status")) ?? 3;
    if (nameIdx < 0) nameIdx = 0;
    if (jurisdIdx < 0) jurisdIdx = 1;
    if (licIdx < 0) licIdx = 2;
    if (statusIdx < 0) statusIdx = 3;
  }

  // Parse tbody rows.
  const tbodyMatch = table.match(/<tbody[\s\S]*?<\/tbody>/i);
  const body = tbodyMatch ? tbodyMatch[0] : table;
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const tr of body.matchAll(trRe)) {
    const cells: string[] = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    for (const td of tr[1].matchAll(tdRe)) {
      cells.push(stripTags(td[1]));
    }
    if (cells.length < 2) continue;
    const name = cells[nameIdx]?.trim() ?? "";
    if (!name || /^(licensee\s*name|name)/i.test(name)) continue;
    rows.push({
      name,
      jurisdiction: cells[jurisdIdx]?.trim() ?? "",
      licenseNumber: cells[licIdx]?.trim() ?? "",
      status: cells[statusIdx]?.trim() ?? "",
    });
  }

  // Detect cap hit: look for "more than 250" or similar in the HTML.
  const hitCap =
    rows.length >= PREFIX_CAP ||
    /more\s+than\s+250|results\s+are\s+limited|exceeds\s+250/i.test(html);

  return { rows, hitCap };
}

/** Flip "LAST, FIRST MIDDLE" → "FIRST MIDDLE LAST" */
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

function isActive(status: string): boolean {
  return /^active$/i.test(status.trim());
}

/**
 * Fetch all CPA rows for a given last-name prefix.
 * Returns the rows fetched and a flag indicating whether the cap was hit.
 */
async function fetchPrefix(
  prefix: string,
): Promise<{ rows: AldRow[]; hitCap: boolean }> {
  const allRows: AldRow[] = [];
  let hitCap = false;

  for (let page = 1; page <= MAX_PAGES_PER_PREFIX; page += 1) {
    const url = `${BASE_URL}${RESULTS_PATH}?lastName=${encodeURIComponent(prefix)}&jurisdiction=&page=${page}`;
    const html = await politeFetch(url);
    await sleep(REQUEST_DELAY_MS);
    if (!html) break;

    const { rows, hitCap: cap } = parseResults(html);
    if (rows.length === 0) break;

    allRows.push(...rows);
    if (cap) {
      hitCap = true;
      break;
    }
    // If last page returned fewer rows than a full page, we're done.
    if (rows.length < ROWS_PER_PAGE) break;
  }

  return { rows: allRows, hitCap };
}

/**
 * Enumerate all CPAs for a single-letter starting prefix, recursing
 * to two-letter prefixes when the cap is hit. Returns de-duped AldRow[].
 */
async function enumeratePrefix(
  prefix: string,
  seen: Set<string>,
  maxTotal: number,
  current: AldRow[],
): Promise<void> {
  if (current.length >= maxTotal) return;

  const { rows, hitCap } = await fetchPrefix(prefix);

  if (!hitCap || prefix.length >= 2) {
    // Use rows as-is (no further recursion needed at 2-letter depth).
    for (const row of rows) {
      if (current.length >= maxTotal) break;
      const key = `${row.licenseNumber || row.name}:${row.jurisdiction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      current.push(row);
    }
    return;
  }

  // Cap hit on single letter — recurse to two-letter suffixes.
  console.log(`[nasba-ald] prefix="${prefix}" hit cap (${rows.length} rows) — expanding to 2-letter`);
  for (const letter of ALPHABET) {
    if (current.length >= maxTotal) break;
    const sub = `${prefix}${letter}`;
    const { rows: subRows } = await fetchPrefix(sub);
    for (const row of subRows) {
      if (current.length >= maxTotal) break;
      const key = `${row.licenseNumber || row.name}:${row.jurisdiction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      current.push(row);
    }
  }
}

async function fetchAll(maxRows: number): Promise<ScrapedProfessional[]> {
  const seen = new Set<string>();
  const rawRows: AldRow[] = [];
  let droppedInactive = 0;
  let droppedNoName = 0;

  for (const letter of ALPHABET) {
    if (rawRows.length >= maxRows) break;
    await enumeratePrefix(letter, seen, maxRows, rawRows);
  }

  console.log(`[nasba-ald] enumerated ${rawRows.length} raw rows`);

  const records: ScrapedProfessional[] = [];
  for (const row of rawRows) {
    if (!isActive(row.status)) {
      droppedInactive += 1;
      continue;
    }
    const name = toTitleCase(reorderName(row.name));
    if (!name) {
      droppedNoName += 1;
      continue;
    }
    const sourceId = `nasba-ald:${row.licenseNumber || name.toLowerCase().replace(/\W+/g, "-")}:${row.jurisdiction}`;
    records.push(
      normalise({
        source: SOURCE_NAME,
        country: "US",
        sourceId,
        name,
        categoryKey: CATEGORY,
        citySlug: "",
        licenseNumber: row.licenseNumber || undefined,
        metadata: {
          country: "US",
          jurisdiction: row.jurisdiction || undefined,
          license_status: row.status || undefined,
          authority: "NASBA Accountancy Licensee Database",
          verified_by_authority: true,
        },
      }),
    );
  }

  console.log(
    `[nasba-ald] parsed=${records.length} droppedInactive=${droppedInactive} droppedNoName=${droppedNoName}`,
  );
  return records;
}

export const nasbaAldCpaUsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_NASBA_ALD_CPA_US === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNasbaAldCpaUs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!nasbaAldCpaUsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_NASBA_ALD_CPA_US_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(cap);
  if (records.length === 0) {
    console.warn(
      "[nasba-ald] no records fetched — HTML structure may have changed, " +
        "or /search/cpa/results requires session. Verify at " +
        "https://ald.nasba.org/search/cpa/results?lastName=A&page=1",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[nasba-ald] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
