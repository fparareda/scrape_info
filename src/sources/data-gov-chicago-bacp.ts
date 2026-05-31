/**
 * Chicago BACP — Business Affairs and Consumer Protection licenses.
 *
 * Dataset: https://catalog.data.gov/dataset/business-licenses
 * Socrata view: data.cityofchicago.org / r5kz-chrr
 * Refresh cadence: daily.
 *
 * Single municipality (Chicago, IL) but ~1.5M total rows across all
 * business activities. We filter server-side via SoQL $where to pull
 * only license types that map cleanly to existing CategoryKeys:
 *
 *   - hvac        → "Heating, Ventilation and Air Conditioning Services - *"
 *   - mecanica    → "Motor Vehicle Repair - *"
 *   - carpinteria → "Home Repair Services" + "Residential Construction / Minor Home Repair *"
 *
 * Chicago does NOT license plumbers/electricians at municipal level
 * (state of IL handles via IDFPR — already covered by `illinois-idfpr`).
 *
 * Multi-activity rows ship the activities pipe-separated (`A | B |
 * C`). We split on " | " and take the first matching mapping; the
 * full original string is kept in `metadata.business_activity`.
 *
 * City auto-creation: most rows are CHICAGO/IL (already seeded). A
 * minority of business addresses (mailing addresses for off-Chicago
 * owners) live in suburbs — those will be auto-created.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional } from "../types.js";
import { fetchSocrataJson, socrataPick, type SocrataRow } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSink } from "../sink.js";

const HOST = "data.cityofchicago.org";
const VIEW_ID = "r5kz-chrr";
const SOURCE_NAME = "data-gov-chicago-bacp" as const;

// Server-side SoQL filter: license_status='AAI' (active issued) AND
// business_activity matches any of our target patterns. We OR the LIKE
// clauses so Socrata can use its trigram index efficiently. The
// pattern set is intentionally narrow — broadening here turns into
// thousands of un-mapped categories arriving at the sink.
const WHERE_CLAUSE =
  "license_status='AAI' AND (" +
  "business_activity like '%Heating, Ventilation and Air Conditioning%'" +
  " OR business_activity like '%Motor Vehicle Repair%'" +
  " OR business_activity like '%Home Repair Services%'" +
  " OR business_activity like '%Residential Construction / Minor Home Repair%'" +
  ")";

interface ActivityRule {
  matches: (activity: string) => boolean;
  category: CategoryKey;
}

const ACTIVITY_RULES: ActivityRule[] = [
  {
    matches: (a) => /heating.*ventilation.*air conditioning/i.test(a),
    category: "hvac",
  },
  {
    matches: (a) => /motor vehicle repair/i.test(a),
    category: "mecanica",
  },
  {
    matches: (a) => /home repair services|residential construction|residential remodel/i.test(a),
    category: "carpinteria",
  },
];

function mapActivityToCategory(activity: string | undefined): CategoryKey | null {
  if (!activity) return null;
  // Multi-activity rows: "A | B | C". Take the first match.
  for (const part of activity.split("|").map((s) => s.trim())) {
    for (const rule of ACTIVITY_RULES) {
      if (rule.matches(part)) return rule.category;
    }
  }
  return null;
}

function parseLocation(row: SocrataRow): { lat?: number; lng?: number } {
  // Chicago dataset ships latitude/longitude as top-level strings AND
  // a nested `location` object. Top-level is more reliable.
  const lat = row.latitude ? Number(row.latitude) : undefined;
  const lng = row.longitude ? Number(row.longitude) : undefined;
  return {
    lat: Number.isFinite(lat) ? lat : undefined,
    lng: Number.isFinite(lng) ? lng : undefined,
  };
}

function buildAddress(row: SocrataRow): string | undefined {
  const parts: string[] = [];
  const addr = socrataPick(row, ["address"]);
  const city = socrataPick(row, ["city"]);
  const state = socrataPick(row, ["state"]);
  const zip = socrataPick(row, ["zip_code", "zip"]);
  if (addr) parts.push(addr);
  if (city) parts.push(city);
  if (state) parts.push(state);
  if (zip) parts.push(zip);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

interface RunOptions {
  maxRows?: number;
  batchSize?: number;
  dryRun?: boolean;
}

export async function runChicagoBacp(
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

  const PROGRESS_EVERY = 500;
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
          `[chicago-bacp] progress scanned=${scanned} accepted=${accepted} written=${written} ` +
            `cities_created=${cs.inserted} geocoded=${cs.geocoded} +${elapsed}s`,
        );
        lastProgressTs = Date.now();
      }
      scanned += 1;
      const licenseNo = socrataPick(row, ["license_number", "license_id"]);
      const idField = socrataPick(row, ["id"]);
      const dba = socrataPick(row, ["doing_business_as_name", "legal_name"]);
      const cityRaw = socrataPick(row, ["city"]);
      const state = socrataPick(row, ["state"]);
      const activity = socrataPick(row, ["business_activity"]);
      const category = mapActivityToCategory(activity);
      if (!idField || !dba || !cityRaw || !category) continue;

      const geo = parseLocation(row);
      const cityResult = await ensureCity(client, {
        name: cityRaw,
        state,
        country: "US",
        lat: geo.lat,
        lng: geo.lng,
      });
      if (!cityResult) continue;

      buffer.push({
        source: SOURCE_NAME,
        // `id` is the unique-per-license-renewal key; license_number
        // would collide on renewals.
        sourceId: idField,
        name: titleCase(dba),
        categoryKey: category,
        country: "US",
        citySlug: cityResult.slug,
        headline: `${titleCase(activity ?? "")} en ${titleCase(cityRaw)}`,
        description:
          `Licencia ${licenseNo ?? idField} emitida por City of Chicago ` +
          `Business Affairs and Consumer Protection.`,
        address: buildAddress(row),
        licenseNumber: licenseNo ?? undefined,
        lat: geo.lat,
        lng: geo.lng,
        metadata: {
          license_description: socrataPick(row, ["license_description"]),
          business_activity: activity,
          license_code: socrataPick(row, ["license_code"]),
          license_status: socrataPick(row, ["license_status"]),
          ward: socrataPick(row, ["ward"]),
          community_area_name: socrataPick(row, ["community_area_name"]),
          neighborhood: socrataPick(row, ["neighborhood"]),
          date_issued: socrataPick(row, ["date_issued"]),
          expiration_date: socrataPick(row, ["expiration_date"]),
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();
  const cs = getCityUpsertStats();
  console.log(
    `[chicago-bacp] scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded_inline=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}
