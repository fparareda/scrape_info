/**
 * Montgomery County (MD) Master Electrician License — pilot source for
 * the catalog.data.gov ingestion path.
 *
 * Dataset: https://catalog.data.gov/dataset/master-electrician-license
 * Socrata view: data.montgomerycountymd.gov / v8mn-6i2r
 * Refresh cadence: daily.
 *
 * Why this is the pilot:
 *   - Multi-state coverage (MD primary, plus VA/DC/PA via reciprocal
 *     licenses) → exercises the auto-create-cities flow end-to-end.
 *   - Per-row `geolocation` field means we skip OSM Nominatim for most
 *     cities → fast pilot run.
 *   - Maps cleanly to the existing `electricidad` CategoryKey, no
 *     schema changes needed.
 *   - Small dataset (~5-15k rows) → fast iteration.
 *
 * Validates: (a) Socrata paging, (b) city-upsert + geolocation
 * passthrough, (c) sink with trustCitySlugs, (d) source enum + runner
 * plumbing. Once green, replicating to WA L&I / NY DOS / Philly /
 * Chicago is mostly column mapping.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick, type SocrataRow } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

const HOST = "data.montgomerycountymd.gov";
const VIEW_ID = "v8mn-6i2r";
const CATEGORY: CategoryKey = "electricidad";
const SOURCE_NAME = "data-gov-montgomery-md-electrician" as const;

interface RunOptions {
  /** Hard cap on rows processed. Default unlimited. */
  maxRows?: number;
  /** Sink batch size. Default 500. */
  batchSize?: number;
  /** Dry run: parse + ensureCity but skip professionals upsert. */
  dryRun?: boolean;
}

function parseGeo(row: SocrataRow): { lat?: number; lng?: number } {
  const raw = row.geolocation;
  if (!raw || typeof raw !== "object") return {};
  // Socrata "location" type ships as { latitude: "39.4", longitude: "-77.0", … }.
  const obj = raw as { latitude?: string; longitude?: string };
  const lat = obj.latitude ? Number(obj.latitude) : undefined;
  const lng = obj.longitude ? Number(obj.longitude) : undefined;
  return {
    lat: Number.isFinite(lat) ? lat : undefined,
    lng: Number.isFinite(lng) ? lng : undefined,
  };
}

function buildAddress(row: SocrataRow): string | undefined {
  const parts: string[] = [];
  const addr = socrataPick(row, ["addr1", "address"]);
  const city = socrataPick(row, ["city"]);
  const state = socrataPick(row, ["state"]);
  const zip = socrataPick(row, ["zip", "zipcode"]);
  if (addr) parts.push(addr);
  if (city) parts.push(city);
  if (state) parts.push(state);
  if (zip) parts.push(zip);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

export async function runMontgomeryMdElectrician(
  client: SupabaseClient,
  opts: RunOptions = {},
): Promise<{ scanned: number; accepted: number; written: number }> {
  const batchSize = opts.batchSize ?? 500;
  const sink = getSink({ trustCitySlugs: true });
  let scanned = 0;
  let accepted = 0;
  let written = 0;
  let buffer: ScrapedProfessional[] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    if (opts.dryRun) {
      written += buffer.length;
      buffer = [];
      return;
    }
    const res = await sink.upsert(buffer);
    written += res.inserted + res.updated;
    buffer = [];
  };

  const PROGRESS_EVERY = 100;
  let lastProgressTs = Date.now();
  for await (const page of fetchSocrataJson({
    host: HOST,
    viewId: VIEW_ID,
    pageSize: 1000,
    maxRows: opts.maxRows,
  })) {
    for (const row of page) {
      if (scanned > 0 && scanned % PROGRESS_EVERY === 0) {
        const cs = getCityUpsertStats();
        const elapsed = ((Date.now() - lastProgressTs) / 1000).toFixed(1);
        console.log(
          `[montgomery-md-electrician] progress scanned=${scanned} accepted=${accepted} written=${written} ` +
            `cities_created=${cs.inserted} geocoded=${cs.geocoded} +${elapsed}s`,
        );
        lastProgressTs = Date.now();
      }
      scanned += 1;
      const licenseNo = socrataPick(row, ["licenseno", "license_no"]);
      const applicant = socrataPick(row, ["applicant", "name"]);
      const cityRaw = socrataPick(row, ["city"]);
      const state = socrataPick(row, ["state"]);
      if (!licenseNo || !applicant || !cityRaw) continue;
      const geo = parseGeo(row);
      const cityResult = await ensureCity(client, {
        name: cityRaw,
        state,
        country: "US",
        lat: geo.lat,
        lng: geo.lng,
      });
      if (!cityResult) continue;
      const cityName = cityRaw
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
      buffer.push({
        source: SOURCE_NAME,
        sourceId: licenseNo,
        name: applicant
          .toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        categoryKey: CATEGORY,
        country: "US",
        citySlug: cityResult.slug,
        headline: `Master Electrician en ${cityName}`,
        description: `Licencia ${licenseNo} emitida por Montgomery County, MD.`,
        address: buildAddress(row),
        licenseNumber: licenseNo,
        lat: geo.lat,
        lng: geo.lng,
        metadata: {
          license_type: socrataPick(row, ["licensetype"]),
          issued_date: socrataPick(row, ["issueddate", "issued_date"]),
          expire_date: socrataPick(row, ["expiredate", "expire_date"]),
          reciprocal_with_state:
            socrataPick(row, ["reciprocal_with_state"]) === "Y",
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();
  const cityStats = getCityUpsertStats();
  console.log(
    `[montgomery-md-electrician] scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cityStats.inserted} geocoded_inline=${cityStats.geocoded} ungeocoded=${cityStats.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ─────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20_000;

export const montgomeryMdElectricianSource: ScraperSource = {
  name: "data-gov-montgomery-md-electrician" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_MONTGOMERY_MD_ELECTRICIAN === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runMontgomeryMdElectricianSource(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!montgomeryMdElectricianSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_MONTGOMERY_MD_ELECTRICIAN_LIMIT ?? DEFAULT_LIMIT);
  const maxRows = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runMontgomeryMdElectrician(client, { maxRows });
  console.log(
    `[montgomery-md-electrician] done — scanned=${scanned} accepted=${accepted} written=${written}`,
  );
  return { fetched: accepted, inserted: written, updated: 0, skipped: scanned - accepted };
}
