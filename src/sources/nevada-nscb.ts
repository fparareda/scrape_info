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
 * Nevada NSCB — State Contractors Board.
 *
 * NSCB licenses ~20k contractors across 30+ classifications (C-2
 * Electrical, C-1 Plumbing, etc.). Bulk export at nscb.nv.gov.
 *
 * Default endpoint must be verified on first run; override with
 * `PROLIO_NEVADA_NSCB_CSV`. `PROLIO_RUN_NEVADA_NSCB=true` to enable.
 */

const DEFAULT_URL =
  "https://www.nscb.nv.gov/sites/default/files/active_licensees.csv";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function classToCategory(klass: string): CategoryKey | undefined {
  const k = klass.toLowerCase();
  if (k.includes("electric") || /\bc-?2\b/.test(k)) return "electricidad";
  if (k.includes("hvac") || k.includes("refrig") || k.includes("air condition") || k.includes("heating") || /\bc-?21\b/.test(k))
    return "hvac";
  if (k.includes("plumb") || /\bc-?1\b/.test(k)) return "fontaneria";
  if (k.includes("carpent") || k.includes("finish")) return "carpinteria";
  return undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_NEVADA_NSCB_CSV || DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[nevada-nscb] network error: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[nevada-nscb] ${response.status} on ${url}`);
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
    const klass = pick(row, ["classification", "license_type", "class", "type"]);
    const category = classToCategory(klass);
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
    const stateRaw = pick(row, ["state"]) || "NV";
    const address = [street, city, stateRaw, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "nevada-nscb",
        country: "US",
        sourceId: `nevada-nscb:${licence}:${category}`,
        name,
        categoryKey: category,
        citySlug,
        phone: normaliseNorthAmericanPhone(pick(row, ["phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: "NV",
          authority: "Nevada NSCB",
          verified_by_authority: true,
          nscb_classification: klass,
        },
      }),
    );
  }
  console.log(`[nevada-nscb] parsed=${out.length}`);
  return out;
}

export const nevadaNscbSource: ScraperSource = {
  name: "nevada-nscb",
  enabled() {
    return process.env.PROLIO_RUN_NEVADA_NSCB === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNevadaNscb(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!nevadaNscbSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_NEVADA_NSCB_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[nevada-nscb] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
