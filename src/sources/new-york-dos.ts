import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick, type SocrataRow } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

/**
 * New York DOS — Department of State, Division of Licensing Services
 * (data.ny.gov, Socrata).
 *
 * The original scraper targeted electricians / plumbers / HVAC bulk CSV
 * (`8ks6-44gj`), but that view 404s AND the NY DOS Division of Licensing
 * Services does not license construction trades at all — those are
 * municipal in NY. The DOS *does* publish, per-profession, the licensees
 * it actually regulates (notaries, real-estate, appearance enhancement,
 * security guards…). Of these, the one that maps cleanly to a Prolio
 * CategoryKey with name + locality + licence number is:
 *
 *   Commissioned NYS Notaries Public — dataset `rwbv-mz6z`
 *   https://data.ny.gov/Government-Finance/Commissioned-NYS-Notaries-Public/rwbv-mz6z
 *   → CategoryKey "notario"  (~232k active commissions)
 *
 * Verified (2026-06-19) via `?$limit=1` (HTTP 200). Real columns:
 *   commission_holder_name, commission_number_uid, commissioned_county,
 *   commission_type_traditional_or_electronic, term_issue_date,
 *   term_expiration_date.
 *
 * NOTE: the dataset carries no street/city — only the commissioning
 * county. We use the county as the locality (via ensureCity), which is the
 * correct geographic granularity NY publishes for notaries.
 *
 * Off by default. Enable via `PROLIO_RUN_NEW_YORK_DOS=true`.
 * Cap via `PROLIO_NEW_YORK_DOS_LIMIT` (default 80000).
 */

const HOST = "data.ny.gov";
const VIEW_ID = "rwbv-mz6z";
const SOURCE_NAME = "new-york-dos" as const;
const DEFAULT_LIMIT = 80_000;

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

interface RunOptions {
  maxRows?: number;
  batchSize?: number;
}

export async function runNewYorkDosBulk(
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
  })) {
    for (const row of page) {
      if (scanned > 0 && scanned % PROGRESS_EVERY === 0) {
        const cs = getCityUpsertStats();
        const elapsed = ((Date.now() - lastProgressTs) / 1000).toFixed(1);
        console.log(
          `[new-york-dos] progress scanned=${scanned} accepted=${accepted} written=${written} ` +
            `cities_created=${cs.inserted} +${elapsed}s`,
        );
        lastProgressTs = Date.now();
      }
      scanned += 1;

      const licNum = socrataPick(row, ["commission_number_uid"]);
      const nameRaw = socrataPick(row, ["commission_holder_name"]);
      const countyRaw = socrataPick(row, ["commissioned_county"]);
      if (!licNum || !nameRaw || !countyRaw) continue;

      const dedupeKey = licNum;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const cityResult = await ensureCity(client, {
        name: titleCase(countyRaw),
        state: "NY",
        country: "US",
      });
      if (!cityResult) continue;

      buffer.push({
        source: SOURCE_NAME as ScrapeSource,
        sourceId: `new-york-dos:${licNum}`,
        name: titleCase(nameRaw),
        categoryKey: "notario",
        country: "US",
        citySlug: cityResult.slug,
        licenseNumber: licNum,
        metadata: {
          state: "NY",
          country: "US",
          authority: "New York DOS",
          verified_by_authority: true,
          dos_license_type: "Notary Public",
          commissioned_county: countyRaw,
          commission_type: socrataPick(row, [
            "commission_type_traditional_or_electronic",
          ]),
          expiration_date: socrataPick(row, ["term_expiration_date"]),
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();

  const cs = getCityUpsertStats();
  console.log(
    `[new-york-dos] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ────────────────────────────────────────────────────

export const newYorkDosSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_NEW_YORK_DOS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNewYorkDos(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!newYorkDosSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_NEW_YORK_DOS_LIMIT ?? DEFAULT_LIMIT);
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runNewYorkDosBulk(client, {
    maxRows,
  });
  console.log(
    `[new-york-dos] source done — scanned=${scanned} accepted=${accepted} written=${written}`,
  );
  return { fetched: accepted, inserted: written, updated: 0, skipped: scanned - accepted };
}
