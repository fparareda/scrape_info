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
 * Oregon CCB — Construction Contractors Board.
 *
 * CCB licenses general and specialty construction contractors. Bulk
 * CSV download at oregon.gov/ccb/about/Pages/CCBData.aspx.
 *
 * Default endpoint must be verified on first run; override with
 * `PROLIO_OREGON_CCB_CSV`. `PROLIO_RUN_OREGON_CCB=true` to enable.
 */

const DEFAULT_URL =
  "https://www.oregon.gov/ccb/Documents/Active_Licensees.csv";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function endorsementToCategory(e: string): CategoryKey | undefined {
  const d = e.toLowerCase();
  if (d.includes("electric")) return "electricidad";
  if (d.includes("hvac") || d.includes("mechanical") || d.includes("heating") || d.includes("air condition") || d.includes("refrigerat"))
    return "hvac";
  if (d.includes("plumb")) return "fontaneria";
  if (d.includes("carpent") || d.includes("finish")) return "carpinteria";
  return undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_OREGON_CCB_CSV || DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[oregon-ccb] network error: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[oregon-ccb] ${response.status} on ${url}`);
    return [];
  }
  const rows = parseCsv(await response.text());
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const status = pick(row, ["status", "license_status"]).toLowerCase();
    if (status && !status.includes("active")) continue;
    const licence = pick(row, ["license_number", "license_no", "ccb_number"]);
    if (!licence) continue;
    const endorsement = pick(row, [
      "endorsement",
      "license_type",
      "classification",
      "type",
    ]);
    const category = endorsementToCategory(endorsement);
    if (!category) continue;
    const city = pick(row, ["city"]);
    const citySlug = slugify(city);
    if (!citySlug) continue;
    const key = `${licence}:${category}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = pick(row, ["business_name", "company_name", "name", "dba"]);
    if (!name) continue;
    const street = pick(row, ["address", "street"]);
    const zip = pick(row, ["zip", "zip_code"]);
    const stateRaw = pick(row, ["state"]) || "OR";
    const address = [street, city, stateRaw, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "oregon-ccb",
        country: "US",
        sourceId: `oregon-ccb:${licence}:${category}`,
        name,
        categoryKey: category,
        citySlug,
        phone: normaliseNorthAmericanPhone(pick(row, ["phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: "OR",
          authority: "Oregon CCB",
          verified_by_authority: true,
          ccb_endorsement: endorsement,
        },
      }),
    );
  }
  console.log(`[oregon-ccb] parsed=${out.length}`);
  return out;
}

export const oregonCcbSource: ScraperSource = {
  name: "oregon-ccb",
  enabled() {
    return process.env.PROLIO_RUN_OREGON_CCB === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOregonCcb(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!oregonCcbSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_OREGON_CCB_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[oregon-ccb] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
