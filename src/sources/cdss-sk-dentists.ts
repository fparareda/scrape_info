import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";

/**
 * CDSS — College of Dental Surgeons of Saskatchewan.
 *
 * Public registry at:
 *   https://members.saskdentists.com/dentists-addresses?searchby=1&searchterm=<LETTER>
 *
 * Pre-flight (2026-06-11):
 *   robots.txt at members.saskdentists.com disallows only Joomla system
 *   directories (/administrator/, /bin/, /cache/, /cli/, /includes/,
 *   /installation/, /language/, /layouts/, /libraries/, /logs/, /tmp/)
 *   and static file extensions. The path /dentists-addresses is
 *   unrestricted for *.
 *
 *   Access pattern: 26 GET requests (A–Z) to
 *     ?searchby=1&searchterm=<LETTER>
 *   Each page renders the full list for that surname initial as a plain
 *   HTML table. No pagination within each letter, no JS rendering, no
 *   CAPTCHA, no login.
 *
 *   Fields per row: full name (last, first), designation
 *   (General Practitioner / Specialist type), street address, city,
 *   province, postal code, phone number.
 *
 *   Record count: ~700–900 dentists (letter S alone ≈ 74, B ≈ 50, M ≈ 47).
 *   Province: Saskatchewan (SK). Not covered by any existing scraper or
 *   open PR (the open PR cdsa-ab-dentists covers Alberta, not SK).
 *
 * Category: `dentista`. Off by default.
 * Enable via PROLIO_RUN_CDSS_SK_DENTISTS=true.
 * Cap via PROLIO_CDSS_SK_DENTISTS_LIMIT (default 2000).
 * Monthly cron — dental licences renew annually.
 */

const BASE_URL =
  "https://members.saskdentists.com/dentists-addresses?searchby=1&searchterm=";
const AUTHORITY = "CDSS";
const PROVINCE = "SK";
const CATEGORY: CategoryKey = "dentista";
const DEFAULT_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 600; // polite delay between letter pages
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const SK_CITY_MAP: Record<string, string> = {
  saskatoon: "saskatoon",
  regina: "regina",
  "prince albert": "saskatoon", // no separate slug; closest bucket
  "moose jaw": "saskatoon",
  "swift current": "saskatoon",
  yorkton: "saskatoon",
  "north battleford": "saskatoon",
  estevan: "saskatoon",
  weyburn: "saskatoon",
  lloydminster: "saskatoon",
};

function mapCity(raw: string | undefined): string {
  if (!raw) return "saskatoon";
  const k = raw.trim().toLowerCase();
  return SK_CITY_MAP[k] ?? "saskatoon";
}

export const cdssSkDentistsSource: ScraperSource = {
  name: "cdss-sk-dentists" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CDSS_SK_DENTISTS === "true";
  },
  async fetch() {
    return [];
  },
};

interface CdssRow {
  rawName: string;
  designation: string;
  address: string;
  city: string;
  province: string;
  postalCode: string;
  phone: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLetterPage(letter: string): Promise<string | null> {
  const url = `${BASE_URL}${encodeURIComponent(letter)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-CA,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(
        `[cdss-sk-dentists] letter=${letter} HTTP ${response.status}`,
      );
      return null;
    }
    return await response.text();
  } catch (e) {
    clearTimeout(timer);
    console.warn(
      `[cdss-sk-dentists] letter=${letter} fetch failed: ${(e as Error).message}`,
    );
    return null;
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRows(html: string): CdssRow[] {
  const rows: CdssRow[] = [];

  // Match <tr> blocks containing table cells.
  // CDSS Joomla table structure:
  //   <thead>…</thead>
  //   <tbody>
  //     <tr><td>Last, First</td><td>Designation</td><td>Address</td><td>City</td>
  //         <td>Province</td><td>Postal Code</td><td>Phone</td></tr>
  //     …
  //   </tbody>
  const tbodyMatch = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(html);
  const body = tbodyMatch ? tbodyMatch[1] : html;

  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRe.exec(body)) !== null) {
    const inner = trMatch[1];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRe.exec(inner)) !== null) {
      cells.push(stripTags(tdMatch[1]));
    }
    if (cells.length < 4) continue;
    const rawName = cells[0] ?? "";
    if (!rawName) continue;
    rows.push({
      rawName,
      designation: cells[1] ?? "",
      address: cells[2] ?? "",
      city: cells[3] ?? "",
      province: cells[4] ?? PROVINCE,
      postalCode: cells[5] ?? "",
      phone: cells[6] ?? "",
    });
  }
  return rows;
}

function buildName(rawName: string): string {
  // CDSS shows "Last, First" — flip to "First Last"
  const idx = rawName.indexOf(",");
  if (idx < 0) return toTitleCase(rawName.trim());
  const last = rawName.slice(0, idx).trim();
  const first = rawName.slice(idx + 1).trim();
  return toTitleCase([first, last].filter(Boolean).join(" "));
}

function normaliseCaPhone(raw: string): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

function toRecord(row: CdssRow, letter: string): ScrapedProfessional | null {
  const name = buildName(row.rawName);
  if (!name) return null;
  const citySlug = mapCity(row.city);
  const sourceId = `cdss-sk-dentists:${name.toLowerCase().replace(/\s+/g, "-")}|${row.postalCode || letter}`;
  const addrParts = [row.address, row.city, row.province, row.postalCode].filter(
    (p) => p.trim().length > 0,
  );
  return normalise({
    source: "cdss-sk-dentists" as ScrapeSource,
    country: "CA",
    sourceId,
    name,
    categoryKey: CATEGORY,
    citySlug,
    phone: normaliseCaPhone(row.phone),
    address: addrParts.join(", ") || undefined,
    metadata: {
      country: "CA",
      province: PROVINCE,
      authority: AUTHORITY,
      verified_by_authority: true,
      designation: row.designation || null,
      postal_code: row.postalCode || null,
    },
  });
}

export async function runCdssSkDentists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cdssSkDentistsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_CDSS_SK_DENTISTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const seen = new Set<string>();
  const records: ScrapedProfessional[] = [];
  let droppedNoName = 0;
  let totalRows = 0;

  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  for (const letter of letters) {
    if (records.length >= cap) break;

    const html = await fetchLetterPage(letter.toUpperCase());
    if (!html) {
      await delay(REQUEST_DELAY_MS);
      continue;
    }

    const rows = parseRows(html);
    totalRows += rows.length;
    console.log(`[cdss-sk-dentists] letter=${letter.toUpperCase()} rows=${rows.length}`);

    for (const row of rows) {
      if (records.length >= cap) break;
      const rec = toRecord(row, letter.toUpperCase());
      if (!rec) {
        droppedNoName += 1;
        continue;
      }
      if (seen.has(rec.sourceId)) continue;
      seen.add(rec.sourceId);
      records.push(rec);
    }

    await delay(REQUEST_DELAY_MS);
  }

  console.log(
    `[cdss-sk-dentists] totalRows=${totalRows} kept=${records.length} droppedNoName=${droppedNoName}`,
  );

  if (records.length === 0) {
    console.warn(
      `[cdss-sk-dentists] no records — HTML structure may have changed`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[cdss-sk-dentists] done — fetched=${records.length} inserted=${inserted} ` +
      `updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
