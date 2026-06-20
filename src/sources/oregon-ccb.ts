import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { fetchSocrataJson, socrataPick, type SocrataRow } from "./_socrata-utils.js";
import { ensureCity, getCityUpsertStats } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { getSink } from "../sink.js";

/**
 * Oregon CCB — Construction Contractors Board (data.oregon.gov, Socrata).
 *
 * Dataset `g77e-6bhs` ("CCB Active Licenses") on data.oregon.gov.
 * ~56k currently-licensed contractor *businesses* who can legally work in
 * Oregon. This is distinct from Oregon BCD (vhbr-cuaq, see oregon-bcd.ts),
 * which licenses individual electrical/plumbing/HVAC *trade workers*.
 *
 *   https://data.oregon.gov/Regulatory/CCB-Active-Licenses/g77e-6bhs
 *
 * Verified (2026-06-19) via `?$limit=1` (HTTP 200). Real columns:
 *   license_number, license_type (code, e.g. CGC2), endorsement_text
 *   (human label, e.g. "Commercial General Contractor Level 2"),
 *   full_name, address, city, state, zip_code, phone_number,
 *   county_name, lic_exp_date, rmi_name. The dataset contains only active
 *   licenses (no status column needed).
 *
 * The previous default URL (oregon.gov/ccb/.../Active_Licensees.csv) was
 * fabricated and returned no usable rows. Replaced with the real Socrata
 * JSON endpoint.
 *
 * CCB endorsements are contractor classifications, not trade verticals.
 * Mapping: Locksmith → cerrajero; everything else (general / specialty /
 * residential / commercial / developer / home-inspector / …) →
 * carpinteria (general construction), matching the Iowa DIAL convention.
 *
 * Off by default. Enable via `PROLIO_RUN_OREGON_CCB=true`.
 * Cap via `PROLIO_OREGON_CCB_LIMIT` (default 80000).
 */

const HOST = "data.oregon.gov";
const VIEW_ID = "g77e-6bhs";
const SOURCE_NAME = "oregon-ccb" as const;
const DEFAULT_LIMIT = 80_000;

function endorsementToCategory(raw: string | undefined): CategoryKey {
  const d = (raw ?? "").toLowerCase();
  if (d.includes("locksmith")) return "cerrajero";
  if (d.includes("electric")) return "electricidad";
  if (d.includes("plumb")) return "fontaneria";
  if (d.includes("hvac") || d.includes("heating") || d.includes("refrig"))
    return "hvac";
  // General / specialty / residential / commercial / developer / inspector
  // → general construction.
  return "carpinteria";
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildAddress(row: SocrataRow): string | undefined {
  const parts: string[] = [];
  const street = socrataPick(row, ["address"]);
  const city = socrataPick(row, ["city"]);
  const state = socrataPick(row, ["state"]) || "OR";
  const zip = socrataPick(row, ["zip_code", "zip"]);
  if (street) parts.push(street);
  if (city) parts.push(city);
  if (state) parts.push(state);
  if (zip) parts.push(zip);
  return parts.length > 0 ? parts.join(", ") : undefined;
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

export async function runOregonCcbBulk(
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
          `[oregon-ccb] progress scanned=${scanned} accepted=${accepted} written=${written} ` +
            `cities_created=${cs.inserted} +${elapsed}s`,
        );
        lastProgressTs = Date.now();
      }
      scanned += 1;

      const licNum = socrataPick(row, ["license_number"]);
      const nameRaw = socrataPick(row, ["full_name"]);
      const cityRaw = socrataPick(row, ["city"]);
      if (!licNum || !nameRaw || !cityRaw) continue;

      const endorsement = socrataPick(row, ["endorsement_text", "license_type"]);
      const category = endorsementToCategory(endorsement);

      const dedupeKey = `${licNum}:${category}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const cityResult = await ensureCity(client, {
        name: titleCase(cityRaw),
        state: socrataPick(row, ["state"]) || "OR",
        country: "US",
      });
      if (!cityResult) continue;

      buffer.push({
        source: SOURCE_NAME as ScrapeSource,
        sourceId: `oregon-ccb:${licNum}:${category}`,
        name: titleCase(nameRaw),
        categoryKey: category,
        country: "US",
        citySlug: cityResult.slug,
        address: buildAddress(row),
        phone: normalisePhone(socrataPick(row, ["phone_number"])),
        licenseNumber: licNum,
        metadata: {
          state: "OR",
          country: "US",
          authority: "Oregon CCB",
          verified_by_authority: true,
          ccb_endorsement: endorsement,
          county: socrataPick(row, ["county_name"]),
          expiration_date: socrataPick(row, ["lic_exp_date"]),
        },
      });
      accepted += 1;
      if (buffer.length >= batchSize) await flush();
    }
  }
  await flush();

  const cs = getCityUpsertStats();
  console.log(
    `[oregon-ccb] done — scanned=${scanned} accepted=${accepted} written=${written} ` +
      `cities_created=${cs.inserted} geocoded=${cs.geocoded} ungeocoded=${cs.failedGeocode}`,
  );
  return { scanned, accepted, written };
}

// ── ScraperSource wrapper ────────────────────────────────────────────────────

export const oregonCcbSource: ScraperSource = {
  name: SOURCE_NAME as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_OREGON_CCB === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOregonCcb(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!oregonCcbSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_OREGON_CCB_LIMIT ?? DEFAULT_LIMIT);
  const maxRows =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const client = getSupabaseClient();
  const { scanned, accepted, written } = await runOregonCcbBulk(client, {
    maxRows,
  });
  console.log(
    `[oregon-ccb] source done — scanned=${scanned} accepted=${accepted} written=${written}`,
  );
  return { fetched: accepted, inserted: written, updated: 0, skipped: scanned - accepted };
}
