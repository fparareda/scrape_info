import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * CVBC — College of Veterinarians of British Columbia: Facility/Practice Registry.
 *
 * Public facility search at:
 *   https://www.cvbc.ca/search-by-facility/
 *
 * A single GET request returns a flat server-rendered HTML table listing
 * all registered veterinary practices and hospitals in BC. As of
 * 2026-05-25 the page lists ~750 facilities (≈670 active after filtering
 * out "Cancelled" / "CLOSED" records).
 *
 * Table columns: Facility Name | City | Designated Veterinarian |
 *   Phone | Postal Code | Accreditation Status
 *
 * Pre-flight 2026-05-25 (datacenter IP):
 *   GET https://www.cvbc.ca/search-by-facility/ → 200 OK, server-rendered
 *   WordPress HTML, no JS required for results. robots.txt only disallows
 *   /wp-admin/ — /search-by-facility/ is explicitly allowed.
 *   No Cloudflare challenge, no captcha, no login.
 *
 * Fills the `veterinario` BC gap: CVO ON, MVMA MB, ABVMA AB and SVMA SK
 * are already covered; BC was missing.
 * OMVQ (QC) is JS-only (ZK Framework); AIBC member lookup requires login.
 *
 * Note: no registration number is exposed in the facility table, so
 * sourceId is built from slugified facility name + postal code — a stable
 * composite key for the lifetime of a practice's accreditation.
 *
 * Off by default. `PROLIO_RUN_CVBC_BC_VETS=true` to enable.
 * Cap with `PROLIO_CVBC_BC_VETS_LIMIT` (default 2000).
 */

const SEARCH_URL =
  process.env.PROLIO_CVBC_BC_VETS_URL ??
  "https://www.cvbc.ca/search-by-facility/";
const DEFAULT_LIMIT = 2_000;
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const CATEGORY: CategoryKey = "veterinario";
const SOURCE_NAME = "cvbc-bc-vets" as ScrapeSource;

interface CvbcRow {
  facilityName: string;
  city: string;
  designatedVet: string;
  phone: string;
  postalCode: string;
  status: string;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, " "));
}

function parseFacilityTable(html: string): CvbcRow[] {
  const out: CvbcRow[] = [];
  // CVBC uses a standard WordPress table. Each <tr> has 6 <td>s:
  // Facility Name | City | Designated Vet | Phone | Postal Code | Status.
  // Skip rows that contain <th> elements (header rows).
  const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? html;
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const m of tbody.matchAll(rowRe)) {
    const rowHtml = m[1];
    if (/<th[\s>]/i.test(rowHtml)) continue;
    const cells: string[] = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    for (const td of rowHtml.matchAll(tdRe)) {
      cells.push(stripTags(td[1]));
    }
    if (cells.length < 5) continue;
    const [facilityName = "", city = "", designatedVet = "", phone = "", postalCode = "", status = ""] =
      cells;
    if (!facilityName.trim()) continue;
    out.push({
      facilityName: facilityName.trim(),
      city: city.trim(),
      designatedVet: designatedVet.trim(),
      phone: phone.trim(),
      postalCode: postalCode.trim(),
      status: status.trim(),
    });
  }
  return out;
}

function isActive(status: string): boolean {
  const s = status.toLowerCase();
  return (
    !s.includes("cancel") &&
    !s.includes("close") &&
    !s.includes("revok") &&
    !s.includes("suspend")
  );
}

function normaliseCaPhone(raw: string): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

async function fetchAndParse(limit: number): Promise<ScrapedProfessional[]> {
  let html: string;
  try {
    const response = await fetch(SEARCH_URL, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-CA,en;q=0.9",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`CVBC HTTP ${response.status}`);
    }
    html = await response.text();
  } catch (error) {
    console.error(`[cvbc-bc-vets] fetch failed: ${(error as Error).message}`);
    return [];
  }

  const rows = parseFacilityTable(html);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedInactive = 0;
  let droppedNoName = 0;

  for (const row of rows) {
    if (out.length >= limit) break;

    if (!row.facilityName) {
      droppedNoName += 1;
      continue;
    }
    if (!isActive(row.status)) {
      droppedInactive += 1;
      continue;
    }

    // Stable composite key: slugified facility name + postal code.
    const idKey = `${slugify(row.facilityName)}-${row.postalCode.replace(/\s/g, "").toLowerCase()}`;
    const sourceId = `cvbc:${idKey}`.slice(0, 80);
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const citySlug = row.city ? slugify(row.city) : "british-columbia";
    const address = row.postalCode
      ? `${row.city}, BC ${row.postalCode}`.trim()
      : row.city || undefined;

    out.push(
      normalise({
        source: SOURCE_NAME,
        country: "CA",
        sourceId,
        name: row.facilityName,
        categoryKey: CATEGORY,
        citySlug,
        phone: normaliseCaPhone(row.phone),
        address,
        metadata: {
          country: "CA",
          province: "BC",
          authority: "CVBC",
          verified_by_authority: true,
          designated_veterinarian: row.designatedVet || undefined,
          accreditation_status: row.status || undefined,
          postal_code: row.postalCode || undefined,
        },
      }),
    );
  }

  console.log(
    `[cvbc-bc-vets] rows=${rows.length} parsed=${out.length} ` +
      `dropped_inactive=${droppedInactive} dropped_no_name=${droppedNoName}`,
  );
  return out;
}

export const cvbcBcVetsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_CVBC_BC_VETS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCvbcBcVets(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cvbcBcVetsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_CVBC_BC_VETS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAndParse(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[cvbc-bc-vets] upserted=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
