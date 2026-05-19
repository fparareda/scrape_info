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
 * New York DOS — Department of State Division of Licensing Services.
 *
 * Bulk CSV at data.ny.gov of active licensees (electricians, locksmiths,
 * security guards, etc.). Override with `PROLIO_NEW_YORK_DOS_CSV`.
 * `PROLIO_RUN_NEW_YORK_DOS=true` to enable.
 */

const DEFAULT_URL =
  "https://data.ny.gov/api/views/8ks6-44gj/rows.csv?accessType=DOWNLOAD";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function licTypeToCategory(t: string): CategoryKey | undefined {
  const d = t.toLowerCase();
  if (d.includes("electric")) return "electricidad";
  if (d.includes("plumb") || d.includes("hvac")) return "fontaneria";
  if (d.includes("locksmith")) return "cerrajero";
  if (d.includes("architect")) return "arquitecto";
  return undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_NEW_YORK_DOS_CSV || DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[new-york-dos] network error: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[new-york-dos] ${response.status} on ${url}`);
    return [];
  }
  const rows = parseCsv(await response.text());
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const status = pick(row, ["license_status", "status"]).toLowerCase();
    if (status && !status.includes("active") && !status.includes("current")) continue;
    const licence = pick(row, ["license_number", "license_no"]);
    if (!licence) continue;
    const licType = pick(row, ["license_type", "type", "license_class"]);
    const category = licTypeToCategory(licType);
    if (!category) continue;
    const city = pick(row, ["city", "business_city"]);
    const citySlug = slugify(city);
    if (!citySlug) continue;
    const key = `${licence}:${category}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = pick(row, [
      "business_name",
      "trade_name",
      "company_name",
      "name",
      "full_name",
    ]);
    if (!name) continue;
    const street = pick(row, ["address", "street", "business_address"]);
    const zip = pick(row, ["zip", "zip_code"]);
    const stateRaw = pick(row, ["state"]) || "NY";
    const address = [street, city, stateRaw, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "new-york-dos",
        country: "US",
        sourceId: `new-york-dos:${licence}:${category}`,
        name,
        categoryKey: category,
        citySlug,
        phone: normaliseNorthAmericanPhone(pick(row, ["phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: "NY",
          authority: "New York DOS",
          verified_by_authority: true,
          dos_license_type: licType,
        },
      }),
    );
  }
  console.log(`[new-york-dos] parsed=${out.length}`);
  return out;
}

export const newYorkDosSource: ScraperSource = {
  name: "new-york-dos",
  enabled() {
    return process.env.PROLIO_RUN_NEW_YORK_DOS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNewYorkDos(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!newYorkDosSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_NEW_YORK_DOS_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[new-york-dos] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
