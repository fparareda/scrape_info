/**
 * Connecticut Department of Consumer Protection (DCP) — State Licenses
 * and Credentials.
 *
 * Dataset: https://data.ct.gov/Business/State-Licenses-and-Credentials/ngch-56tr
 * Socrata host: data.ct.gov  view-id: ngch-56tr
 * Refresh cadence: daily.
 *
 * ~2.6M total rows across all credential types; we filter server-side
 * via SoQL to ACTIVE records only and only credential types that map to
 * our CategoryKeys:
 *
 *   - electricidad  → ELECTRICAL * CONTRACTOR
 *   - fontaneria    → PLUMBING * CONTRACTOR
 *   - hvac          → HEATING, PIPING & COOLING * CONTRACTOR
 *   - carpinteria   → HOME IMPROVEMENT CONTRACTOR / NEW HOME CONSTRUCTION CONTRACTOR
 *   - ingenieria    → PROFESSIONAL ENGINEER / ENGINEER-IN-TRAINING
 *   - arquitecto    → ARCHITECT / ARCHITECTURE FIRM / LANDSCAPE ARCHITECT
 *
 * Active-only record estimates:
 *   ~5,500 electrical contractors, ~2,700 plumbing contractors,
 *   ~3,800 HVAC contractors, ~21,400 home improvement contractors,
 *   ~2,700 new-home contractors, ~13,600 professional engineers,
 *   ~1,600 engineers-in-training, ~1,000 architects/firms.
 * Total: ~52,000 active records across categories.
 *
 * robots.txt (data.ct.gov): Disallows only /OData.svc/ and /api/odata/
 * and /api/collocate* — /resource/ and other /api/ paths are implicitly
 * allowed. Crawl-delay: 1s (we use paged JSON at ≤1 req/s naturally).
 *
 * No login, no captcha, no Cloudflare challenge.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick, type SocrataRow } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

const HOST = "data.ct.gov";
const VIEW_ID = "ngch-56tr";
const SOURCE_NAME = "connecticut-dcp" as const;

// Server-side SoQL filter: ACTIVE status + credential types we care about.
// LIKE patterns are deliberately specific to avoid pulling unrelated credential
// types (healthcare, cosmetology, etc.) that would not map to our categories.
const WHERE_CLAUSE =
  "status='ACTIVE' AND (" +
  "credential like '%ELECTRICAL%CONTRACTOR%'" +
  " OR credential like '%PLUMBING%CONTRACTOR%'" +
  " OR credential like '%HEATING, PIPING%CONTRACTOR%'" +
  " OR credential = 'HOME IMPROVEMENT CONTRACTOR'" +
  " OR credential = 'NEW HOME CONSTRUCTION CONTRACTOR'" +
  " OR credential = 'PROFESSIONAL ENGINEER'" +
  " OR credential = 'ENGINEER-IN-TRAINING'" +
  " OR credential = 'ARCHITECT'" +
  " OR credential = 'ARCHITECTURE FIRM'" +
  " OR credential = 'LANDSCAPE ARCHITECT'" +
  ")";

interface CredentialRule {
  matches: (credential: string) => boolean;
  category: CategoryKey;
}

const CREDENTIAL_RULES: CredentialRule[] = [
  {
    matches: (c) => /electrical.*contractor/i.test(c),
    category: "electricidad",
  },
  {
    matches: (c) => /plumbing.*contractor/i.test(c),
    category: "fontaneria",
  },
  {
    matches: (c) => /heating.*piping.*contractor/i.test(c),
    category: "hvac",
  },
  {
    matches: (c) =>
      /home improvement contractor|new home construction contractor/i.test(c),
    category: "carpinteria",
  },
  {
    matches: (c) => /professional engineer|engineer-in-training/i.test(c),
    category: "ingenieria",
  },
  {
    matches: (c) => /\barchitect\b/i.test(c),
    category: "arquitecto",
  },
];

function mapCredentialToCategory(credential: string | undefined): CategoryKey | null {
  if (!credential) return null;
  for (const rule of CREDENTIAL_RULES) {
    if (rule.matches(credential)) return rule.category;
  }
  return null;
}

function buildAddress(row: SocrataRow): string | undefined {
  const parts: string[] = [];
  const addr = socrataPick(row, ["address"]);
  const city = socrataPick(row, ["city"]);
  const state = socrataPick(row, ["state"]);
  const zip = socrataPick(row, ["zip"]);
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

export async function runConnecticutDcp(
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
          `[connecticut-dcp] progress scanned=${scanned} accepted=${accepted} written=${written} ` +
            `cities_created=${cs.inserted} geocoded=${cs.geocoded} +${elapsed}s`,
        );
        lastProgressTs = Date.now();
      }
      scanned += 1;

      const credentialId = socrataPick(row, ["credentialid"]);
      const credential = socrataPick(row, ["credential"]);
      const category = mapCredentialToCategory(credential);
      if (!category) continue;

      // Individual licensees have `name`; businesses have `businessname` or `name`.
      const name =
        socrataPick(row, ["businessname", "name"]) ??
        socrataPick(row, ["name"]);
      if (!name || !credentialId) continue;

      const cityRaw = socrataPick(row, ["city"]);
      if (!cityRaw) continue;

      const state = socrataPick(row, ["state"]) ?? "CT";
      const cityResult = await ensureCity(client, {
        name: cityRaw,
        state,
        country: "US",
      });
      if (!cityResult) continue;

      const licenseNumber =
        socrataPick(row, ["credentialnumber"]) ??
        socrataPick(row, ["fullcredentialcode"]);

      buffer.push({
        source: SOURCE_NAME,
        sourceId: credentialId,
        name: titleCase(name),
        categoryKey: category,
        country: "US",
        citySlug: cityResult.slug,
        headline: `${titleCase(credential ?? "")} en ${titleCase(cityRaw)}`,
        description:
          `Licencia ${licenseNumber ?? credentialId} emitida por ` +
          `Connecticut Department of Consumer Protection.`,
        address: buildAddress(row),
        licenseNumber: licenseNumber ?? undefined,
        metadata: {
          credential_type: credential,
          credential_id: credentialId,
          issue_date: socrataPick(row, ["issuedate"]),
          effective_date: socrataPick(row, ["effectivedate"]),
          expiration_date: socrataPick(row, ["expirationdate"]),
          status_reason: socrataPick(row, ["statusreason"]),
          license_holder_type: socrataPick(row, ["type"]),
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();
  const cs = getCityUpsertStats();
  console.log(
    `[connecticut-dcp] scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded_inline=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ─────────────────────────────────────────────────────

const DEFAULT_LIMIT = 60_000;

export const connecticutDcpSource: ScraperSource = {
  name: "connecticut-dcp" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CONNECTICUT_DCP === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runConnecticutDcpSource(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!connecticutDcpSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_CONNECTICUT_DCP_LIMIT ?? DEFAULT_LIMIT,
  );
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runConnecticutDcp(client, {
    maxRows,
  });
  console.log(
    `[connecticut-dcp] done — scanned=${scanned} accepted=${accepted} written=${written}`,
  );
  return {
    fetched: accepted,
    inserted: written,
    updated: 0,
    skipped: scanned - accepted,
  };
}
