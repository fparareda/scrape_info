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
 * Texas TDLR — Department of Licensing and Regulation.
 *
 * Bulk file index: https://www.tdlr.texas.gov/LicenseSearch/licfile.asp
 *
 * The previous implementation pointed at a data.texas.gov endpoint
 * (`7358-krk7`) which returned 0 rows (no longer published in that
 * shape). We now pull per-trade CSVs directly from the TDLR
 * `dbproduction2/` bulk drop, which is the authoritative source the
 * licfile.asp index links to and is refreshed daily.
 *
 * Strategy: instead of fetching the 181 MB combined master file
 * (`ltlicfile.csv`, ~3 M rows) we pull one focused CSV per
 * prolio-relevant category. This keeps the per-runner footprint under
 * ~5 MB per category and lets us short-circuit cleanly when a
 * category exceeds the limit.
 *
 * Trades covered:
 *   - electricidad → Electrical Contractors  (Lteecele.csv, ~3.75 MB)
 *                   + Electrical Sign Contractors (Ltescele.csv, ~0.18 MB)
 *   - hvac        → A/C Contractors          (ltairref.csv, ~3.62 MB)
 *   - mecanica    → Tow Truck Companies      (TowCompanies.csv, ~1.08 MB)
 *                   + Vehicle Storage Facilities (VSFs.csv, ~0.56 MB)
 *
 * Texas TDLR does NOT license plumbers (TSBPE handles plumbing — see
 * separate source), locksmiths (DPS PSB), or vehicle inspection
 * stations (DPS), so those CategoryKeys have no TDLR feed and are
 * intentionally absent.
 *
 * Off by default. Set `PROLIO_RUN_TEXAS_TDLR=true` to enable. Cap via
 * `PROLIO_TEXAS_TDLR_LIMIT` (default 2000, applied across all
 * categories combined).
 */

const BULK_BASE = "https://www.tdlr.texas.gov/dbproduction2/";
const DEFAULT_LIMIT = 2000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 240_000;

interface Feed {
  file: string;
  category: CategoryKey;
  /** TDLR ships two schema families; tow/VSF use the alt one. */
  schema: "license" | "certificate";
  /** Human label for logs / metadata. */
  label: string;
}

const FEEDS: Feed[] = [
  {
    file: "Lteecele.csv",
    category: "electricidad",
    schema: "license",
    label: "Electrical Contractors",
  },
  {
    file: "Ltescele.csv",
    category: "electricidad",
    schema: "license",
    label: "Electrical Sign Contractors",
  },
  {
    file: "ltairref.csv",
    category: "hvac",
    schema: "license",
    label: "A/C Contractors",
  },
  {
    file: "TowCompanies.csv",
    category: "mecanica",
    schema: "certificate",
    label: "Tow Truck Companies",
  },
  {
    file: "VSFs.csv",
    category: "mecanica",
    schema: "certificate",
    label: "Vehicle Storage Facilities",
  },
];

async function fetchCsv(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[texas-tdlr] ${response.status} on ${url}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    console.error(
      `[texas-tdlr] network error on ${url}: ${(error as Error).message}`,
    );
    return null;
  }
}

function parseCityStateZip(combined: string): {
  city: string;
  zip: string;
} {
  // "HOUSTON TX 77031-2516" or "HOUSTON TX 77031" → city="HOUSTON", zip
  // We strip the trailing state+zip and treat the rest as the city.
  // Texas TDLR emits these with NO comma between city and state.
  const m = combined.match(/^(.*?)\s+TX\s+(\d{5})(?:-\d{4})?\s*$/i);
  if (m) return { city: m[1].trim(), zip: m[2] };
  // Fallback: take everything before the last space-separated token
  // that looks like a state/zip.
  return { city: combined.split(/\s+TX\s+/i)[0]?.trim() ?? "", zip: "" };
}

function mapLicenseRow(
  row: Record<string, string>,
  feed: Feed,
): ScrapedProfessional | null {
  const licence = pick(row, ["license_number"]);
  if (!licence) return null;
  const name =
    pick(row, ["business_name"]) || pick(row, ["name"]);
  if (!name) return null;

  const cityStateZip =
    pick(row, ["business_city_state_zip"]) ||
    pick(row, ["mailing_address_city_state_zip"]);
  const { city: cityName } = parseCityStateZip(cityStateZip);
  const citySlug = slugify(cityName);
  if (!citySlug) return null;

  const street =
    pick(row, ["business_address_line1"]) ||
    pick(row, ["mailing_address_line1"]);
  const address = [street, cityStateZip].filter(Boolean).join(", ");
  const phone =
    normaliseNorthAmericanPhone(pick(row, ["business_phone"])) ||
    normaliseNorthAmericanPhone(pick(row, ["phone_number"]));
  const licType = pick(row, ["license_type"]);
  const subType = pick(row, ["license_subtype"]);

  return normalise({
    source: "texas-tdlr",
    country: "US",
    sourceId: `texas-tdlr:${licence}:${feed.category}`,
    name,
    categoryKey: feed.category,
    citySlug,
    phone,
    address: address || undefined,
    licenseNumber: String(licence),
    metadata: {
      country: "US",
      state: "TX",
      authority: "Texas TDLR",
      verified_by_authority: true,
      tdlr_license_type: licType || feed.label,
      tdlr_license_subtype: subType || undefined,
      tdlr_feed: feed.file,
    },
  });
}

function mapCertificateRow(
  row: Record<string, string>,
  feed: Feed,
): ScrapedProfessional | null {
  const certNo = pick(row, ["certificate_number"]);
  if (!certNo) return null;
  const name =
    pick(row, ["customer_dba_name"]) ||
    pick(row, ["customer_name"]);
  if (!name) return null;

  const cityName =
    pick(row, ["site_city"]) || pick(row, ["mail_city"]);
  const citySlug = slugify(cityName);
  if (!citySlug) return null;

  const stateRaw =
    pick(row, ["site_state"]) || pick(row, ["mail_state"]) || "TX";
  // Skip out-of-state filings (rare but possible).
  if (stateRaw.toUpperCase() !== "TX") return null;

  const zipPrefix =
    pick(row, ["site_zip_prefix"]) || pick(row, ["mail_zip_prefix"]);
  const zipSuffix =
    pick(row, ["site_zip_suffix"]) || pick(row, ["mail_zip_suffix"]);
  const zip =
    zipPrefix && zipSuffix
      ? `${zipPrefix}-${zipSuffix}`
      : zipPrefix || "";
  const street =
    pick(row, ["site_addr1"]) || pick(row, ["mail_addr_line1"]);
  const address = [street, cityName, stateRaw, zip]
    .filter(Boolean)
    .join(", ");
  const phone = normaliseNorthAmericanPhone(pick(row, ["phone"]));
  const certType = pick(row, ["certificate_type"]) || feed.label;

  return normalise({
    source: "texas-tdlr",
    country: "US",
    sourceId: `texas-tdlr:${certNo}:${feed.category}`,
    name,
    categoryKey: feed.category,
    citySlug,
    phone,
    address: address || undefined,
    licenseNumber: String(certNo),
    metadata: {
      country: "US",
      state: "TX",
      authority: "Texas TDLR",
      verified_by_authority: true,
      tdlr_license_type: certType,
      tdlr_feed: feed.file,
    },
  });
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  const perFeedLimit = Math.max(100, Math.ceil(limit / FEEDS.length) * 2);

  for (const feed of FEEDS) {
    if (out.length >= limit) break;
    const url = `${BULK_BASE}${feed.file}`;
    const text = await fetchCsv(url);
    if (!text) continue;
    const rows = parseCsv(text);
    let kept = 0;
    let skippedNoCity = 0;
    for (const row of rows) {
      if (out.length >= limit) break;
      if (kept >= perFeedLimit) break;
      const mapped =
        feed.schema === "license"
          ? mapLicenseRow(row, feed)
          : mapCertificateRow(row, feed);
      if (!mapped) {
        skippedNoCity += 1;
        continue;
      }
      if (seen.has(mapped.sourceId)) continue;
      seen.add(mapped.sourceId);
      out.push(mapped);
      kept += 1;
    }
    console.log(
      `[texas-tdlr] ${feed.file} (${feed.label}) — rows=${rows.length} kept=${kept} dropped=${skippedNoCity}`,
    );
  }

  console.log(`[texas-tdlr] parsed total=${out.length}`);
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
