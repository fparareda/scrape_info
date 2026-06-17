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
 * Virginia DPOR — Department of Professional and Occupational Regulation.
 *
 * Bulk CSV download. Override with `PROLIO_VIRGINIA_DPOR_CSV`.
 * `PROLIO_RUN_VIRGINIA_DPOR=true` to enable.
 */

const DEFAULT_URL =
  "https://www.dpor.virginia.gov/sites/default/files/data/active_licenses.csv";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function specToCategory(s: string): CategoryKey | undefined {
  const d = s.toLowerCase();
  if (d.includes("electric")) return "electricidad";
  if (d.includes("hvac") || d.includes("air condition") || d.includes("refrigerat") || d.includes("heating"))
    return "hvac";
  if (d.includes("plumb")) return "fontaneria";
  if (d.includes("carpent")) return "carpinteria";
  if (d.includes("architect")) return "arquitecto";
  return undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_VIRGINIA_DPOR_CSV || DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[virginia-dpor] network error: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[virginia-dpor] ${response.status} on ${url}`);
    return [];
  }
  const rows = parseCsv(await response.text());
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const status = pick(row, ["status", "license_status"]).toLowerCase();
    if (status && !status.includes("active")) continue;
    const licence = pick(row, ["license_number", "license_no"]);
    if (!licence) continue;
    const spec = pick(row, ["specialty", "license_type", "type", "classification"]);
    const category = specToCategory(spec);
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
    const zip = pick(row, ["zip"]);
    const stateRaw = pick(row, ["state"]) || "VA";
    const address = [street, city, stateRaw, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "virginia-dpor",
        country: "US",
        sourceId: `virginia-dpor:${licence}:${category}`,
        name,
        categoryKey: category,
        citySlug,
        phone: normaliseNorthAmericanPhone(pick(row, ["phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: "VA",
          authority: "Virginia DPOR",
          verified_by_authority: true,
          dpor_specialty: spec,
        },
      }),
    );
  }
  console.log(`[virginia-dpor] parsed=${out.length}`);
  return out;
}

export const virginiaDporSource: ScraperSource = {
  name: "virginia-dpor",
  enabled() {
    return process.env.PROLIO_RUN_VIRGINIA_DPOR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runVirginiaDpor(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!virginiaDporSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_VIRGINIA_DPOR_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[virginia-dpor] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
