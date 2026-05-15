import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";

/**
 * SVMA — Saskatchewan Veterinary Medical Association.
 *
 * Public registry at
 *   https://svma.sk.ca/resources/find-a-svma-veterinary-professional-2/
 *
 * Pre-flight 2026-05-15: the page is a single flat HTML table (no
 * pagination, no JS rendering) with columns:
 *   Registration Category | License/Registration Type | First Name |
 *   Last Name | Expiration Date | Restrictions & Notices
 *
 * Rows are emitted in WordPress block-table format with `<tr class=
 * "row-N">` and `<td class="column-M">` markers, which makes regex
 * extraction safe — we don't need cheerio.
 *
 * Strategy: one GET, parse the table, keep DVMs + Veterinary
 * Technologists (registered/general), drop rows without a name. All
 * professionals are mapped to `saskatoon` (only seeded SK city).
 *
 * Category: `veterinario`. Off by default; `PROLIO_RUN_SVMA_SK_VETS=true`.
 * Cap via `PROLIO_SVMA_SK_VETS_LIMIT` (default 3000 — full roster is
 * ~700 DVMs + 600 VTs as of 2026-05).
 */

const URL = "https://svma.sk.ca/resources/find-a-svma-veterinary-professional-2/";
const AUTHORITY = "SVMA";
const PROVINCE = "SK";
const CATEGORY: CategoryKey = "veterinario";
const DEFAULT_CITY = "saskatoon";
const DEFAULT_LIMIT = 3000;
const REQUEST_TIMEOUT_MS = 60_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

export const svmaSkVetsSource: ScraperSource = {
  name: "svma-sk-vets" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_SVMA_SK_VETS === "true";
  },
  async fetch() {
    return [];
  },
};

interface SvmaRow {
  category: string;
  licenseType: string;
  firstName: string;
  lastName: string;
  expiration: string;
  restrictions: string;
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
      console.warn(`[svma-sk-vets] HTTP ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (e) {
    console.warn(`[svma-sk-vets] fetch failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}

function parseRows(html: string): SvmaRow[] {
  const rows: SvmaRow[] = [];
  // Each registrant row matches: <tr class="row-N">...<td class="column-1">...</td>...<td class="column-6">...
  const trRegex = /<tr\s+class="row-(\d+)"[^>]*>([\s\S]*?)(?=<tr\s+class="row-|<\/tbody>|<\/table>)/gi;
  let m: RegExpExecArray | null;
  while ((m = trRegex.exec(html)) !== null) {
    const rowNum = Number(m[1]);
    if (rowNum <= 1) continue; // header row
    const inner = m[2];
    const cells: Record<number, string> = {};
    const tdRegex = /<td\s+class="column-(\d+)"[^>]*>([\s\S]*?)(?=<td\s+class="column-|<\/tr>|<tr\s+class=)/gi;
    let c: RegExpExecArray | null;
    while ((c = tdRegex.exec(inner)) !== null) {
      cells[Number(c[1])] = stripTags(c[2]);
    }
    if (!cells[3] && !cells[4]) continue;
    rows.push({
      category: cells[1] ?? "",
      licenseType: cells[2] ?? "",
      firstName: cells[3] ?? "",
      lastName: cells[4] ?? "",
      expiration: cells[5] ?? "",
      restrictions: cells[6] ?? "",
    });
  }
  return rows;
}

function toRecord(row: SvmaRow): ScrapedProfessional | null {
  const first = row.firstName.trim();
  const last = row.lastName.trim();
  if (!first && !last) return null;
  const name = toTitleCase([first, last].filter(Boolean).join(" "));
  const sourceId = `svma-sk-vets:${name}|${row.category}|${row.licenseType}`;
  return normalise({
    source: "svma-sk-vets" as ScrapeSource,
    sourceId,
    name,
    categoryKey: CATEGORY,
    citySlug: DEFAULT_CITY,
    metadata: {
      country: "CA",
      province: PROVINCE,
      authority: AUTHORITY,
      verified_by_authority: true,
      registration_category: row.category || null,
      license_type: row.licenseType || null,
      expiration_date: row.expiration || null,
      restrictions: row.restrictions || null,
    },
  });
}

export async function runSvmaSkVets(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!svmaSkVetsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_SVMA_SK_VETS_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const html = await fetchHtml();
  if (!html) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rows = parseRows(html);
  console.log(`[svma-sk-vets] parsed ${rows.length} rows from HTML table`);

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
    console.warn(`[svma-sk-vets] no rows — HTML structure may have changed`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[svma-sk-vets] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
