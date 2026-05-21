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
 * North Carolina — Licensing Board for General Contractors (NCLBGC),
 * State Board of Examiners of Electrical Contractors (NCBEEC), and
 * State Board of Plumbing/Heating/Fire Sprinkler Contractors. Default
 * URL targets the NCLBGC active list; override with
 * `PROLIO_NORTH_CAROLINA_LBC_CSV`. `PROLIO_RUN_NORTH_CAROLINA_LBC=true`.
 */

const DEFAULT_URL =
  "https://nclbgc.org/wp-content/uploads/license-data/active_licensees.csv";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function classToCategory(k: string): CategoryKey | undefined {
  const d = k.toLowerCase();
  if (d.includes("electric")) return "electricidad";
  if (d.includes("hvac") || d.includes("mechanical") || d.includes("heating") || d.includes("air condition") || d.includes("refrigerat"))
    return "hvac";
  if (d.includes("plumb")) return "fontaneria";
  if (d.includes("carpent")) return "carpinteria";
  return undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_NORTH_CAROLINA_LBC_CSV || DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(
      `[north-carolina-lbc] network error: ${(error as Error).message}`,
    );
    return [];
  }
  if (!response.ok) {
    console.error(`[north-carolina-lbc] ${response.status} on ${url}`);
    return [];
  }
  const rows = parseCsv(await response.text());
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const status = pick(row, ["status", "license_status"]).toLowerCase();
    if (status && !status.includes("active")) continue;
    const licence = pick(row, ["license_number", "license_no", "lic_number"]);
    if (!licence) continue;
    const klass = pick(row, ["classification", "license_type", "type", "class"]);
    const category = classToCategory(klass);
    if (!category) continue;
    const city = pick(row, ["city"]);
    const citySlug = slugify(city);
    if (!citySlug) continue;
    const key = `${licence}:${category}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = pick(row, ["company_name", "business_name", "name", "dba"]);
    if (!name) continue;
    const street = pick(row, ["address", "street"]);
    const zip = pick(row, ["zip"]);
    const stateRaw = pick(row, ["state"]) || "NC";
    const address = [street, city, stateRaw, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "north-carolina-lbc",
        country: "US",
        sourceId: `north-carolina-lbc:${licence}:${category}`,
        name,
        categoryKey: category,
        citySlug,
        phone: normaliseNorthAmericanPhone(pick(row, ["phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: "NC",
          authority: "NC Licensing Boards",
          verified_by_authority: true,
          nc_classification: klass,
        },
      }),
    );
  }
  console.log(`[north-carolina-lbc] parsed=${out.length}`);
  return out;
}

export const northCarolinaLbcSource: ScraperSource = {
  name: "north-carolina-lbc",
  enabled() {
    return process.env.PROLIO_RUN_NORTH_CAROLINA_LBC === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNorthCarolinaLbc(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!northCarolinaLbcSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_NORTH_CAROLINA_LBC_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[north-carolina-lbc] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
