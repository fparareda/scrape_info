import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick, type SocrataRow } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

/**
 * Illinois IDFPR — Department of Financial and Professional Regulation.
 *
 * Real dataset: "Professional Licensing" `pzzh-kp68` on data.illinois.gov
 * (Socrata). "Search, connect, and download all Illinois professional
 * license holders." ~4.17M total rows; ~1.35M `license_status='ACTIVE'`.
 *
 *   https://data.illinois.gov/dataset (IDFPR Professional Licensing)
 *
 * Pre-flight (2026-06-19):
 *   - Socrata SODA JSON API, no auth, no captcha.
 *   - Verified live: GET /resource/pzzh-kp68.json?$limit=1 → HTTP 200.
 *   - Columns: license_type, description, license_number, license_status,
 *     business, title, first_name, middle, last_name, prefix, suffix,
 *     business_name, businessdba, original_issue_date, effective_date,
 *     expiration_date, city, state, zip, county, ever_disciplined, …
 *   - No street address column (city/state/zip only) and no phone.
 *
 * IMPORTANT scope note: IDFPR does NOT license electricians, plumbers, or
 * HVAC techs in Illinois — electricians are licensed by municipalities and
 * plumbers/HVAC by other agencies (IDPH). So the categories present in
 * THIS dataset are the design/health/trade professions IDFPR regulates:
 *   ROOFING CONTRACTOR (33.6k) → carpinteria
 *   ARCHITECT          (25.2k) → arquitecto
 *   PHYSICAL THERAPY   (40.8k) → fisioterapia
 *   VETERINARY         (28.2k) → veterinario
 *   DENTAL             (83.3k) → dentista
 *   PROF. ENGINEER / STRUCTURAL ENGINEER (109.6k) → ingenieria
 * (`license_type` values are UPPER-case; matched server-side by keyword.)
 *
 * Off by default. Enable via `PROLIO_RUN_ILLINOIS_IDFPR=true`.
 * Cap via `PROLIO_ILLINOIS_IDFPR_LIMIT` (default 50000).
 */

const HOST = "data.illinois.gov";
const VIEW_ID = "pzzh-kp68";
const SOURCE_NAME = "illinois-idfpr" as const;
const DEFAULT_LIMIT = 50_000;

// Server-side SoQL: active licences in the license_types we cover.
const WHERE_CLAUSE =
  "license_status='ACTIVE' AND (" +
  "license_type like '%ROOFING%'" +
  " OR license_type like '%ARCHITECT%'" +
  " OR license_type like '%PHYSICAL THERAP%'" +
  " OR license_type like '%VETERINAR%'" +
  " OR license_type like '%DENTAL%'" +
  " OR license_type like '%ENGINEER%'" +
  ")";

interface CategoryRule {
  test: RegExp;
  category: CategoryKey;
}

const CATEGORY_RULES: CategoryRule[] = [
  { test: /roofing/i, category: "carpinteria" },
  { test: /architect/i, category: "arquitecto" },
  { test: /physical therap/i, category: "fisioterapia" },
  { test: /veterinar/i, category: "veterinario" },
  { test: /dental/i, category: "dentista" },
  { test: /engineer/i, category: "ingenieria" },
];

function mapLicenseType(licType: string | undefined): CategoryKey | null {
  if (!licType) return null;
  for (const rule of CATEGORY_RULES) {
    if (rule.test.test(licType)) return rule.category;
  }
  return null;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildName(row: SocrataRow): string | undefined {
  const business = socrataPick(row, ["business_name"]);
  const dba = socrataPick(row, ["businessdba"]);
  if (business) return titleCase(business);
  if (dba) return titleCase(dba);
  const first = socrataPick(row, ["first_name"]);
  const middle = socrataPick(row, ["middle"]);
  const last = socrataPick(row, ["last_name"]);
  const parts = [first, middle, last].filter(Boolean) as string[];
  return parts.length > 0 ? titleCase(parts.join(" ")) : undefined;
}

interface RunOptions {
  maxRows?: number;
  batchSize?: number;
}

// ── Resume cursor (public.scrape_cursor) ────────────────────────────────────
async function readCursor(client: SupabaseClient): Promise<number> {
  const { data } = await client
    .from("scrape_cursor")
    .select("next_offset")
    .eq("source", SOURCE_NAME)
    .maybeSingle();
  const v = (data as { next_offset?: number | string } | null)?.next_offset;
  return Number(v ?? 0) || 0;
}

async function writeCursor(client: SupabaseClient, nextOffset: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (client.from("scrape_cursor") as any).upsert(
    {
      source: SOURCE_NAME,
      next_offset: nextOffset,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "source" },
  );
}

export async function runIllinoisIdfprSocrata(
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

  // Resume checkpoint: this dataset doesn't finish in one CI window at the DB
  // write ceiling, so we persist the Socrata $offset and continue from it next
  // run. Reaching end-of-dataset resets it to 0 for the next full refresh.
  const startOffset = await readCursor(client);
  let offset = startOffset;
  if (startOffset > 0) console.log(`[illinois-idfpr] resuming from offset=${startOffset}`);

  for await (const page of fetchSocrataJson({
    host: HOST,
    viewId: VIEW_ID,
    pageSize: 1000,
    maxRows: opts.maxRows,
    where: WHERE_CLAUSE,
    startOffset,
  })) {
    for (const row of page) {
      scanned += 1;
      const licType = socrataPick(row, ["license_type"]);
      const category = mapLicenseType(licType);
      if (!category) continue;

      const licNum = socrataPick(row, ["license_number"]);
      const name = buildName(row);
      if (!licNum || !name) continue;

      const cityRaw = socrataPick(row, ["city"]);
      const stateRaw = socrataPick(row, ["state"]) || "IL";
      let citySlug = "";
      if (cityRaw && stateRaw.toUpperCase() === "IL") {
        const cityResult = await ensureCity(client, {
          name: titleCase(cityRaw),
          state: "IL",
          country: "US",
        });
        if (cityResult) citySlug = cityResult.slug;
      }

      const dedupeKey = `${licNum}:${category}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const zip = socrataPick(row, ["zip"]);
      const address = [cityRaw, stateRaw, zip].filter(Boolean).join(", ");

      buffer.push({
        source: SOURCE_NAME as ScrapeSource,
        sourceId: `illinois-idfpr:${licNum}:${category}`,
        name,
        categoryKey: category,
        country: "US",
        citySlug,
        address: address || undefined,
        licenseNumber: licNum,
        metadata: {
          country: "US",
          state: "IL",
          authority: "Illinois IDFPR",
          verified_by_authority: true,
          idfpr_license_type: licType,
          idfpr_description: socrataPick(row, ["description"]),
          expiration_date: socrataPick(row, ["expiration_date"]),
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
    // Page done — flush, then advance + persist the resume cursor so we only
    // checkpoint past rows already written.
    offset += page.length;
    await flush();
    await writeCursor(client, offset);
  }
  await flush();
  // End of dataset reached → reset cursor for the next full pass.
  await writeCursor(client, 0);

  const cs = getCityUpsertStats();
  console.log(
    `[illinois-idfpr] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

export const illinoisIdfprSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_ILLINOIS_IDFPR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runIllinoisIdfpr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!illinoisIdfprSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_ILLINOIS_IDFPR_LIMIT ?? DEFAULT_LIMIT,
  );
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runIllinoisIdfprSocrata(client, {
    maxRows,
  });
  return {
    fetched: accepted,
    inserted: written,
    updated: 0,
    skipped: scanned - accepted,
  };
}
