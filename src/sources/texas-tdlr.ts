import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * Texas TDLR — Department of Licensing and Regulation.
 *
 * TDLR licenses ~30 occupations including electricians, air-condition
 * contractors (HVAC), elevator inspectors and tow operators. Data is
 * published on data.texas.gov as a CSV ("Active Licensees").
 *
 * Default URL is documented but **must be verified on first run**.
 * Override with `PROLIO_TEXAS_TDLR_CSV`. Off by default;
 * `PROLIO_RUN_TEXAS_TDLR=true` to enable. Cap via
 * `PROLIO_TEXAS_TDLR_LIMIT` (default 2000).
 */

const DEFAULT_URL =
  "https://data.texas.gov/api/views/7358-krk7/rows.csv?accessType=DOWNLOAD";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function licenseTypeToCategory(desc: string): CategoryKey | undefined {
  const d = desc.toLowerCase();
  if (d.includes("electric")) return "electricidad";
  if (d.includes("hvac") || d.includes("air condition") || d.includes("acr"))
    return "fontaneria";
  if (d.includes("plumb")) return "fontaneria";
  if (d.includes("locksmith")) return "cerrajero";
  return undefined;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') inQuotes = false;
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = (cells[j] ?? "").trim();
    }
    out.push(row);
  }
  return out;
}

function pick(row: Record<string, string>, candidates: string[]): string {
  for (const k of candidates) if (row[k]) return row[k];
  for (const k of Object.keys(row)) {
    for (const c of candidates) {
      if (k.includes(c) && row[k]) return row[k];
    }
  }
  return "";
}

function normalisePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const url = process.env.PROLIO_TEXAS_TDLR_CSV || DEFAULT_URL;
  let response: Response;
  try {
    // Texas TDLR CSV is ~50 MB+. The default 60 s timeout aborted on
    // first dispatch (observed 2026-05-07). Bumped to 4 min to leave
    // headroom on slower runners.
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(240_000),
    });
  } catch (error) {
    console.error(`[texas-tdlr] network error: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[texas-tdlr] ${response.status} on ${url}`);
    return [];
  }
  const text = await response.text();
  const rows = parseCsv(text);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const status = pick(row, ["license_status", "status"]).toLowerCase();
    if (status && !status.includes("active") && !status.includes("current"))
      continue;

    const licence = pick(row, ["license_number", "license_no", "license"]);
    if (!licence) continue;
    const licType = pick(row, ["license_type", "license_subtype", "type"]);
    const category = licenseTypeToCategory(licType);
    if (!category) continue;

    // Texas CSV combines "BUSINESS CITY, STATE ZIP" into a single
    // column (after normaliseHeaderKey it becomes
    // `business_city_state_zip` and the value is e.g. "AUSTIN, TX 78701").
    // Split on comma, take the first segment as the city. Fall back
    // to the simpler `city` columns if a future schema separates them.
    const cityRaw =
      pick(row, ["city", "owner_city", "business_city"]) ||
      pick(row, ["business_city_state_zip", "mailing_address_city_state_zip"]);
    const cityName = cityRaw.split(",")[0]?.trim() ?? "";
    const citySlug = slugify(cityName);
    if (!citySlug) continue;

    const key = `${licence}:${category}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = pick(row, [
      "business_name",
      "owner_name",
      "company_name",
      "name",
      "full_name",
    ]);
    if (!name) continue;

    const street = pick(row, [
      "business_address_line1",
      "address",
      "street",
      "owner_address",
    ]);
    const stateRaw = "TX";
    // The combined column already contains city+state+zip; reuse it as
    // the "address" tail rather than re-concatenating bits we don't
    // have separately.
    const address = [street, cityRaw].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "texas-tdlr",
        sourceId: `texas-tdlr:${licence}:${category}`,
        name,
        categoryKey: category,
        citySlug,
        phone: normalisePhone(pick(row, ["phone", "owner_phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: stateRaw || "TX",
          authority: "Texas TDLR",
          verified_by_authority: true,
          tdlr_license_type: licType,
          tdlr_status: status || "ACTIVE",
        },
      }),
    );
  }

  console.log(`[texas-tdlr] parsed=${out.length}`);
  return out;
}

export const texasTdlrSource: ScraperSource = {
  name: "texas-tdlr",
  enabled() {
    return process.env.PROLIO_RUN_TEXAS_TDLR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runTexasTdlr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!texasTdlrSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_TEXAS_TDLR_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[texas-tdlr] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
