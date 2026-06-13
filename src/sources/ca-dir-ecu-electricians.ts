/**
 * California DIR — Electrician Certification Unit (ECU).
 *
 * Dataset: https://data.ca.gov/dataset/dir-electrician-certification-unit-ecu
 * Publisher: CA Department of Industrial Relations (DIR), DLSE / ECU.
 * Update cadence: biweekly.
 *
 * Two resources are available:
 *   - Certified Electrician List  (~36 k rows)   ← this scraper
 *   - Electrician Trainee List    (~19 k rows)
 *
 * We ingest both under a single source slug `ca-dir-ecu-electricians`.
 *
 * robots.txt (data.ca.gov, 2026-06-13):
 *   Disallow: /api/  (and locale dirs)
 *   The CSV files are NOT served through /api/ — they are pre-signed S3
 *   objects linked from the dataset page. The download redirects through
 *   data.ca.gov/dataset/.../download/... then to S3; the CKAN dataset
 *   page and S3 bucket are not blocked by robots.txt.
 *
 * The dataset was verified at:
 *   data.ca.gov/dataset/dir-electrician-certification-unit-ecu
 *
 * Data shape (4 columns):
 *   ELECTRICIAN_NAME | ZIP_CODE | CERTIFICATE_NUMBER | EXPIRATION_DATE
 *
 * City resolution: ZIP_CODE is the only geographic field. We resolve
 * city name from US zip codes using Nominatim's postalcode search
 * (1 req/s rate limit respected; unique zip codes cached). Zips that
 * fail geocoding are dropped with a warning.
 *
 * Category: electricidad (certified journeyman + trainee electricians).
 * Country:  US (all records are CA residents; a minority hold zips in
 *           neighbouring NV/AZ — those still resolve to a US city).
 *
 * Env knobs:
 *   PROLIO_RUN_CA_DIR_ECU_ELECTRICIANS=true   enable
 *   PROLIO_CA_DIR_ECU_LIMIT=60000             row cap (default)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { parseCsv, pick } from "./_bulk-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

const CATEGORY: CategoryKey = "electricidad";
const SOURCE_NAME = "ca-dir-ecu-electricians" as const;

// Direct CSV download URLs (redirect through data.ca.gov then to S3).
// robots.txt at data.ca.gov blocks /api/* but not /dataset/.../download/*
// nor the S3 CDN host.
const CSV_URLS = [
  {
    url: "https://data.ca.gov/dataset/469f1d7f-81dd-4e5b-a2db-ad4eece1134b/resource/291bacb8-2fdb-4d9c-a330-113781ce2f59/download/certified_electrician_list.csv",
    label: "Certified Electricians",
  },
  {
    url: "https://data.ca.gov/dataset/469f1d7f-81dd-4e5b-a2db-ad4eece1134b/resource/f0b9e36d-32be-408d-8dd9-4d539becfdc8/download/electrician_trainee_list.csv",
    label: "Electrician Trainees",
  },
] as const;

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// ── Nominatim ZIP → city resolution ──────────────────────────────────────────

const NOMINATIM_INTERVAL_MS = 1200; // 1 req/s + buffer
const NOMINATIM_TIMEOUT_MS = 8_000;

/** Serialises Nominatim calls across this scraper. */
let nominatimChain: Promise<void> = Promise.resolve();

function nominatimGate(): Promise<void> {
  const wait = nominatimChain.then(
    () => new Promise<void>((r) => setTimeout(r, NOMINATIM_INTERVAL_MS)),
  );
  nominatimChain = wait.catch(() => undefined);
  return wait;
}

interface NominatimHit {
  display_name?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    county?: string;
    state?: string;
    postcode?: string;
  };
  lat?: string;
  lon?: string;
}

/** Cache: zip → { city, state } | null */
const zipCache = new Map<string, { city: string; state: string } | null>();

/**
 * Resolve a US zip code to a (city, state) pair using Nominatim's
 * postalcode search. Result is cached per process so the 1-req/s
 * limit is only hit for unique zip codes.
 */
async function resolveZipToCity(
  zip: string,
): Promise<{ city: string; state: string } | null> {
  const z5 = zip.trim().slice(0, 5);
  if (zipCache.has(z5)) return zipCache.get(z5) ?? null;

  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?postalcode=${encodeURIComponent(z5)}&countrycodes=us` +
    `&addressdetails=1&format=json&limit=1`;

  await nominatimGate();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
    });
    if (!res.ok) {
      zipCache.set(z5, null);
      return null;
    }
    const data = (await res.json()) as NominatimHit[];
    if (!data || data.length === 0) {
      zipCache.set(z5, null);
      return null;
    }
    const hit = data[0];
    const addr = hit.address ?? {};
    const city =
      addr.city ?? addr.town ?? addr.village ?? addr.county ?? null;
    const state = addr.state ?? null;
    if (!city || !state) {
      zipCache.set(z5, null);
      return null;
    }
    const result = { city, state };
    zipCache.set(z5, result);
    return result;
  } catch {
    zipCache.set(z5, null);
    return null;
  }
}

// ── CSV fetch ─────────────────────────────────────────────────────────────────

async function fetchCsv(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/csv,text/plain,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ── RunOptions + core runner ──────────────────────────────────────────────────

interface RunOptions {
  maxRows?: number;
  batchSize?: number;
  dryRun?: boolean;
}

export async function runCaDirEcuElectricians(
  client: SupabaseClient,
  opts: RunOptions = {},
): Promise<{ scanned: number; accepted: number; written: number }> {
  const batchSize = opts.batchSize ?? 500;
  const maxRows = opts.maxRows ?? Infinity;
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

  const PROGRESS_EVERY = 500;
  let lastProgressTs = Date.now();

  for (const { url, label } of CSV_URLS) {
    if (scanned >= maxRows) break;
    console.log(`[ca-dir-ecu-electricians] downloading ${label} …`);
    let csvText: string;
    try {
      csvText = await fetchCsv(url);
    } catch (err) {
      console.error(
        `[ca-dir-ecu-electricians] failed to download ${label}: ${(err as Error).message}`,
      );
      continue;
    }
    const rows = parseCsv(csvText);
    console.log(`[ca-dir-ecu-electricians] ${label}: ${rows.length} raw rows`);

    for (const row of rows) {
      if (scanned >= maxRows) break;

      if (scanned > 0 && scanned % PROGRESS_EVERY === 0) {
        const cs = getCityUpsertStats();
        const elapsed = ((Date.now() - lastProgressTs) / 1000).toFixed(1);
        console.log(
          `[ca-dir-ecu-electricians] progress scanned=${scanned} accepted=${accepted} written=${written} ` +
            `cities_created=${cs.inserted} geocoded=${cs.geocoded} +${elapsed}s`,
        );
        lastProgressTs = Date.now();
      }
      scanned += 1;

      const name = pick(row, ["electrician_name"]);
      const zip = pick(row, ["zip_code"]);
      const cert = pick(row, ["certificate_number"]);
      const expiry = pick(row, ["expiration_date"]);

      if (!name || !cert) {
        console.warn(`[ca-dir-ecu-electricians] row ${scanned}: missing name/cert — dropped`);
        continue;
      }

      if (!zip) {
        console.warn(
          `[ca-dir-ecu-electricians] ${cert}: no zip code — dropped`,
        );
        continue;
      }

      const location = await resolveZipToCity(zip);
      if (!location) {
        console.warn(
          `[ca-dir-ecu-electricians] ${cert}: zip ${zip} unresolvable — dropped`,
        );
        continue;
      }

      const cityResult = await ensureCity(client, {
        name: location.city,
        state: location.state,
        country: "US",
      });
      if (!cityResult) {
        console.warn(
          `[ca-dir-ecu-electricians] ${cert}: ensureCity failed for ${location.city} — dropped`,
        );
        continue;
      }

      const titleName = name
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());

      buffer.push({
        source: SOURCE_NAME,
        sourceId: cert,
        name: titleName,
        categoryKey: CATEGORY,
        country: "US",
        citySlug: cityResult.slug,
        headline: `Electrician en ${location.city}`,
        description: `Certificate ${cert} issued by California DIR Electrician Certification Unit.`,
        licenseNumber: cert,
        metadata: {
          cert_type: cert.startsWith("ETL") ? "trainee" : "certified",
          expiration_date: expiry || undefined,
          zip_code: zip,
          state: "CA",
          authority: "CA Department of Industrial Relations — ECU",
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();

  const cs = getCityUpsertStats();
  console.log(
    `[ca-dir-ecu-electricians] scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded_inline=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ─────────────────────────────────────────────────────

const DEFAULT_LIMIT = 60_000;

export const caDirEcuElectriciansSource: ScraperSource = {
  name: "ca-dir-ecu-electricians" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CA_DIR_ECU_ELECTRICIANS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCaDirEcuElectriciansSource(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!caDirEcuElectriciansSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_CA_DIR_ECU_LIMIT ?? DEFAULT_LIMIT,
  );
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runCaDirEcuElectricians(
    client,
    { maxRows },
  );
  console.log(
    `[ca-dir-ecu-electricians] done — scanned=${scanned} accepted=${accepted} written=${written}`,
  );
  return { fetched: accepted, inserted: written, updated: 0, skipped: scanned - accepted };
}
