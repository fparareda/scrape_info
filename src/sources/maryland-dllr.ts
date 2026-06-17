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
 * Maryland DLLR — Department of Labor, Licensing and Regulation.
 *
 * Bulk CSV via dllr.state.md.us. Override
 * `PROLIO_MARYLAND_DLLR_CSV`. `PROLIO_RUN_MARYLAND_DLLR=true` to enable.
 */

const DEFAULT_URL =
  "https://www.dllr.state.md.us/data/active_licensees.csv";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function boardToCategory(b: string): CategoryKey | undefined {
  const d = b.toLowerCase();
  if (d.includes("electric")) return "electricidad";
  if (d.includes("hvac") || d.includes("air condition") || d.includes("refrigerat") || d.includes("heating"))
    return "hvac";
  if (d.includes("plumb")) return "fontaneria";
  if (d.includes("architect")) return "arquitecto";
  if (d.includes("dent")) return "dentista";
  if (d.includes("physical therap")) return "fisioterapia";
  return undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_MARYLAND_DLLR_CSV || DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[maryland-dllr] network error: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[maryland-dllr] ${response.status} on ${url}`);
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
    const stateRaw = pick(row, ["state"]) || "MD";
    const address = [street, city, stateRaw, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "maryland-dllr",
        country: "US",
        sourceId: `maryland-dllr:${licence}:${category}`,
        name,
        categoryKey: category,
        citySlug,
        phone: normaliseNorthAmericanPhone(pick(row, ["phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: "MD",
          authority: "Maryland DLLR",
          verified_by_authority: true,
          dllr_board: board,
        },
      }),
    );
  }
  console.log(`[maryland-dllr] parsed=${out.length}`);
  return out;
}

export const marylandDllrSource: ScraperSource = {
  name: "maryland-dllr",
  enabled() {
    return process.env.PROLIO_RUN_MARYLAND_DLLR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runMarylandDllr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!marylandDllrSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_MARYLAND_DLLR_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[maryland-dllr] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
