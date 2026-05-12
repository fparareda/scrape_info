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
 * Pennsylvania — Bureau of Professional and Occupational Affairs (BPOA).
 *
 * Bulk CSV at pals.pa.gov of active licensees across 29 professional
 * boards. Override `PROLIO_PENNSYLVANIA_BPOA_CSV`.
 * `PROLIO_RUN_PENNSYLVANIA_BPOA=true`.
 */

const DEFAULT_URL =
  "https://www.pals.pa.gov/data/active_licensees.csv";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function boardToCategory(b: string): CategoryKey | undefined {
  const d = b.toLowerCase();
  if (d.includes("architect")) return "arquitecto";
  if (d.includes("dent")) return "dentista";
  if (d.includes("physical therap")) return "fisioterapia";
  if (d.includes("veterinar")) return "veterinario";
  // PA contractor licensing happens at municipal level (Philly, Pittsburgh)
  // — BPOA itself doesn't license electricians/plumbers state-wide. We
  // capture the regulated professions BPOA does cover.
  return undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_PENNSYLVANIA_BPOA_CSV || DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[pennsylvania-bpoa] network error: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[pennsylvania-bpoa] ${response.status} on ${url}`);
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
    const board = pick(row, ["board", "license_type", "profession"]);
    const category = boardToCategory(board);
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
    const stateRaw = pick(row, ["state"]) || "PA";
    const address = [street, city, stateRaw, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "pennsylvania-bpoa",
        sourceId: `pennsylvania-bpoa:${licence}:${category}`,
        name,
        categoryKey: category,
        citySlug,
        phone: normaliseNorthAmericanPhone(pick(row, ["phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: "PA",
          authority: "Pennsylvania BPOA",
          verified_by_authority: true,
          bpoa_board: board,
        },
      }),
    );
  }
  console.log(`[pennsylvania-bpoa] parsed=${out.length}`);
  return out;
}

export const pennsylvaniaBpoaSource: ScraperSource = {
  name: "pennsylvania-bpoa",
  enabled() {
    return process.env.PROLIO_RUN_PENNSYLVANIA_BPOA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runPennsylvaniaBpoa(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!pennsylvaniaBpoaSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_PENNSYLVANIA_BPOA_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[pennsylvania-bpoa] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
