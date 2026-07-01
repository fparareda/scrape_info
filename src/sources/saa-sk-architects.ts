import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * SAA — Saskatchewan Association of Architects.
 *
 * Pre-flight (2026-07-01):
 *   • Discovery page: https://saskarchitects.com/public-resources/member-directory/
 *     links to a dated PDF register, e.g.
 *     https://saskarchitects.com/wp-content/uploads/2026/06/SAA-Member-Register-June-2026.pdf
 *   • robots.txt (saskarchitects.com): `Disallow: /wp-admin/` only —
 *     `/wp-content/uploads/` is not disallowed.
 *   • Static PDF fetch, no login/CAPTCHA/WAF. Plain WordPress/nginx origin.
 *   • The PDF is a clean fixed-column table (verified via pdfjs-dist text
 *     items + x-coordinates): LAST NAME (x≈20) | FIRST NAME (x≈100) |
 *     FIRM/LICENCE TO PRACTICE (x≈214) | CITY (x≈472) | PROV (x≈557).
 *     Two sections: "REGISTERED MEMBERS" (licensed architects — ingested)
 *     and "SYLLABUS STUDENTS" (not licensed — excluded).
 *   • Record count (June 2026 snapshot): 536 registered-member rows.
 *     Like MAA (Manitoba), SAA membership is not SK-only — reciprocal
 *     registrants appear across ON/AB/MB/BC/QC/NS and a handful of US
 *     states. We ingest every row and let city-slug resolution (CA-wide
 *     city index, same approach as `maa-architects`) silently drop rows
 *     whose city isn't seeded rather than filtering by province up front.
 *
 * Discovery strategy: fetch the member-directory page, extract the first
 * `href` matching `SAA-Member-Register-*.pdf` so the scraper keeps working
 * across the SAA's periodic re-publications without a hardcoded dated
 * filename. Falls back to the last-known URL if discovery fails.
 *
 * Category: arquitecto. Off by default; PROLIO_RUN_SAA_SK_ARCHITECTS=true.
 * Cap via PROLIO_SAA_SK_ARCHITECTS_LIMIT (default 2000 — full roster is
 * ~536 registered members, cap is just a safety ceiling).
 */

const DISCOVERY_URL =
  "https://saskarchitects.com/public-resources/member-directory/";
const FALLBACK_PDF_URL =
  "https://saskarchitects.com/wp-content/uploads/2026/06/SAA-Member-Register-June-2026.pdf";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 2000;
const AUTHORITY = "SAA";
const SOURCE: ScrapeSource = "saa-sk-architects" as ScrapeSource;

// --- City index (CA-wide — SAA members can be in any province) ----------

let cityIndexCache: Map<string, string> | null = null;

async function loadCityIndex(): Promise<Map<string, string>> {
  if (cityIndexCache) return cityIndexCache;
  const cities = await getCities({ country: "CA" });
  const idx = new Map<string, string>();
  for (const city of cities) {
    idx.set(city.name.toLowerCase(), city.slug);
    idx.set(city.slug.toLowerCase(), city.slug);
  }
  cityIndexCache = idx;
  return idx;
}

function resolveCity(
  idx: Map<string, string>,
  rawCity: string | undefined,
): string | undefined {
  if (!rawCity) return undefined;
  return idx.get(rawCity.trim().toLowerCase());
}

// --- HTTP helpers ---------------------------------------------------------

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,*/*",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[saa-sk-architects] HTTP ${res.status} on ${url}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(`[saa-sk-architects] fetch error on ${url}: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPdfBytes(url: string): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/pdf,*/*",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[saa-sk-architects] HTTP ${res.status} fetching PDF ${url}`);
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    console.warn(`[saa-sk-architects] PDF fetch error: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discover the current register PDF URL by scanning the member-directory
 * page for a link matching `SAA-Member-Register-*.pdf`. Falls back to the
 * last-known URL if the page can't be fetched or no match is found.
 */
async function discoverPdfUrl(): Promise<string> {
  const html = await fetchText(DISCOVERY_URL);
  if (!html) return FALLBACK_PDF_URL;
  const m = html.match(
    /href=["']([^"']*SAA-Member-Register-[^"']*\.pdf)["']/i,
  );
  if (!m) {
    console.warn(
      "[saa-sk-architects] no register PDF link found on discovery page — using fallback",
    );
    return FALLBACK_PDF_URL;
  }
  const href = m[1];
  return href.startsWith("http") ? href : new URL(href, DISCOVERY_URL).toString();
}

// --- PDF text-layout parsing ----------------------------------------------

interface TextItem {
  str: string;
  x: number;
  y: number;
}

interface SaaRow {
  lastName: string;
  firstName: string;
  firm: string;
  city: string;
  prov: string;
}

// Column x-boundaries observed in the June 2026 SAA-Member-Register PDF.
// Each item is bucketed into the column whose start is <= item.x, using
// the largest such start (i.e. nearest column to the left).
const COLUMNS: Array<{ key: keyof SaaRow; minX: number }> = [
  { key: "lastName", minX: 0 },
  { key: "firstName", minX: 90 },
  { key: "firm", minX: 200 },
  { key: "city", minX: 460 },
  { key: "prov", minX: 545 },
];

function bucketColumn(x: number): keyof SaaRow {
  let chosen: keyof SaaRow = COLUMNS[0].key;
  for (const col of COLUMNS) {
    if (x >= col.minX) chosen = col.key;
  }
  return chosen;
}

async function extractPdfItems(pdfBytes: Uint8Array): Promise<TextItem[][]> {
  const doc = await getDocument({ data: pdfBytes, useSystemFonts: true }).promise;
  const pages: TextItem[][] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items: TextItem[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const transform = (item as { transform?: number[] }).transform ?? [
        0, 0, 0, 0, 0, 0,
      ];
      items.push({ str: item.str, x: transform[4] ?? 0, y: transform[5] ?? 0 });
    }
    pages.push(items);
  }
  return pages;
}

/**
 * Group text items into rows by y-coordinate (rounded), then bucket each
 * row's items into columns by x-coordinate. Returns raw row records keyed
 * by the SAA table's 5 columns, in document order.
 */
function parseRows(pages: TextItem[][]): { rows: SaaRow[]; sectionBreaks: number[] } {
  const rows: SaaRow[] = [];
  const sectionBreaks: number[] = [];

  for (const items of pages) {
    const byY = new Map<number, TextItem[]>();
    for (const item of items) {
      const key = Math.round(item.y);
      const bucket = byY.get(key);
      if (bucket) bucket.push(item);
      else byY.set(key, [item]);
    }
    // Sort rows top-to-bottom (PDF y grows upward, so descending y = reading order).
    const ys = [...byY.keys()].sort((a, b) => b - a);
    for (const y of ys) {
      const rowItems = byY.get(y)!.sort((a, b) => a.x - b.x);
      const joined = rowItems.map((i) => i.str).join(" ").trim();
      if (/^REGISTERED MEMBERS$/i.test(joined) || /^SYLLABUS STUDENTS$/i.test(joined)) {
        sectionBreaks.push(rows.length);
        continue;
      }
      if (/^LAST NAME/i.test(joined)) continue; // header row
      const row: SaaRow = { lastName: "", firstName: "", firm: "", city: "", prov: "" };
      for (const item of rowItems) {
        const col = bucketColumn(item.x);
        row[col] = (row[col] + " " + item.str).trim();
      }
      if (row.lastName || row.firstName) rows.push(row);
    }
  }
  return { rows, sectionBreaks };
}

function normalisePhone(_raw: string | undefined): string | undefined {
  return undefined; // register PDF has no phone/email columns
}

// --- Core fetch + normalise loop ------------------------------------------

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const pdfUrl = await discoverPdfUrl();
  console.log(`[saa-sk-architects] using PDF: ${pdfUrl}`);
  const pdfBytes = await fetchPdfBytes(pdfUrl);
  if (!pdfBytes) return [];

  const pages = await extractPdfItems(pdfBytes);
  const { rows, sectionBreaks } = parseRows(pages);

  // "REGISTERED MEMBERS" is always the first section; keep only rows
  // before the next section break ("SYLLABUS STUDENTS" or later).
  const registeredCount = sectionBreaks.length >= 2 ? sectionBreaks[1] : rows.length;
  const registeredRows = rows.slice(0, registeredCount);

  console.log(
    `[saa-sk-architects] parsed rows=${rows.length} registeredMembers=${registeredRows.length}`,
  );

  const cityIndex = await loadCityIndex();
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCity = 0;
  let droppedDup = 0;

  for (const row of registeredRows) {
    if (out.length >= limit) break;
    const lastName = row.lastName.trim();
    const firstName = row.firstName.trim();
    if (!lastName && !firstName) continue;
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    if (!name) continue;

    const citySlug = resolveCity(cityIndex, row.city);
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }

    const sourceId = `saa-sk:${name.toLowerCase()}:${row.city.trim().toLowerCase()}`;
    if (seen.has(sourceId)) {
      droppedDup += 1;
      continue;
    }
    seen.add(sourceId);

    out.push(
      normalise({
        source: SOURCE,
        country: "CA",
        sourceId,
        name,
        categoryKey: "arquitecto",
        citySlug,
        phone: normalisePhone(undefined),
        metadata: {
          country: "CA",
          province: row.prov.trim() || undefined,
          firm: row.firm.trim() || undefined,
          authority: AUTHORITY,
          verified_by_authority: true,
        },
      }),
    );
  }

  console.log(
    `[saa-sk-architects] normalised=${out.length} droppedNoCity=${droppedNoCity} droppedDup=${droppedDup}`,
  );
  return out;
}

// --- Public exports ---------------------------------------------------------

export const saaSkArchitectsSource: ScraperSource = {
  name: SOURCE,
  enabled() {
    return process.env.PROLIO_RUN_SAA_SK_ARCHITECTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runSaaSkArchitects(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!saaSkArchitectsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_SAA_SK_ARCHITECTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0) {
    console.warn("[saa-sk-architects] no records — PDF layout may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[saa-sk-architects] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
