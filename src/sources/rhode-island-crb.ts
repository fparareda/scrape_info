import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay } from "./_bulk-utils.js";

/**
 * Rhode Island Contractors' Registration and Licensing Board (CRLB).
 *
 * ~17 300 active contractor registrations across all types including
 * Residential, Commercial, Residential/Commercial, Commercial Roofer,
 * and specialty trades.
 *
 * Pre-flight (2026-05-13):
 *   robots.txt (datadbr.ri.gov): No general Disallow — public search unrestricted.
 *   Auth wall: none. Captcha: none. Cloudflare: none.
 *   Technology: PHP, server-rendered HTML table.
 *   URL: https://datadbr.ri.gov/crb-search/contractor-summary.php (POST)
 *
 * Strategy: POST to contractor-summary.php for each contractor type,
 * parse the HTML results table. One type at a time with a polite delay.
 *
 * Note: The search results do not include address, city, or phone fields.
 * Records are stored with citySlug="providence" (RI capital) as a
 * representative location — all licensees operate within Rhode Island.
 *
 * Off by default. Set `PROLIO_RUN_RHODE_ISLAND_CRB=true` to enable.
 * Cap with `PROLIO_RHODE_ISLAND_CRB_LIMIT` (default 2 000).
 */

const SEARCH_URL =
  process.env.PROLIO_RHODE_ISLAND_CRB_URL ||
  "https://datadbr.ri.gov/crb-search/contractor-summary.php";

const DEFAULT_LIMIT = 2_000;
const REQUEST_DELAY_MS = 1_100;
const REQUEST_TIMEOUT_MS = 60_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

/**
 * All contractor types available in the RI CRB search form.
 * Each maps to the exact value used in the POST body.
 */
const CONTRACTOR_TYPES: Array<{ value: string; category: CategoryKey }> = [
  { value: "Residential", category: "carpinteria" },
  { value: "Commercial", category: "carpinteria" },
  { value: "Residential/Commercial", category: "carpinteria" },
  { value: "Commercial Roofer", category: "carpinteria" },
  { value: "Underground Utility", category: "fontaneria" },
  { value: "Well Driller", category: "fontaneria" },
  { value: "Pump Installer", category: "fontaneria" },
  { value: "Water Filtration Installer", category: "fontaneria" },
  { value: "Water Filtration Contractor", category: "fontaneria" },
];

interface CrbRow {
  licenceNumber: string;
  companyName: string;
  contractorName: string;
  licenceType: string;
  status: string;
  expirationDate: string;
}

const TABLE_RE = /<table[\s\S]*?<\/table>/gi;
const ROW_RE = /<tr[\s\S]*?<\/tr>/gi;
const CELL_RE = /<td[^>]*>([\s\S]*?)<\/td>/gi;
const TAG_RE = /<[^>]+>/g;

function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(TAG_RE, "")).replace(/\s+/g, " ").trim();
}

/**
 * Parse HTML table rows from a CRB search result page.
 *
 * Column order (0-indexed, verified 2026-05-13):
 *   0: Registration/License Number
 *   1: Company
 *   2: Contractor Name
 *   3: Registration/License Type
 *   4: Status
 *   5: Expiration Date
 *   6: # of Complaints (hidden)
 *   7: # of Violations
 */
function parseHtml(html: string): CrbRow[] {
  const rows: CrbRow[] = [];
  const tables = [...html.matchAll(TABLE_RE)];
  let dataHtml = "";
  for (const t of tables) {
    if (t[0].includes("<td") && t[0].length > dataHtml.length) {
      dataHtml = t[0];
    }
  }
  if (!dataHtml) return rows;

  const rowMatches = [...dataHtml.matchAll(ROW_RE)];
  for (const rm of rowMatches) {
    const rowHtml = rm[0];
    if (!rowHtml.includes("<td")) continue;
    const cells = [...rowHtml.matchAll(CELL_RE)].map((m) => stripTags(m[1]));
    if (cells.length < 5) continue;
    rows.push({
      licenceNumber: cells[0] ?? "",
      companyName: cells[1] ?? "",
      contractorName: cells[2] ?? "",
      licenceType: cells[3] ?? "",
      status: cells[4] ?? "",
      expirationDate: cells[5] ?? "",
    });
  }
  return rows;
}

async function fetchContractorType(
  contractorType: string,
): Promise<CrbRow[]> {
  const body = new URLSearchParams({
    reg_num: "",
    con_reg_type: contractorType,
    company_name: "",
    lastname: "",
    firstname: "",
  });

  let response: Response;
  try {
    response = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml",
        Referer:
          "https://datadbr.ri.gov/crb-search/contractor-search.php",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(
      `[rhode-island-crb] network error for type "${contractorType}": ${(err as Error).message}`,
    );
    return [];
  }

  if (!response.ok) {
    console.warn(
      `[rhode-island-crb] HTTP ${response.status} for type "${contractorType}"`,
    );
    return [];
  }

  const html = await response.text();
  const rows = parseHtml(html);
  console.log(
    `[rhode-island-crb] type="${contractorType}" raw_rows=${rows.length}`,
  );
  return rows;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedStatus = 0;
  let droppedNoName = 0;
  let droppedNoLicence = 0;

  for (const { value: contractorType, category } of CONTRACTOR_TYPES) {
    if (out.length >= limit) break;

    const rows = await fetchContractorType(contractorType);

    for (const row of rows) {
      if (out.length >= limit) break;

      // Filter only valid/active licences
      const status = row.status.toLowerCase();
      if (status && !status.includes("valid") && !status.includes("active")) {
        droppedStatus += 1;
        continue;
      }

      if (!row.licenceNumber) {
        droppedNoLicence += 1;
        continue;
      }

      // Prefer company name; fall back to contractor's personal name
      const name = row.companyName.trim() || row.contractorName.trim();
      if (!name) {
        droppedNoName += 1;
        continue;
      }

      const dedupeKey = `${row.licenceNumber}:${category}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      out.push(
        normalise({
          source: "rhode-island-crb",
          sourceId: `rhode-island-crb:${row.licenceNumber}:${category}`,
          name,
          categoryKey: category,
          // All RI licensees operate in Rhode Island; use Providence (capital)
          // as the representative city — no address data is returned by the API.
          citySlug: "providence",
          licenseNumber: row.licenceNumber,
          metadata: {
            country: "US",
            state: "RI",
            authority: "Rhode Island Contractors Registration and Licensing Board",
            verified_by_authority: true,
            crb_licence_type: contractorType,
            crb_contractor_name: row.contractorName || undefined,
            crb_expiration_date: row.expirationDate || undefined,
          },
        }),
      );
    }

    if (out.length < limit) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  console.log(
    `[rhode-island-crb] parsed=${out.length} ` +
      `droppedStatus=${droppedStatus} ` +
      `droppedNoLicence=${droppedNoLicence} ` +
      `droppedNoName=${droppedNoName}`,
  );
  return out;
}

export const rhodeIslandCrbSource: ScraperSource = {
  name: "rhode-island-crb",
  enabled() {
    return process.env.PROLIO_RUN_RHODE_ISLAND_CRB === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runRhodeIslandCrb(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!rhodeIslandCrbSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_RHODE_ISLAND_CRB_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[rhode-island-crb] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
