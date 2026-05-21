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
 * Arizona ROC — Registrar of Contractors.
 *
 * Public dataset: ~50k active commercial + residential contractors
 * (electrical L-11/C-11, plumbing L-37/C-37, HVAC L-39/C-39, etc.).
 * Default endpoint must be verified on first run; override with
 * `PROLIO_ARIZONA_ROC_CSV`. Off by default, `PROLIO_RUN_ARIZONA_ROC=true`.
 */

const DEFAULT_URL =
  "https://roc.az.gov/sites/default/files/data/active_licenses.csv";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function classToCategory(klass: string): CategoryKey | undefined {
  const k = klass.toLowerCase();
  if (k.includes("electric") || /\b[lc]-?11\b/.test(k)) return "electricidad";
  if (k.includes("hvac") || k.includes("air condition") || k.includes("refrigerat") || k.includes("heating") || /\b[lc]-?39\b/.test(k))
    return "hvac";
  if (k.includes("plumb") || /\b[lc]-?37\b/.test(k)) return "fontaneria";
  if (k.includes("carpent") || k.includes("finish")) return "carpinteria";
  return undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_ARIZONA_ROC_CSV || DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[arizona-roc] network error: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[arizona-roc] ${response.status} on ${url}`);
    return [];
  }
  const rows = parseCsv(await response.text());
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const status = pick(row, ["status", "license_status"]).toLowerCase();
    if (status && !status.includes("active")) continue;
    const licence = pick(row, ["license_number", "license_no", "licence", "license"]);
    if (!licence) continue;
    const klass = pick(row, ["classification", "license_type", "class", "type"]);
    const category = classToCategory(klass);
    if (!category) continue;
    const city = pick(row, ["city", "business_city"]);
    const citySlug = slugify(city);
    if (!citySlug) continue;
    const key = `${licence}:${category}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = pick(row, ["business_name", "company_name", "name", "dba"]);
    if (!name) continue;
    const street = pick(row, ["address", "street", "business_address"]);
    const zip = pick(row, ["zip", "zip_code"]);
    const stateRaw = pick(row, ["state"]) || "AZ";
    const address = [street, city, stateRaw, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "arizona-roc",
        sourceId: `arizona-roc:${licence}:${category}`,
        name,
        categoryKey: category,
        citySlug,
        phone: normaliseNorthAmericanPhone(pick(row, ["phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: "AZ",
          authority: "Arizona ROC",
          verified_by_authority: true,
          roc_classification: klass,
        },
      }),
    );
  }
  console.log(`[arizona-roc] parsed=${out.length}`);
  return out;
}

export const arizonaRocSource: ScraperSource = {
  name: "arizona-roc",
  enabled() {
    return process.env.PROLIO_RUN_ARIZONA_ROC === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runArizonaRoc(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!arizonaRocSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_ARIZONA_ROC_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[arizona-roc] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
