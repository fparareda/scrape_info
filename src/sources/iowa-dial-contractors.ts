import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, pick, normaliseNorthAmericanPhone } from "./_bulk-utils.js";

/**
 * Iowa DIAL — Active Iowa Construction Contractor Registrations
 * (Socrata open data, Iowa Department of Inspections, Appeals, and Licensing).
 *
 * Catalog page:
 *   https://data.iowa.gov/Workforce/
 *     Active-Iowa-Construction-Contractor-Registrations/dpf3-iz94
 *
 * Direct CSV download (curl-verified 2026-05-23, HTTP 200, no auth):
 *   https://data.iowa.gov/api/views/dpf3-iz94/rows.csv?accessType=DOWNLOAD
 *
 * Record count: 17,246 active registrations (verified 2026-05-23 via
 * Socrata count API: /resource/dpf3-iz94.json?$select=count(*)).
 *
 * Columns:
 *   Registration #, Primary Activity, Business Name, First Name,
 *   Last Name, Email Address, Address 1, Address 2, City, State,
 *   Zip Code, County, Phone, Issue Date, Expire Date
 *
 * NAICS-code prefix → CategoryKey mapping:
 *   23821x  Electrical Contractors           → electricidad
 *   23822x  Plumbing/Heating/A-C             → hvac
 *   236xxx  Building Construction            → carpinteria
 *   238xxx  Specialty Trade Contractors      → carpinteria (default)
 *   230000  Other/Undefined                  → skip
 *
 * robots.txt (data.iowa.gov): only blocks /browse?* filter paths;
 * the /api/views/* CSV download path is explicitly permitted.
 *
 * Iowa is not covered by any existing state-board scraper in this repo.
 * Mandatory registration applies to any contractor earning ≥ $2,000/year
 * from Iowa construction work, giving near-complete market coverage.
 *
 * Env:
 *   PROLIO_RUN_IOWA_DIAL_CONTRACTORS=true     enable
 *   PROLIO_IOWA_DIAL_CONTRACTORS_LIMIT=50000  cap (default)
 */

const DEFAULT_LIMIT = 50_000;
const CSV_URL =
  "https://data.iowa.gov/api/views/dpf3-iz94/rows.csv?accessType=DOWNLOAD";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// NAICS code prefix → CategoryKey. The Primary Activity field is formatted
// as "238220 - Plumbing/Heating & A/C Contractors"; we extract the 6-digit
// code and match on the leading digits.
function mapNaicsCategory(primaryActivity: string): CategoryKey | undefined {
  const code = primaryActivity.trim().slice(0, 6);
  if (!code || code === "230000") return undefined; // Other/Undefined — skip
  // Electrical contractors (23821x)
  if (code.startsWith("23821")) return "electricidad";
  // Plumbing, heating & air-conditioning (23822x)
  if (code.startsWith("23822")) return "hvac";
  // All construction categories map to carpinteria
  if (code.startsWith("23") || code.startsWith("22")) return "carpinteria";
  return undefined;
}

export const iowaDialContractorsSource: ScraperSource = {
  name: "iowa-dial-contractors" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_IOWA_DIAL_CONTRACTORS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runIowaDialContractors(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!iowaDialContractorsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_IOWA_DIAL_CONTRACTORS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  let response: Response;
  try {
    response = await fetch(CSV_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/csv" },
      signal: AbortSignal.timeout(240_000),
    });
  } catch (e) {
    console.error(
      `[iowa-dial-contractors] network: ${(e as Error).message}`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  if (!response.ok) {
    console.error(
      `[iowa-dial-contractors] ${response.status} on ${CSV_URL}`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const text = await response.text();
  const rows = parseCsv(text);
  console.log(
    `[iowa-dial-contractors] parsed raw=${rows.length} from CSV`,
  );

  const today = new Date();
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;

    // Only Iowa-based contractors (some out-of-state contractors register)
    const state = pick(row, ["state"]);
    if (state && state.toUpperCase() !== "IA") continue;

    // Skip expired registrations (Expire Date present and in the past)
    const expireRaw = pick(row, ["expire_date"]);
    if (expireRaw) {
      const expiry = new Date(expireRaw);
      if (!isNaN(expiry.getTime()) && expiry < today) continue;
    }

    const primaryActivity = pick(row, ["primary_activity"]);
    const cat = mapNaicsCategory(primaryActivity);
    if (!cat) continue;

    const regNum = pick(row, ["registration_"]);
    if (!regNum || seen.has(regNum)) continue;
    seen.add(regNum);

    const bizName = pick(row, ["business_name"]);
    const firstName = pick(row, ["first_name"]);
    const lastName = pick(row, ["last_name"]);
    const name =
      bizName ||
      [firstName, lastName].filter(Boolean).join(" ") ||
      undefined;
    if (!name) continue;

    const city = pick(row, ["city"]);
    const citySlug = city ? slugify(city) : "";

    const addr1 = pick(row, ["address_1"]);
    const addr2 = pick(row, ["address_2"]);
    const zip = pick(row, ["zip_code"]);
    const addressParts = [addr1, addr2, city ? `${city} IA` : "", zip]
      .map((p) => p.trim())
      .filter(Boolean);
    const address = addressParts.length > 0 ? addressParts.join(", ") : undefined;

    out.push(
      normalise({
        source: "iowa-dial-contractors" as ScrapeSource,
        country: "US",
        sourceId: `iowa-dial:${regNum}`,
        name,
        categoryKey: cat,
        citySlug,
        email: pick(row, ["email_address"]) || undefined,
        phone: normaliseNorthAmericanPhone(pick(row, ["phone"])),
        address,
        licenseNumber: regNum,
        metadata: {
          country: "US",
          state: "IA",
          verified_by_authority: true,
          authority: "Iowa DIAL (Dept. of Inspections, Appeals, and Licensing)",
          naics_code: primaryActivity || undefined,
          county: pick(row, ["county"]) || undefined,
          issued: pick(row, ["issue_date"]) || undefined,
          expires: expireRaw || undefined,
          legal_name: bizName ? [firstName, lastName].filter(Boolean).join(" ") || undefined : undefined,
        },
      }),
    );
  }

  const sink = getSink();
  const res = await sink.upsert(out);
  console.log(
    `[iowa-dial-contractors] done — fetched=${out.length} ` +
      `inserted=${res.inserted} updated=${res.updated} skipped=${res.skipped}`,
  );
  return {
    fetched: out.length,
    inserted: res.inserted,
    updated: res.updated,
    skipped: res.skipped,
  };
}
