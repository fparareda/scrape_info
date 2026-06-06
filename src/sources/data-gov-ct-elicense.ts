import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick, type SocrataRow } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

/**
 * Connecticut eLicense — State Licenses and Credentials (Socrata).
 *
 * Dataset `ngch-56tr` on data.ct.gov. ~2M total rows covering 850+
 * credential types across all regulated professions in Connecticut.
 * We filter server-side for active trade/contractor/engineering
 * credential types that map cleanly to Prolio CategoryKeys.
 *
 *   https://data.ct.gov/Business/State-Licenses-and-Credentials/ngch-56tr
 *
 * Pre-flight (2026-06-06):
 *   - robots.txt: ALLOWED — portal.ct.gov blocks only Sitecore admin paths
 *     and named bots (AhrefsBot, SEMrush). data.ct.gov Socrata API is open.
 *   - Technology: Socrata SoQL JSON API. No auth, daily updates.
 *   - Record count: ~2M total. Active trade/contractor subset ~50–200k rows.
 *   - State covered: Connecticut (CT) — previously a gap state.
 *
 * Fields used:
 *   credential_identifier — unique row ID
 *   licensee_name / business_name / dba_name
 *   credential_type       — license type (keyword-based category mapping)
 *   credential_number     — licence number
 *   credential_status     — Active / Expired etc.
 *   office_address / office_city / office_state / office_zip
 *   expiration_date
 *
 * CategoryKey mapping (first regex match on credential_type wins):
 *   Electrical/Electrician    → electricidad
 *   Plumb/Drain               → fontaneria
 *   Heating/HVAC/Air Cond/Refrig → hvac
 *   Home Improvement/General Contr/Builder/Carpenter → carpinteria
 *   Engineer/Engineering      → ingenieria
 *   Architect                 → arquitecto
 *   (records that match none are skipped)
 *
 * Off by default. Enable via `PROLIO_RUN_CT_ELICENSE=true`.
 * Cap via `PROLIO_CT_ELICENSE_LIMIT` (default 50000).
 * Monthly cadence (annual credentials; data updates daily but
 * directory quality doesn't need daily refresh).
 */

const HOST = "data.ct.gov";
const VIEW_ID = "ngch-56tr";
const SOURCE_NAME = "data-gov-ct-elicense" as const;
const DEFAULT_LIMIT = 50_000;

// Server-side SoQL filter: active credentials whose type matches keyword
// categories we cover. Using UPPER() for case-insensitive match on Socrata.
const WHERE_CLAUSE =
  "credential_status='Active' AND (" +
  "UPPER(credential_type) like '%ELECTR%'" +
  " OR UPPER(credential_type) like '%PLUMB%'" +
  " OR UPPER(credential_type) like '%DRAIN%'" +
  " OR UPPER(credential_type) like '%HEAT%'" +
  " OR UPPER(credential_type) like '%HVAC%'" +
  " OR UPPER(credential_type) like '%AIR COND%'" +
  " OR UPPER(credential_type) like '%REFRIGER%'" +
  " OR UPPER(credential_type) like '%HOME IMPROVEMENT%'" +
  " OR UPPER(credential_type) like '%GENERAL CONTRACTOR%'" +
  " OR UPPER(credential_type) like '%HOME CONSTRUCTION%'" +
  " OR UPPER(credential_type) like '%CARPENT%'" +
  " OR UPPER(credential_type) like '%ENGINEER%'" +
  " OR UPPER(credential_type) like '%ARCHITECT%'" +
  ")";

interface CategoryRule {
  test: RegExp;
  category: CategoryKey;
}

const CATEGORY_RULES: CategoryRule[] = [
  { test: /electr/i, category: "electricidad" },
  { test: /plumb|drain/i, category: "fontaneria" },
  { test: /heat|hvac|air.cond|refriger/i, category: "hvac" },
  {
    test: /home.improvement|general.contr|home.constr|new.home|carpent/i,
    category: "carpinteria",
  },
  { test: /engineer/i, category: "ingenieria" },
  { test: /architect/i, category: "arquitecto" },
];

function mapCredentialType(credType: string | undefined): CategoryKey | null {
  if (!credType) return null;
  for (const rule of CATEGORY_RULES) {
    if (rule.test.test(credType)) return rule.category;
  }
  return null;
}

function pickName(row: SocrataRow): string | undefined {
  const candidates = [
    "dba_name",
    "business_name",
    "licensee_name",
    "credential_holder_name",
    "name",
  ];
  for (const key of candidates) {
    const v = row[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function buildAddress(row: SocrataRow): string | undefined {
  const parts: string[] = [];
  const street = socrataPick(row, ["office_address", "address", "street_address"]);
  const city = socrataPick(row, ["office_city", "city"]);
  const state = socrataPick(row, ["office_state", "state"]);
  const zip = socrataPick(row, ["office_zip", "zip_code", "zip"]);
  if (street) parts.push(street);
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
}

export async function runCtElicense(
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
          `[ct-elicense] progress scanned=${scanned} accepted=${accepted} written=${written} ` +
            `cities_created=${cs.inserted} +${elapsed}s`,
        );
        lastProgressTs = Date.now();
      }
      scanned += 1;

      const credId = socrataPick(row, ["credential_identifier", "id"]);
      const credType = socrataPick(row, ["credential_type"]);
      const category = mapCredentialType(credType);
      if (!category) continue;

      const rawName = pickName(row);
      if (!rawName || !credId) continue;

      const cityRaw = socrataPick(row, ["office_city", "city"]);
      if (!cityRaw) continue;

      const cityResult = await ensureCity(client, {
        name: titleCase(cityRaw),
        state: "CT",
        country: "US",
      });
      if (!cityResult) continue;

      const credNum = socrataPick(row, ["credential_number", "license_number"]);
      buffer.push({
        source: SOURCE_NAME as ScrapeSource,
        sourceId: `ct-elicense:${credId}`,
        name: titleCase(rawName),
        categoryKey: category,
        country: "US",
        citySlug: cityResult.slug,
        address: buildAddress(row),
        licenseNumber: credNum ?? undefined,
        metadata: {
          credential_type: credType,
          credential_status: socrataPick(row, ["credential_status"]),
          expiration_date: socrataPick(row, ["expiration_date"]),
          issued_date: socrataPick(row, ["issued_date"]),
          state: "CT",
          country: "US",
          verified_by_authority: true,
          authority: "CT eLicense",
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();

  const cs = getCityUpsertStats();
  console.log(
    `[ct-elicense] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ──────────────────────────────────────────────────────

export const ctElicenseSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CT_ELICENSE === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCtElicenseSource(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!ctElicenseSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_CT_ELICENSE_LIMIT ?? DEFAULT_LIMIT);
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runCtElicense(client, {
    maxRows,
  });
  console.log(
    `[ct-elicense] source done — scanned=${scanned} accepted=${accepted} written=${written}`,
  );
  return { fetched: accepted, inserted: written, updated: 0, skipped: scanned - accepted };
}
