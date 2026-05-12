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
 * Wisconsin DSPS — Department of Safety and Professional Services.
 *
 * Bulk CSV via dsps.wi.gov. Override `PROLIO_WISCONSIN_DSPS_CSV`.
 * `PROLIO_RUN_WISCONSIN_DSPS=true` to enable.
 */

const DEFAULT_URL =
  "https://dsps.wi.gov/Documents/datapublic/active_credentials.csv";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function professionToCategory(p: string): CategoryKey | undefined {
  const d = p.toLowerCase();
  if (d.includes("electric")) return "electricidad";
  if (d.includes("plumb") || d.includes("hvac")) return "fontaneria";
  if (d.includes("architect")) return "arquitecto";
  if (d.includes("dent")) return "dentista";
  if (d.includes("physical therap")) return "fisioterapia";
  if (d.includes("veterinar")) return "veterinario";
  return undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_WISCONSIN_DSPS_CSV || DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[wisconsin-dsps] network error: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[wisconsin-dsps] ${response.status} on ${url}`);
    return [];
  }
  const rows = parseCsv(await response.text());
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const status = pick(row, ["status", "credential_status"]).toLowerCase();
    if (status && !status.includes("active")) continue;
    const licence = pick(row, ["credential_number", "license_number", "license_no"]);
    if (!licence) continue;
    const profession = pick(row, ["profession", "credential_type", "type"]);
    const category = professionToCategory(profession);
    if (!category) continue;
    const city = pick(row, ["city"]);
    const citySlug = slugify(city);
    if (!citySlug) continue;
    const key = `${licence}:${category}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = pick(row, ["business_name", "full_name", "name"]);
    if (!name) continue;
    const street = pick(row, ["address", "street"]);
    const zip = pick(row, ["zip"]);
    const stateRaw = pick(row, ["state"]) || "WI";
    const address = [street, city, stateRaw, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "wisconsin-dsps",
        sourceId: `wisconsin-dsps:${licence}:${category}`,
        name,
        categoryKey: category,
        citySlug,
        phone: normaliseNorthAmericanPhone(pick(row, ["phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: "WI",
          authority: "Wisconsin DSPS",
          verified_by_authority: true,
          dsps_profession: profession,
        },
      }),
    );
  }
  console.log(`[wisconsin-dsps] parsed=${out.length}`);
  return out;
}

export const wisconsinDspsSource: ScraperSource = {
  name: "wisconsin-dsps",
  enabled() {
    return process.env.PROLIO_RUN_WISCONSIN_DSPS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runWisconsinDsps(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!wisconsinDspsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_WISCONSIN_DSPS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[wisconsin-dsps] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
