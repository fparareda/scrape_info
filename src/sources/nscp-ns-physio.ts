import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * NSCP — Nova Scotia College of Physiotherapists.
 *
 * Public member directory at
 *   https://nsphysio.com/for-the-public/member-directory
 *
 * Pre-flight 2026-05-28: single HTTP GET returns all ~1,654 records in
 * the initial HTML response — no pagination, no JS rendering, no
 * Cloudflare, no CAPTCHA, no login required.
 *
 * robots.txt: Joomla standard — only blocks /administrator/, /cache/,
 * etc. The /for-the-public/ path is explicitly NOT blocked.
 *
 * HTML table columns (left to right):
 *   Name | Licence Number | License Status | Conditions |
 *   Area of Specialty | Registration Date | Expiry Date |
 *   Resigned Date | Employer(s) | Authorized Prescriber
 *
 * Strategy: one GET, parse the HTML table, keep only records with
 * status "Practicing Active" or "Conditional Active".
 * Name is "Surname, FirstName" — normalised to "FirstName Surname".
 * citySlug = "" (province-level only; province_slug = "ns").
 *
 * Category: fisioterapia. Country: CA. Province: NS. Authority: NSCP.
 * Off by default — `PROLIO_RUN_NSCP_NS_PHYSIO=true` to enable.
 * Cap via `PROLIO_NSCP_NS_PHYSIO_LIMIT` (default 2000 — universe ~1.6k).
 */

const DIRECTORY_URL = "https://nsphysio.com/for-the-public/member-directory";
const AUTHORITY = "NSCP";
const PROVINCE = "NS";
const DEFAULT_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 60_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const ACTIVE_STATUSES = new Set(["Practicing Active", "Conditional Active"]);

export const nscpNsPhysioSource: ScraperSource = {
  name: "nscp-ns-physio" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_NSCP_NS_PHYSIO === "true";
  },
  async fetch() {
    return [];
  },
};

async function fetchHtml(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(DIRECTORY_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[nscp-ns-physio] HTTP ${response.status} on ${DIRECTORY_URL}`);
      return null;
    }
    return await response.text();
  } catch (e) {
    console.warn(`[nscp-ns-physio] fetch failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Strip HTML tags, decode common entities, and trim whitespace. */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

interface NscpRow {
  nameSurnameFirst: string;
  licenceNumber: string;
  status: string;
  conditions: string;
  specialty: string;
  registrationDate: string;
  expiryDate: string;
  resignedDate: string;
  employer: string;
  authorizedPrescriber: string;
}

/**
 * Parse the HTML table from the NSCP member directory page.
 *
 * The page contains a standard HTML <table> with <thead> + <tbody>.
 * We split on <tr and extract <td> cell text for each row.
 */
function parseRows(html: string): NscpRow[] {
  const rows: NscpRow[] = [];

  // Find the table body — look for <tbody> ... </tbody>
  const tbodyMatch = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(html);
  if (!tbodyMatch) {
    console.warn("[nscp-ns-physio] no <tbody> found in response");
    return rows;
  }
  const tbody = tbodyMatch[1];

  // Split on <tr> tags to get individual rows
  // Each row ends at the next <tr or </tbody>
  const trParts = tbody.split(/<tr[^>]*>/i);

  for (const part of trParts) {
    if (!part.trim()) continue;

    // Extract all <td>...</td> cell contents
    const cells: string[] = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m: RegExpExecArray | null;
    while ((m = tdRegex.exec(part)) !== null) {
      cells.push(stripTags(m[1]));
    }

    // Need at least 10 columns (Name, Licence, Status, Conditions,
    // Specialty, RegDate, ExpiryDate, ResignedDate, Employer, AuthPrescriber)
    if (cells.length < 10) continue;

    rows.push({
      nameSurnameFirst: cells[0] ?? "",
      licenceNumber: cells[1] ?? "",
      status: cells[2] ?? "",
      conditions: cells[3] ?? "",
      specialty: cells[4] ?? "",
      registrationDate: cells[5] ?? "",
      expiryDate: cells[6] ?? "",
      resignedDate: cells[7] ?? "",
      employer: cells[8] ?? "",
      authorizedPrescriber: cells[9] ?? "",
    });
  }

  return rows;
}

/**
 * Convert "Surname, FirstName" to "FirstName Surname".
 * Handles single-name entries (no comma) by returning as-is.
 */
function normaliseName(raw: string): string {
  const comma = raw.indexOf(",");
  if (comma === -1) return raw.trim();
  const surname = raw.slice(0, comma).trim();
  const given = raw.slice(comma + 1).trim();
  return [given, surname].filter(Boolean).join(" ");
}

function toRecord(row: NscpRow): ScrapedProfessional | null {
  const licence = row.licenceNumber.trim();
  if (!licence) return null;

  const rawName = row.nameSurnameFirst.trim();
  if (!rawName) return null;

  const name = normaliseName(rawName);
  if (!name) return null;

  return normalise({
    source: "nscp-ns-physio" as ScrapeSource,
    country: "CA",
    sourceId: `nscp-ns-physio:${licence}`,
    name,
    categoryKey: "fisioterapia",
    citySlug: "",
    licenseNumber: licence,
    metadata: {
      province: PROVINCE,
      country: "CA",
      verified_by_authority: true,
      authority: AUTHORITY,
      licence_status: row.status || null,
      employer: row.employer || null,
      conditions: row.conditions || null,
      area_of_specialty: row.specialty || null,
      registration_date: row.registrationDate || null,
      expiry_date: row.expiryDate || null,
      authorized_prescriber: row.authorizedPrescriber || null,
    },
  });
}

export async function runNscpNsPhysio(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!nscpNsPhysioSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_NSCP_NS_PHYSIO_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const html = await fetchHtml();
  if (!html) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const allRows = parseRows(html);
  console.log(`[nscp-ns-physio] parsed ${allRows.length} rows from HTML table`);

  const seen = new Set<string>();
  const records: ScrapedProfessional[] = [];
  let skippedInactive = 0;

  for (const row of allRows) {
    if (records.length >= cap) break;

    // Only include active members
    if (!ACTIVE_STATUSES.has(row.status)) {
      skippedInactive += 1;
      continue;
    }

    const rec = toRecord(row);
    if (!rec) continue;
    if (seen.has(rec.sourceId)) continue;
    seen.add(rec.sourceId);
    records.push(rec);
  }

  if (records.length === 0) {
    console.warn(
      `[nscp-ns-physio] no active rows (skippedInactive=${skippedInactive}) — ` +
        "HTML structure may have changed",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[nscp-ns-physio] done — fetched=${records.length} skippedInactive=${skippedInactive} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
