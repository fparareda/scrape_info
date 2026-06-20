import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick, type SocrataRow } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

/**
 * Washington L&I — Department of Labor & Industries contractor and
 * trades licensee dataset (data.wa.gov, Socrata).
 *
 * Dataset `m8qx-ubtq` ("L&I Contractor License Data - General") on
 * data.wa.gov. ~75k ACTIVE registered construction contractors covering
 * every trade specialty. Updated daily.
 *
 *   https://data.wa.gov/Labor/L-I-Contractor-License-Data-General/m8qx-ubtq
 *
 * Verified (2026-06-19) via `?$limit=1` (HTTP 200). Real columns:
 *   businessname, contractorlicensenumber, contractorlicensetypecodedesc,
 *   specialtycode1desc, address1, city, state, zip, phonenumber,
 *   primaryprincipalname, ubi, contractorlicensestatus (ACTIVE/…).
 *
 * The previous default URL
 * (lni.wa.gov/.../active-contractors.csv) was fabricated and returned no
 * usable rows. Replaced with the real Socrata JSON endpoint.
 *
 * CategoryKey mapping is keyed off `specialtycode1desc` (the contractor's
 * primary specialty), falling back to `contractorlicensetypecodedesc`.
 * Records that match no trade vertical fall back to `carpinteria`
 * (general construction), matching the Iowa DIAL convention.
 *
 * Off by default. Enable via `PROLIO_RUN_WASHINGTON_LI=true`.
 * Cap via `PROLIO_WASHINGTON_LI_LIMIT` (default 80000).
 */

const HOST = "data.wa.gov";
const VIEW_ID = "m8qx-ubtq";
const SOURCE_NAME = "washington-li" as const;
const DEFAULT_LIMIT = 80_000;

const WHERE_CLAUSE = "contractorlicensestatus='ACTIVE'";

function specialtyToCategory(raw: string | undefined): CategoryKey {
  const d = (raw ?? "").toLowerCase();
  if (d.includes("electric") || d.includes("limited energy")) return "electricidad";
  if (
    d.includes("hvac") ||
    d.includes("heating") ||
    d.includes("air-condition") ||
    d.includes("air condition") ||
    d.includes("refrig") ||
    d.includes("boiler")
  )
    return "hvac";
  if (
    d.includes("plumb") ||
    d.includes("drain") ||
    d.includes("piping") ||
    d.includes("backflow") ||
    d.includes("pump")
  )
    return "fontaneria";
  // Everything else (general, masonry, carpentry, roofing, siding, …) →
  // general construction.
  return "carpinteria";
}

function buildName(row: SocrataRow): string | undefined {
  const biz = socrataPick(row, ["businessname", "business_name"]);
  if (biz) return titleCase(biz);
  const principal = socrataPick(row, ["primaryprincipalname"]);
  if (principal) return titleCase(principal);
  return undefined;
}

function buildAddress(row: SocrataRow): string | undefined {
  const parts: string[] = [];
  const street = socrataPick(row, ["address1", "address"]);
  const city = socrataPick(row, ["city"]);
  const state = socrataPick(row, ["state"]) || "WA";
  const zip = socrataPick(row, ["zip", "zip_code"]);
  if (street) parts.push(street);
  if (city) parts.push(city);
  if (state) parts.push(state);
  if (zip) parts.push(zip);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalisePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

interface RunOptions {
  maxRows?: number;
  batchSize?: number;
}

export async function runWashingtonLiBulk(
  client: SupabaseClient,
  opts: RunOptions = {},
): Promise<{ scanned: number; accepted: number; written: number }> {
  const batchSize = opts.batchSize ?? 500;
  const sink = getSink({ trustCitySlugs: true });
  let scanned = 0;
  let accepted = 0;
  let written = 0;
  let buffer: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const res = await sink.upsert(buffer);
    written += res.inserted + res.updated;
    buffer = [];
  };

  const PROGRESS_EVERY = 1000;
  let lastProgressTs = Date.now();

  for await (const page of fetchSocrataJson({
    host: HOST,
    viewId: VIEW_ID,
    pageSize: 1000,
    maxRows: opts.maxRows,
    where: WHERE_CLAUSE,
  })) {
    for (const row of page) {
      if (scanned > 0 && scanned % PROGRESS_EVERY === 0) {
        const cs = getCityUpsertStats();
        const elapsed = ((Date.now() - lastProgressTs) / 1000).toFixed(1);
        console.log(
          `[washington-li] progress scanned=${scanned} accepted=${accepted} written=${written} ` +
            `cities_created=${cs.inserted} +${elapsed}s`,
        );
        lastProgressTs = Date.now();
      }
      scanned += 1;

      const licNum = socrataPick(row, ["contractorlicensenumber", "ubi"]);
      const name = buildName(row);
      const cityRaw = socrataPick(row, ["city"]);
      if (!licNum || !name || !cityRaw) continue;

      const specialty = socrataPick(row, [
        "specialtycode1desc",
        "contractorlicensetypecodedesc",
      ]);
      const category = specialtyToCategory(specialty);

      const dedupeKey = `${licNum}:${category}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const cityResult = await ensureCity(client, {
        name: titleCase(cityRaw),
        state: socrataPick(row, ["state"]) || "WA",
        country: "US",
      });
      if (!cityResult) continue;

      buffer.push({
        source: SOURCE_NAME as ScrapeSource,
        sourceId: `washington-li:${licNum}:${category}`,
        name,
        categoryKey: category,
        country: "US",
        citySlug: cityResult.slug,
        address: buildAddress(row),
        phone: normalisePhone(socrataPick(row, ["phonenumber", "phone"])),
        licenseNumber: licNum,
        metadata: {
          state: "WA",
          country: "US",
          authority: "Washington L&I",
          verified_by_authority: true,
          li_specialty: specialty,
          license_type: socrataPick(row, ["contractorlicensetypecodedesc"]),
          expiration_date: socrataPick(row, ["licenseexpirationdate"]),
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();

  const cs = getCityUpsertStats();
  console.log(
    `[washington-li] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ────────────────────────────────────────────────────

export const washingtonLiSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_WASHINGTON_LI === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runWashingtonLi(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!washingtonLiSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_WASHINGTON_LI_LIMIT ?? DEFAULT_LIMIT);
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runWashingtonLiBulk(client, {
    maxRows,
  });
  console.log(
    `[washington-li] source done — scanned=${scanned} accepted=${accepted} written=${written}`,
  );
  return { fetched: accepted, inserted: written, updated: 0, skipped: scanned - accepted };
}
