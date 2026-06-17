import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, pick } from "./_bulk-utils.js";

/**
 * Vermont Department of Fire Safety (DFS) -- Licensing MasterList.
 *
 * Public Socrata dataset: ~11k active and recently-expired licenses
 * for electricians (Master / Journeyman / Special), plumbers
 * (Master / Journeyman / Special), gas installers, oil installers,
 * and elevator tradespeople. Updated nightly by Vermont DFS.
 *
 * Dataset: https://data.vermont.gov/dataset/DFS-Licensing-MasterList/cy8e-89cz
 * CSV:     https://data.vermont.gov/api/views/cy8e-89cz/rows.csv?accessType=DOWNLOAD
 *
 * robots.txt: /api/views/{id}/rows.csv is not disallowed (only browse, edit, login).
 * Crawl-delay: 1 -- we issue a single bulk download, so no delay needed.
 *
 * Off by default -- set PROLIO_RUN_VERMONT_DFS=true to enable.
 */

const DATASET_URL =
  process.env.PROLIO_VERMONT_DFS_CSV ??
  "https://data.vermont.gov/api/views/cy8e-89cz/rows.csv?accessType=DOWNLOAD";

const DEFAULT_LIMIT = 15_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

/** Map DFS Type Desc to taxonomy CategoryKey. */
function typeToCategory(typeDesc: string): CategoryKey | undefined {
  const t = typeDesc.toLowerCase();
  if (t.includes("electrician")) return "electricidad";
  if (t.includes("plumber")) return "fontaneria";
  if (t.includes("gas installer")) return "fontaneria"; // gas fitting ~ fontaneria
  return undefined;
}

/** Return true when the license expiration date is after today. */
function isActive(expDate: string): boolean {
  if (!expDate) return false;
  // Format: MM/DD/YYYY
  const parts = expDate.split("/");
  if (parts.length !== 3) return false;
  const [month, day, year] = parts;
  const exp = new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
  return exp >= new Date();
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  let response: Response;
  try {
    response = await fetch(DATASET_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    console.error(`[vermont-dfs] network error: ${(err as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[vermont-dfs] HTTP ${response.status} on ${DATASET_URL}`);
    return [];
  }

  const text = await response.text();
  const rows = parseCsv(text);
  console.log(`[vermont-dfs] raw rows=${rows.length}`);

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;

    // Filter to active licenses only
    const expDate = pick(row, ["license_exp_date"]);
    if (!isActive(expDate)) continue;

    const typeDesc = pick(row, ["type_desc"]);
    const category = typeToCategory(typeDesc);
    if (!category) continue;

    const licenseNumber = pick(row, ["license_number"]);
    if (!licenseNumber) continue;

    const city = pick(row, ["city"]);
    const citySlug = slugify(city);
    if (!citySlug) continue;

    const dedupeKey = `${licenseNumber}:${category}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // Compose full name from first + last
    const firstName = pick(row, ["first_name"]);
    const lastName = pick(row, ["last_name"]);
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    if (!fullName) continue;

    const street = pick(row, ["street_address"]);
    const stateCode = pick(row, ["state"]) || "VT";
    const zip = pick(row, ["zip_code"]);
    const address = [street, city, stateCode, zip].filter(Boolean).join(", ");

    const levelDesc = pick(row, ["level_desc"]);

    out.push(
      normalise({
        source: "vermont-dfs",
        country: "US",
        sourceId: `vermont-dfs:${licenseNumber}:${category}`,
        name: fullName,
        categoryKey: category,
        citySlug,
        address: address || undefined,
        licenseNumber,
        metadata: {
          country: "US",
          state: stateCode === "VT" ? "VT" : stateCode,
          authority: "Vermont Department of Fire Safety",
          verified_by_authority: true,
          dfs_type: typeDesc,
          dfs_level: levelDesc,
          license_expiration: expDate,
        },
      }),
    );
  }

  console.log(`[vermont-dfs] parsed=${out.length}`);
  return out;
}

// ---------------------------------------------------------------------------
// ScraperSource wiring
// ---------------------------------------------------------------------------

export function vermontDfsEnabled(): boolean {
  return process.env.PROLIO_RUN_VERMONT_DFS === "true";
}

export const vermontDfsSource: ScraperSource = {
  name: "vermont-dfs",
  enabled: vermontDfsEnabled,
  async fetch(_target) {
    return [];
  },
};

export async function runVermontDfs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!vermontDfsEnabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_VERMONT_DFS_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[vermont-dfs] done -- fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
