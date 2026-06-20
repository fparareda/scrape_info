import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import {
  parseCsv,
  pick,
  normaliseNorthAmericanPhone,
} from "./_bulk-utils.js";

/**
 * Oregon BCD — Building Codes Division individual trade licenses.
 *
 * The Oregon Building Codes Division (BCD) licenses individual trade
 * workers: journeyman and master electricians, plumbers, boiler
 * operators, and elevator mechanics.  This is *distinct* from the
 * Oregon CCB (Construction Contractors Board), which licenses
 * contractor *businesses* — different agency, different licence
 * numbers, non-overlapping licensee population.
 *
 * Source: Socrata SODA v2.1 CSV endpoint at data.oregon.gov.
 * Dataset ID: vhbr-cuaq ("Building Codes Division - Licensees").
 *
 * Pre-flight 2026-05-30:
 *   - data.oregon.gov robots.txt disallows /api/odata/, /api/collocate*
 *     and browse navigation query-strings; /resource/ is unrestricted.
 *   - ~48,970 active records:
 *       Electrical (29,672) → `electricidad`
 *       Plumbing   (6,451)  → `fontaneria`
 *       Boiler/HVAC (3,302) → `hvac`
 *       Elevator   (~2k)    → skipped (no taxonomy match)
 *   - Free Socrata SODA API; no auth, no captcha.
 *   - Paging: $limit + $offset (2 000/page → 25 pages for full set).
 *
 * Env:
 *   PROLIO_RUN_OREGON_BCD=true           enable
 *   PROLIO_OREGON_BCD_LIMIT=20000        cap (default)
 *   PROLIO_OREGON_BCD_CSV                override CSV URL
 *
 * Off by default. Monthly cron: scrape-oregon-bcd.yml (annual data).
 */

const SOCRATA_BASE =
  "https://data.oregon.gov/resource/vhbr-cuaq.csv";
const PAGE_SIZE = 2_000;
const DEFAULT_LIMIT = 20_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function licenseTypeToCategory(raw: string): CategoryKey | undefined {
  const d = raw.toLowerCase();
  if (d.includes("electric")) return "electricidad";
  if (
    d.includes("plumb") ||
    d.includes("gas fitter") ||
    d.includes("gasfitter")
  )
    return "fontaneria";
  if (
    d.includes("boiler") ||
    d.includes("hvac") ||
    d.includes("refrigerat") ||
    d.includes("heat") ||
    d.includes("mechanical")
  )
    return "hvac";
  return undefined;
}

async function fetchPage(
  url: string,
  offset: number,
): Promise<Array<Record<string, string>> | null> {
  const sep = url.includes("?") ? "&" : "?";
  const pageUrl = `${url}${sep}$limit=${PAGE_SIZE}&$offset=${offset}&$where=lic_status='Active'`;
  try {
    const response = await fetch(pageUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/csv" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      console.error(`[oregon-bcd] HTTP ${response.status} on ${pageUrl}`);
      return null;
    }
    const text = await response.text();
    if (!text.trim()) return [];
    return parseCsv(text);
  } catch (error) {
    console.error(
      `[oregon-bcd] network error: ${(error as Error).message}`,
    );
    return null;
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const base = process.env.PROLIO_OREGON_BCD_CSV ?? SOCRATA_BASE;
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let droppedNoCategory = 0;
  let droppedNoCity = 0;
  let droppedNoLicence = 0;

  while (out.length < limit) {
    const rows = await fetchPage(base, offset);
    if (rows === null) break;
    if (rows.length === 0) break;

    for (const row of rows) {
      if (out.length >= limit) break;
      const licType = pick(row, [
        "profession",
        "license_type",
        "lic_type",
        "type",
        "endorsement",
        "classification",
      ]);
      const category = licenseTypeToCategory(licType);
      if (!category) {
        droppedNoCategory += 1;
        continue;
      }
      const licNum = pick(row, [
        "licnbr",
        "lic_nbr",
        "lic_number",
        "license_number",
        "licence_number",
        "license_no",
        "lic_no",
        "cert_number",
      ]);
      if (!licNum) {
        droppedNoLicence += 1;
        continue;
      }
      const city = pick(row, ["city", "lic_city", "license_city"]);
      const citySlug = slugify(city);
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }
      const dedupeKey = `${licNum}:${category}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const name = pick(row, [
        "full_name",
        "dba",
        "lic_holder",
        "holder_name",
        "business_name",
        "name",
        "licensee_name",
        "first_name",
      ]);
      if (!name) continue;
      const street = pick(row, [
        "addr1",
        "address",
        "lic_address",
        "street",
        "street_address",
      ]);
      const zip = pick(row, ["zipcode", "zip", "zip_code", "postal_code"]);
      const stateRaw = pick(row, ["state", "lic_state"]) || "OR";
      const address = [street, city, stateRaw, zip]
        .filter(Boolean)
        .join(", ");

      out.push(
        normalise({
          source: "oregon-bcd",
          country: "US",
          sourceId: `oregon-bcd:${licNum}:${category}`,
          name,
          categoryKey: category,
          citySlug,
          phone: normaliseNorthAmericanPhone(
            pick(row, ["phone", "phone_number", "lic_phone"]),
          ),
          address: address || undefined,
          licenseNumber: licNum,
          metadata: {
            country: "US",
            state: "OR",
            authority: "Oregon BCD",
            verified_by_authority: true,
            license_type: licType,
            expiration_date:
              pick(row, ["exp_date", "expiration_date", "lic_exp_date"]) ||
              undefined,
          },
        }),
      );
    }

    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log(
    `[oregon-bcd] parsed=${out.length} ` +
      `droppedNoCategory=${droppedNoCategory} ` +
      `droppedNoCity=${droppedNoCity} ` +
      `droppedNoLicence=${droppedNoLicence}`,
  );
  return out;
}

export const oregonBcdSource: ScraperSource = {
  name: "oregon-bcd",
  enabled() {
    return process.env.PROLIO_RUN_OREGON_BCD === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOregonBcd(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!oregonBcdSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_OREGON_BCD_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[oregon-bcd] done — fetched=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
