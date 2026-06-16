/**
 * Delaware Division of Professional Regulation (DPR) — Socrata open-data.
 *
 * Dataset: https://data.delaware.gov/Licenses-Certifications/Professional-and-Occupational-Licensing/pjnv-eaih
 * Host:    data.delaware.gov
 * View:    pjnv-eaih
 * Total:   ~349,921 records across 97+ license types (as of 2026-06)
 * Refresh: regular cadence (state licensing portal).
 *
 * robots.txt: /resource/ and /api/ are ALLOWED (only /api/odata/ and
 * /api/collocate* are disallowed); crawl delay 10 s honoured via pageSize.
 *
 * Category mapping (verified record counts 2026-06-15):
 *   Licensed Architect               → arquitecto  (~4,850)
 *   Certificate of Authorization-Architect → arquitecto (~780 firms)
 *   Veterinarian                     → veterinario (~1,893)
 *   Master Plumber                   → fontaneria  (~1,965)
 *   Master HVACR                     → hvac        (~1,418)
 *   Journeyperson Electrician        → electricidad (~4,926)
 *   Master Electrician               → electricidad (~3,533)
 *   Apprentice Electrician           → electricidad (~4,394)
 *
 * Total targeted records: ~23,759 professionals mapped to existing taxonomy
 * category keys — well above the 500-row quality floor for any single
 * category.
 *
 * Implementation note: the `city` column holds the licensee's mailing
 * address city (often out-of-state). We call ensureCity() with country=US
 * and the `state` column as the state code. Records whose city cannot be
 * resolved are dropped (they're typically foreign addresses or PO boxes).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick, type SocrataRow } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

const HOST = "data.delaware.gov";
const VIEW_ID = "pjnv-eaih";
const SOURCE_NAME = "delaware-dpr" as const;

/** License types to ingest and their category mapping. */
const LICENSE_TYPE_MAP: Record<string, CategoryKey> = {
  "Licensed Architect": "arquitecto",
  "Certificate of Authorization-Architect": "arquitecto",
  "Veterinarian": "veterinario",
  "Master Plumber": "fontaneria",
  "Master HVACR": "hvac",
  "Journeyperson Electrician": "electricidad",
  "Master Electrician": "electricidad",
  "Apprentice Electrician": "electricidad",
};

/** All license types we want — used to build a SoQL $where clause. */
const WANTED_TYPES = Object.keys(LICENSE_TYPE_MAP);

/** Build SoQL $where clause that matches any of our wanted license types. */
function buildWhereClause(): string {
  return WANTED_TYPES.map((t) => `license_type='${t}'`).join(" OR ");
}

interface RunOptions {
  maxRows?: number;
  batchSize?: number;
  dryRun?: boolean;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseName(row: SocrataRow): string | undefined {
  const first = socrataPick(row, ["first_name"]);
  const last = socrataPick(row, ["last_name"]);
  const combined = socrataPick(row, ["combined_name"]);
  if (first && last) return titleCase(`${first} ${last}`);
  if (combined) return titleCase(combined.replace(",", " ").replace(/\s+/g, " ").trim());
  return undefined;
}

export async function runDelawareDpr(
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
    where: buildWhereClause(),
  })) {
    for (const row of page) {
      if (scanned > 0 && scanned % PROGRESS_EVERY === 0) {
        const cs = getCityUpsertStats();
        const elapsed = ((Date.now() - lastProgressTs) / 1000).toFixed(1);
        console.log(
          `[delaware-dpr] progress scanned=${scanned} accepted=${accepted} written=${written} ` +
            `cities_created=${cs.inserted} geocoded=${cs.geocoded} +${elapsed}s`,
        );
        lastProgressTs = Date.now();
      }
      scanned += 1;

      const licenseNo = socrataPick(row, ["license_no"]);
      const licenseType = socrataPick(row, ["license_type"]);
      const cityRaw = socrataPick(row, ["city"]);
      const stateRaw = socrataPick(row, ["state"]);
      const name = parseName(row);

      if (!licenseNo || !licenseType || !cityRaw || !name) continue;

      const categoryKey = LICENSE_TYPE_MAP[licenseType];
      if (!categoryKey) continue;

      const cityResult = await ensureCity(client, {
        name: cityRaw,
        state: stateRaw,
        country: "US",
      });
      if (!cityResult) continue;

      const cityDisplay = titleCase(cityRaw);
      const status = socrataPick(row, ["license_status"]) ?? "Unknown";
      const issueDate = socrataPick(row, ["issue_date"]);
      const expirationDate = socrataPick(row, ["expiration_date"]);

      // Build a human-readable label for the profession
      const professionLabel = licenseType.replace("Certificate of Authorization-", "Certified ");

      buffer.push({
        source: SOURCE_NAME,
        sourceId: licenseNo,
        name,
        categoryKey,
        country: "US",
        citySlug: cityResult.slug,
        headline: `${professionLabel} en ${cityDisplay}`,
        description: `Licencia ${licenseNo} emitida por Delaware Division of Professional Regulation.`,
        licenseNumber: licenseNo,
        address: cityRaw && stateRaw ? `${cityDisplay}, ${stateRaw}` : undefined,
        metadata: {
          license_type: licenseType,
          license_status: status,
          profession_id: socrataPick(row, ["profession_id"]),
          issue_date: issueDate ? issueDate.split("T")[0] : undefined,
          expiration_date: expirationDate ? expirationDate.split("T")[0] : undefined,
          disciplinary_action: socrataPick(row, ["disciplinary_action"]),
          zip_code: socrataPick(row, ["zip_code"]),
          state: stateRaw,
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();
  const cityStats = getCityUpsertStats();
  console.log(
    `[delaware-dpr] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cityStats.inserted} geocoded=${cityStats.geocoded} ungeocoded=${cityStats.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ─────────────────────────────────────────────────────

const DEFAULT_LIMIT = 30_000;

export const delawareDprSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_DELAWARE_DPR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runDelawareDprSource(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!delawareDprSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_DELAWARE_DPR_LIMIT ?? DEFAULT_LIMIT);
  const maxRows = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runDelawareDpr(client, { maxRows });
  console.log(
    `[delaware-dpr] done — scanned=${scanned} accepted=${accepted} written=${written}`,
  );
  return { fetched: accepted, inserted: written, updated: 0, skipped: scanned - accepted };
}
