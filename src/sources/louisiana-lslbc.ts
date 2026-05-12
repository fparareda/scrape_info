import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, normaliseNorthAmericanPhone } from "./_bulk-utils.js";

/**
 * Louisiana LSLBC — State Licensing Board for Contractors.
 *
 * ~28 000 licensed contractors across 64 Louisiana parishes covering
 * Commercial, Residential, Home Improvement, and Mold Remediation
 * licence types.
 *
 * Pre-flight (2026-05-11):
 *   robots.txt: only /wp-admin/ disallowed — public search unrestricted.
 *   Auth wall: none. Captcha: none. Cloudflare: none.
 *   Technology: ASP.NET MVC (ARL Systems, LLC), server-rendered HTML tables.
 *
 * Strategy: POST to /Public/DetailedSearch/ByCounty for each of the 64
 * Louisiana parishes and parse the HTML results table. One parish at a
 * time with a 1 100 ms polite delay between requests.
 *
 * Off by default. Set `PROLIO_RUN_LOUISIANA_LSLBC=true` to enable.
 * Cap with `PROLIO_LOUISIANA_LSLBC_LIMIT` (default 5 000).
 */

const BASE_URL =
  process.env.PROLIO_LOUISIANA_LSLBC_BASE ||
  "https://arlspublic.lslbc.louisiana.gov";

const SEARCH_PATH = "/Public/DetailedSearch/ByCounty";
const DEFAULT_LIMIT = 5_000;
const REQUEST_DELAY_MS = 1_100;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

/**
 * All 64 Louisiana parishes alphabetically. Used to iterate the
 * /ByCounty search form. Each value must match the dropdown option text
 * exactly as rendered by the ASP.NET page.
 */
const LA_PARISHES: string[] = [
  "Acadia",
  "Allen",
  "Ascension",
  "Assumption",
  "Avoyelles",
  "Beauregard",
  "Bienville",
  "Bossier",
  "Caddo",
  "Calcasieu",
  "Caldwell",
  "Cameron",
  "Catahoula",
  "Claiborne",
  "Concordia",
  "De Soto",
  "East Baton Rouge",
  "East Carroll",
  "East Feliciana",
  "Evangeline",
  "Franklin",
  "Grant",
  "Iberia",
  "Iberville",
  "Jackson",
  "Jefferson",
  "Jefferson Davis",
  "La Salle",
  "Lafayette",
  "Lafourche",
  "Lincoln",
  "Livingston",
  "Madison",
  "Morehouse",
  "Natchitoches",
  "Orleans",
  "Ouachita",
  "Plaquemines",
  "Pointe Coupee",
  "Rapides",
  "Red River",
  "Richland",
  "Sabine",
  "Saint Bernard",
  "Saint Charles",
  "Saint Helena",
  "Saint James",
  "Saint John The Baptist",
  "Saint Landry",
  "Saint Martin",
  "Saint Mary",
  "Saint Tammany",
  "Tangipahoa",
  "Tensas",
  "Terrebonne",
  "Union",
  "Vermilion",
  "Vernon",
  "Washington",
  "Webster",
  "West Baton Rouge",
  "West Carroll",
  "West Feliciana",
  "Winn",
];

/**
 * Map LSLBC licence types to Prolio CategoryKeys.
 *
 * Commercial/Residential licences indicate general contracting —
 * we assign "carpinteria" as the closest general construction trade
 * in the taxonomy.  Electrical and plumbing sub-classifications
 * detected in the qualifier description are remapped accordingly.
 */
function licenceTypeToCategory(
  licenceType: string,
  qualifier: string,
): CategoryKey | undefined {
  const lt = licenceType.toLowerCase();
  const q = qualifier.toLowerCase();

  // Mold Remediation → no match in current taxonomy (no remediation key)
  if (lt.includes("mold")) return undefined;

  // Electrical qualifier words → electricidad
  if (
    q.includes("electrical") ||
    q.includes("electric") ||
    lt.includes("electrical")
  )
    return "electricidad";

  // Plumbing → fontaneria
  if (q.includes("plumb") || lt.includes("plumb")) return "fontaneria";

  // HVAC / mechanical → hvac
  if (q.includes("hvac") || q.includes("mechanical") || q.includes("refrig"))
    return "hvac";

  // Locksmith → cerrajero
  if (q.includes("locksmith") || q.includes("alarm")) return "cerrajero";

  // Home Improvement → carpinteria (remodelling / finish trades)
  if (lt.includes("home improvement")) return "carpinteria";

  // Commercial or Residential licence — general contractor → carpinteria
  if (lt.includes("commercial") || lt.includes("residential"))
    return "carpinteria";

  return undefined;
}

/**
 * Parse HTML table rows from an LSLBC ByCounty search result page.
 *
 * The results table has the following approximate structure (verified
 * from the LSLBC public interface description):
 *
 *   <table>
 *     <thead><tr><th>License Number</th><th>Company Name</th>
 *            <th>License Type</th><th>Status</th>
 *            <th>Address</th><th>Phone</th></tr></thead>
 *     <tbody>
 *       <tr><td>…</td>…</tr>
 *     </tbody>
 *   </table>
 *
 * Column order is matched by index after stripping tags and HTML
 * entities. Adjust COLUMNS if the live layout differs.
 */
interface LslbcRow {
  licenceNumber: string;
  companyName: string;
  licenceType: string;
  qualifier: string;
  status: string;
  city: string;
  address: string;
  phone: string;
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

function parseHtml(html: string): LslbcRow[] {
  const rows: LslbcRow[] = [];
  // Find the first data table (skip nav tables)
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
    // Skip header rows (th-only rows)
    if (!rowHtml.includes("<td")) continue;
    const cells = [...rowHtml.matchAll(CELL_RE)].map((m) =>
      stripTags(m[1]),
    );
    // Expected columns (0-indexed):
    // 0: License Number
    // 1: Company Name / Individual Name
    // 2: License Type
    // 3: Qualifier (sub-classification / qualifying party)
    // 4: Status
    // 5: City
    // 6: Address
    // 7: Phone
    // If layout differs, we still try to extract what we can.
    if (cells.length < 3) continue;
    rows.push({
      licenceNumber: cells[0] ?? "",
      companyName: cells[1] ?? "",
      licenceType: cells[2] ?? "",
      qualifier: cells[3] ?? "",
      status: cells[4] ?? "",
      city: cells[5] ?? "",
      address: cells[6] ?? "",
      phone: cells[7] ?? "",
    });
  }
  return rows;
}

/**
 * POST search for one Louisiana parish and return parsed rows.
 *
 * The form field name for the parish dropdown is derived from the
 * LSLBC ARL Systems ASP.NET MVC convention. The exact field name
 * must be verified on first run; override with PROLIO_LSLBC_FIELD if
 * different.
 */
async function fetchParish(parish: string): Promise<LslbcRow[]> {
  const url = `${BASE_URL}${SEARCH_PATH}`;
  const fieldName =
    process.env.PROLIO_LSLBC_PARISH_FIELD || "contractorCounty";
  const body = new URLSearchParams({ [fieldName]: parish });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml",
        Referer: `${BASE_URL}${SEARCH_PATH}`,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(
      `[louisiana-lslbc] network error for parish "${parish}": ${(err as Error).message}`,
    );
    return [];
  }

  if (!response.ok) {
    console.warn(
      `[louisiana-lslbc] HTTP ${response.status} for parish "${parish}"`,
    );
    return [];
  }

  const html = await response.text();
  const rows = parseHtml(html);
  console.log(
    `[louisiana-lslbc] parish="${parish}" raw_rows=${rows.length}`,
  );
  return rows;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedStatus = 0;
  let droppedNoCategory = 0;
  let droppedNoCity = 0;
  let droppedNoName = 0;

  for (const parish of LA_PARISHES) {
    if (out.length >= limit) break;

    const rows = await fetchParish(parish);

    for (const row of rows) {
      if (out.length >= limit) break;

      // Filter active licences only
      const status = row.status.toLowerCase();
      if (status && !status.includes("active") && !status.includes("current")) {
        droppedStatus += 1;
        continue;
      }

      if (!row.licenceNumber) continue;

      const category = licenceTypeToCategory(row.licenceType, row.qualifier);
      if (!category) {
        droppedNoCategory += 1;
        continue;
      }

      const name = row.companyName;
      if (!name) {
        droppedNoName += 1;
        continue;
      }

      // City: prefer the dedicated city cell; fall back to slugifying
      // the parish as a rough proxy.
      const rawCity = row.city || parish;
      const citySlug = slugify(rawCity);
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      const dedupeKey = `${row.licenceNumber}:${category}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      out.push(
        normalise({
          source: "louisiana-lslbc",
          sourceId: `louisiana-lslbc:${row.licenceNumber}:${category}`,
          name,
          categoryKey: category,
          citySlug,
          phone: normaliseNorthAmericanPhone(row.phone),
          address: row.address || undefined,
          licenseNumber: row.licenceNumber,
          metadata: {
            country: "US",
            state: "LA",
            authority: "Louisiana LSLBC",
            verified_by_authority: true,
            lslbc_licence_type: row.licenceType,
            lslbc_qualifier: row.qualifier || undefined,
            lslbc_parish: parish,
          },
        }),
      );
    }

    // Polite delay between parish requests
    if (out.length < limit) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  console.log(
    `[louisiana-lslbc] parsed=${out.length} ` +
      `droppedStatus=${droppedStatus} ` +
      `droppedNoCategory=${droppedNoCategory} ` +
      `droppedNoCity=${droppedNoCity} ` +
      `droppedNoName=${droppedNoName}`,
  );
  return out;
}

export const louisianaLslbcSource: ScraperSource = {
  name: "louisiana-lslbc",
  enabled() {
    return process.env.PROLIO_RUN_LOUISIANA_LSLBC === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runLouisianaLslbc(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!louisianaLslbcSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_LOUISIANA_LSLBC_LIMIT ?? DEFAULT_LIMIT,
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
    `[louisiana-lslbc] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
