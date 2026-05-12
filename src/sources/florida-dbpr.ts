import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * Florida DBPR — Department of Business and Professional Regulation.
 *
 * Florida publishes weekly bulk CSVs of every active licensee per
 * board (Construction Industry Licensing Board / CILB, Electrical
 * Contractors / ECLB, Plumbing covered by CILB, Architecture, etc.).
 * Pre-flight: https://www2.myfloridalicense.com/datadownload/. Each
 * licence type has its own file; this source pulls the construction +
 * electrical sets and routes by `prof_type_desc`.
 *
 * Default URL is a documented entry point but **must be verified on
 * first run**. Override via `PROLIO_FLORIDA_DBPR_CSV` if FL rotates.
 *
 * Off by default. `PROLIO_RUN_FLORIDA_DBPR=true` to enable. Cap via
 * `PROLIO_FLORIDA_DBPR_LIMIT` (default 2000). Sink rejects rows whose
 * city slug isn't seeded in `cities` — that's the safety net for FL
 * cities outside the seed (we accept the drop rather than overshare).
 */

const DEFAULT_URL =
  "https://www2.myfloridalicense.com/datadownload/cilb_certified.csv";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 60_000;

function profTypeToCategory(desc: string): CategoryKey | undefined {
  const d = desc.toLowerCase();
  if (d.includes("electric")) return "electricidad";
  if (d.includes("plumb") || d.includes("mechanical") || d.includes("hvac"))
    return "fontaneria";
  if (d.includes("carpent") || d.includes("finish")) return "carpinteria";
  if (d.includes("architect")) return "arquitecto";
  // CILB "Building Contractor", "General Contractor" → no slot
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
  const url = process.env.PROLIO_FLORIDA_DBPR_CSV || DEFAULT_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(
      `[florida-dbpr] network error: ${(error as Error).message}`,
    );
    return [];
  }
  if (!response.ok) {
    console.error(`[florida-dbpr] ${response.status} on ${url}`);
    return [];
  }
  const text = await response.text();
  const rows = parseCsv(text);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCategory = 0;
  let droppedNoCity = 0;
  let droppedNoLicence = 0;

  for (const row of rows) {
    if (out.length >= limit) break;
    const status = pick(row, ["lic_status", "license_status", "status"]).toLowerCase();
    if (status && !status.includes("active") && !status.includes("current")) continue;

    const licence = pick(row, ["license_nbr", "license_number", "lic_nbr", "license"]);
    if (!licence) {
      droppedNoLicence += 1;
      continue;
    }
    const profType = pick(row, ["prof_type_desc", "license_type", "type", "prof_desc"]);
    const category = profTypeToCategory(profType);
    if (!category) {
      droppedNoCategory += 1;
      continue;
    }

    const city = pick(row, ["city", "primary_city", "addr_city"]);
    const citySlug = slugify(city);
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }

    const dedupeKey = `${licence}:${category}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const name = pick(row, [
      "dba_name",
      "business_name",
      "full_name",
      "primary_name",
      "name",
    ]);
    if (!name) continue;

    const street = pick(row, ["addr_1", "address_1", "street", "addr"]);
    const zip = pick(row, ["zip", "postal_code"]);
    const stateRaw = pick(row, ["state", "primary_state"]) || "FL";
    const address = [street, city, stateRaw, zip].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "florida-dbpr",
        sourceId: `florida-dbpr:${licence}:${category}`,
        name,
        categoryKey: category,
        citySlug,
        phone: normalisePhone(pick(row, ["phone", "primary_phone"])),
        address: address || undefined,
        licenseNumber: licence,
        metadata: {
          country: "US",
          state: stateRaw || "FL",
          authority: "Florida DBPR",
          verified_by_authority: true,
          dbpr_prof_type: profType,
          dbpr_status: status || "ACTIVE",
        },
      }),
    );
  }

  console.log(
    `[florida-dbpr] parsed=${out.length} droppedNoCategory=${droppedNoCategory} droppedNoCity=${droppedNoCity} droppedNoLicence=${droppedNoLicence}`,
  );
  return out;
}

export const floridaDbprSource: ScraperSource = {
  name: "florida-dbpr",
  enabled() {
    return process.env.PROLIO_RUN_FLORIDA_DBPR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runFloridaDbpr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!floridaDbprSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_FLORIDA_DBPR_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[florida-dbpr] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
