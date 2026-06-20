import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick, type SocrataRow } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

/**
 * Colorado DORA — Division of Professions and Occupations (Socrata).
 *
 * Real dataset: "Professional and Occupational Licenses in Colorado"
 * `7s5z-vewr` on data.colorado.gov (Colorado Information Marketplace).
 * Powers the public DORA license-lookup widget; updated nightly. ~2M+
 * total rows across 200+ `licensetype` codes (every regulated profession
 * in the state). We filter server-side for the trade/design codes that
 * map cleanly to Prolio CategoryKeys and to status "Active".
 *
 *   https://data.colorado.gov/Regulations/Professional-and-Occupational-Licenses-in-Colorado/7s5z-vewr
 *
 * Pre-flight (2026-06-19):
 *   - Socrata SODA JSON API, no auth, no captcha.
 *   - Verified live: GET /resource/7s5z-vewr.json?$limit=1 → HTTP 200.
 *   - Columns: lastname, firstname, middlename, city, state, mailzipcode,
 *     licensetype, licensenumber, licensefirstissuedate,
 *     licenselastreneweddate, licenseexpirationdate,
 *     licensestatusdescription, linktoverifylicense.
 *   - This dataset has NO street address (mailing zip only) and NO phone.
 *
 * licensetype → CategoryKey (verified counts, 2026-06-19):
 *   Electrical: EC (Electrical Contractor, 12.4k), ME (Master Electrician,
 *     13.3k), JW (Journeyman Wireman, 32.7k), RW (Residential Wireman, 6.5k)
 *   Plumbing:   MP (Master Plumber, 9.3k), JP (Journeyman Plumber, 11.8k),
 *     PC (Plumbing Contractor, 5.4k), RP (Residential Plumber, 2.6k)
 *   Architect:  ARC (Architecture, 18.8k)
 * NOTE: Colorado does NOT license HVAC/mechanical at the state level, so
 * there is no `hvac` mapping here. `MT` is Massage Therapy (not mechanical)
 * and is intentionally excluded.
 *
 * Off by default. Enable via `PROLIO_RUN_COLORADO_DORA=true`.
 * Cap via `PROLIO_COLORADO_DORA_LIMIT` (default 50000).
 */

const HOST = "data.colorado.gov";
const VIEW_ID = "7s5z-vewr";
const SOURCE_NAME = "colorado-dora" as const;
const DEFAULT_LIMIT = 50_000;

// Exact-code → category. Codes are short and case-stable in this dataset.
const CODE_TO_CATEGORY: Record<string, CategoryKey> = {
  EC: "electricidad",
  ME: "electricidad",
  JW: "electricidad",
  RW: "electricidad",
  MP: "fontaneria",
  JP: "fontaneria",
  PC: "fontaneria",
  RP: "fontaneria",
  ARC: "arquitecto",
};

const TRADE_CODES = Object.keys(CODE_TO_CATEGORY);

// Server-side SoQL: only active licences whose type is one we cover.
const WHERE_CLAUSE =
  `licensestatusdescription='Active' AND licensetype in (` +
  TRADE_CODES.map((c) => `'${c}'`).join(",") +
  `)`;

function mapCode(code: string | undefined): CategoryKey | null {
  if (!code) return null;
  return CODE_TO_CATEGORY[code.trim().toUpperCase()] ?? null;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildName(row: SocrataRow): string | undefined {
  const first = socrataPick(row, ["firstname"]);
  const middle = socrataPick(row, ["middlename"]);
  const last = socrataPick(row, ["lastname"]);
  const parts = [first, middle, last].filter(Boolean) as string[];
  if (parts.length > 0) return titleCase(parts.join(" "));
  const business = socrataPick(row, ["businessname", "business_name"]);
  return business ? titleCase(business) : undefined;
}

interface RunOptions {
  maxRows?: number;
  batchSize?: number;
}

export async function runColoradoDoraSocrata(
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

  for await (const page of fetchSocrataJson({
    host: HOST,
    viewId: VIEW_ID,
    pageSize: 1000,
    maxRows: opts.maxRows,
    where: WHERE_CLAUSE,
  })) {
    for (const row of page) {
      scanned += 1;
      const code = socrataPick(row, ["licensetype"]);
      const category = mapCode(code);
      if (!category) continue;

      const licNum = socrataPick(row, ["licensenumber"]);
      const name = buildName(row);
      if (!licNum || !name) continue;

      const cityRaw = socrataPick(row, ["city"]);
      const stateRaw = socrataPick(row, ["state"]) || "CO";
      let citySlug = "";
      if (cityRaw) {
        const cityResult = await ensureCity(client, {
          name: titleCase(cityRaw),
          state: stateRaw,
          country: "US",
        });
        if (cityResult) citySlug = cityResult.slug;
      }

      const dedupeKey = `${licNum}:${category}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const zip = socrataPick(row, ["mailzipcode"]);
      const address = [cityRaw, stateRaw, zip].filter(Boolean).join(", ");

      buffer.push({
        source: SOURCE_NAME as ScrapeSource,
        sourceId: `colorado-dora:${licNum}:${category}`,
        name,
        categoryKey: category,
        country: "US",
        citySlug,
        address: address || undefined,
        licenseNumber: licNum,
        metadata: {
          country: "US",
          state: "CO",
          authority: "Colorado DORA",
          verified_by_authority: true,
          dora_license_type: code,
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
    `[colorado-dora] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

export const coloradoDoraSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_COLORADO_DORA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runColoradoDora(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!coloradoDoraSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_COLORADO_DORA_LIMIT ?? DEFAULT_LIMIT);
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runColoradoDoraSocrata(client, {
    maxRows,
  });
  return {
    fetched: accepted,
    inserted: written,
    updated: 0,
    skipped: scanned - accepted,
  };
}
