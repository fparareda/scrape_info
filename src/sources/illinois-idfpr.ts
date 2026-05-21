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
 * Illinois IDFPR — Department of Financial and Professional Regulation.
 *
 * Bulk CSV download of active licensees across 200+ professions.
 * Default endpoint must be verified on first run; override with
 * `PROLIO_ILLINOIS_IDFPR_CSV`. `PROLIO_RUN_ILLINOIS_IDFPR=true` to enable.
 */

const DEFAULT_URL =
  "https://idfpr.illinois.gov/content/dam/soi/en/web/idfpr/applications/licenselookup/active_licenses.csv";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function professionToCategory(p: string): CategoryKey | undefined {
  const d = p.toLowerCase();
  if (d.includes("electric")) return "electricidad";
  if (d.includes("hvac") || d.includes("mechanical") || d.includes("air condition") || d.includes("refrigerat") || d.includes("heating"))
    return "hvac";
  if (d.includes("plumb")) return "fontaneria";
  if (d.includes("carpent")) return "carpinteria";
  if (d.includes("architect")) return "arquitecto";
  if (d.includes("dentist")) return "dentista";
  if (d.includes("physical therap")) return "fisioterapia";
  if (d.includes("veterinar")) return "veterinario";
  if (d.includes("locksmith")) return "cerrajero";
  return undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_ILLINOIS_IDFPR_CSV || DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[illinois-idfpr] network error: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[illinois-idfpr] ${response.status} on ${url}`);
    return [];
  }
  const rows = parseCsv(await response.text());
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const status = pick(row, ["status", "license_status"]).toLowerCase();
    if (status && !status.includes("active")) continue;
    const licence = pick(row, ["license_number", "license_no", "licensenumber"]);
    if (!licence) continue;
    const profession = pick(row, ["profession", "license_type", "type"]);
    const category = professionToCategory(profession);
    if (!category) continue;
    const city = pick(row, ["city", "addr_city"]);
    const citySlug = slugify(city);
    if (!citySlug) continue;
    const key = `${licence}:${category}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = pick(row, ["business_name", "company_name", "full_name", "name"]);
    if (!name) continue;
    const street = pick(row, ["address", "street"]);
    const zip = pick(row, ["zip", "zip_code"]);
    const stateRaw = pick(row, ["state"]) || "IL";
    const address = [street, city, stateRaw, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "illinois-idfpr",
        sourceId: `illinois-idfpr:${licence}:${category}`,
        name,
        categoryKey: category,
        citySlug,
        phone: normaliseNorthAmericanPhone(pick(row, ["phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: "IL",
          authority: "Illinois IDFPR",
          verified_by_authority: true,
          idfpr_profession: profession,
        },
      }),
    );
  }
  console.log(`[illinois-idfpr] parsed=${out.length}`);
  return out;
}

export const illinoisIdfprSource: ScraperSource = {
  name: "illinois-idfpr",
  enabled() {
    return process.env.PROLIO_RUN_ILLINOIS_IDFPR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runIllinoisIdfpr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!illinoisIdfprSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_ILLINOIS_IDFPR_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[illinois-idfpr] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
