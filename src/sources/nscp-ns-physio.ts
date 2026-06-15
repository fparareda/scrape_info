import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";

/**
 * Nova Scotia College of Physiotherapists (NSCP) — public registrant directory.
 *
 * URL: https://nsphysio.com/for-the-public/member-directory
 *
 * Pre-flight 2026-06-15 (datacenter IP):
 *   HTTP 200, Joomla static HTML, no auth, no JS rendering required.
 *   robots.txt (Joomla default) only disallows /administrator/, /cache/,
 *   /cli/, /components/, /images/, /includes/, /installation/, /language/,
 *   /libraries/, /logs/, /media/, /modules/, /plugins/, /templates/, /tmp/.
 *   The member directory path /for-the-public/member-directory is NOT blocked.
 *   No Cloudflare, no CAPTCHA, no login.
 *
 *   Single HTML table, ~780+ rows (active + inactive/resigned/revoked),
 *   columns: Name | Licence Number | License Status | Conditions |
 *            Area of Specialty | Registration Date | Expiry Date |
 *            Resigned Date | Employer(s) | Authorized Prescriber
 *
 * City: halifax (NS capital — all PTs assigned there as fallback since
 *   the table does not include city/address data).
 * Category: fisioterapia. Country: CA. Province: NS.
 * Off by default. `PROLIO_RUN_NSCP_NS_PHYSIO=true` to enable.
 */

const URL =
  process.env.PROLIO_NSCP_NS_PHYSIO_URL ||
  "https://nsphysio.com/for-the-public/member-directory";

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const DEFAULT_LIMIT = 5_000;
const REQUEST_TIMEOUT_MS = 60_000;

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, "")
    .replace(/[‪‫‬‭‮​‌‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface NscpRow {
  name: string;
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

async function fetchHtml(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[nscp-ns-physio] HTTP ${response.status}`);
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

function parseRows(html: string): NscpRow[] {
  const rows: NscpRow[] = [];

  // Match each <tr>...</tr> block
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

  for (const tr of html.matchAll(trRe)) {
    const cells: string[] = [];
    tdRe.lastIndex = 0;
    for (const td of tr[1].matchAll(tdRe)) {
      cells.push(stripTags(td[1]));
    }
    if (cells.length < 2) continue;

    const name = cells[0] ?? "";
    if (!name) continue;

    // Skip header rows
    if (
      name.toLowerCase() === "name" ||
      name.toLowerCase() === "registrant" ||
      /^(first|last)\s*name$/i.test(name)
    ) {
      continue;
    }

    rows.push({
      name,
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

function toRecord(row: NscpRow): ScrapedProfessional | null {
  const name = toTitleCase(row.name.trim());
  if (!name) return null;

  // sourceId: combine name + licence number for stability
  const licNum = row.licenceNumber.trim();
  const sourceId = `nscp-ns-physio:${licNum || name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;

  return normalise({
    source: "nscp-ns-physio",
    country: "CA",
    sourceId,
    name,
    categoryKey: "fisioterapia",
    citySlug: "halifax",
    licenseNumber: licNum || undefined,
    metadata: {
      country: "CA",
      province: "NS",
      authority: "Nova Scotia College of Physiotherapists (NSCP)",
      verified_by_authority: true,
      license_status: row.status || null,
      conditions: row.conditions || null,
      specialty: row.specialty || null,
      registration_date: row.registrationDate || null,
      expiry_date: row.expiryDate || null,
      resigned_date: row.resignedDate || null,
      employer: row.employer || null,
      authorized_prescriber: row.authorizedPrescriber || null,
    },
  });
}

export const nscpNsPhysioSource: ScraperSource = {
  name: "nscp-ns-physio",
  enabled() {
    return process.env.PROLIO_RUN_NSCP_NS_PHYSIO === "true";
  },
  async fetch() {
    return [];
  },
};

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

  const rows = parseRows(html);
  console.log(`[nscp-ns-physio] parsed ${rows.length} rows from HTML table`);

  const seen = new Set<string>();
  const records: ScrapedProfessional[] = [];

  for (const row of rows) {
    if (records.length >= cap) break;
    const rec = toRecord(row);
    if (!rec) continue;
    if (seen.has(rec.sourceId)) continue;
    seen.add(rec.sourceId);
    records.push(rec);
  }

  if (records.length === 0) {
    console.warn("[nscp-ns-physio] no records parsed — HTML structure may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[nscp-ns-physio] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
