import type { ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { fetchSocrataJson, socrataPick } from "./_socrata-utils.js";

/**
 * Texas Notary Public Commissions — data.texas.gov (Socrata).
 *
 * The Texas Secretary of State publishes the full notary commission
 * dataset as an open Socrata dataset. Every row is a government-issued
 * notary commission with name, full street address, email, commission
 * number, and effective/expiry dates.
 *
 * Pre-flight (2026-06-26):
 *   - Dataset:  Texas Notary Public Commissions
 *   - Socrata:  data.texas.gov / view ID gmd3-bnrd
 *   - API URL:  https://data.texas.gov/resource/gmd3-bnrd.json
 *   - Robots:   data.texas.gov/robots.txt — /resource/ is unrestricted;
 *               crawl-delay 1 s. Verified with two sample fetches.
 *   - Records:  ~558,898 active commissions (Dec 2025 update).
 *   - Fields:   notary_id · first_name · last_name · address · city ·
 *               state · zip · email_address · effective_date ·
 *               expire_date · surety_company
 *   - Auth:     none — fully public.
 *   - WAF:      none observed.
 *   - TOS:      Texas Open Data Portal — standard state-gov open data,
 *               no commercial-use restriction.
 *
 * Category → notario.  First US source for this category (all
 * prior notario sources cover ES, MX, and CA/BC).
 *
 * Off by default. Enable via PROLIO_RUN_TX_NOTARY_PUBLIC=true.
 * Monthly cron (scrape-tx-notary-public.yml). Commissions are
 * annual/4-year terms; monthly is sufficient to catch new and
 * expiring commissions.
 *
 * Budget knob: PROLIO_TX_NOTARY_PUBLIC_LIMIT (default 50000).
 */

const SOCRATA_HOST = "data.texas.gov";
const SOCRATA_VIEW_ID = "gmd3-bnrd";
const DEFAULT_LIMIT = 50_000;
const SOURCE_NAME = "tx-notary-public";

export const txNotaryPublicSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_TX_NOTARY_PUBLIC === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runTxNotaryPublic(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!txNotaryPublicSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_TX_NOTARY_PUBLIC_LIMIT ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[${SOURCE_NAME}] done — fetched=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}

async function fetchAll(limit: number) {
  const out = [];
  const seen = new Set<string>();
  let droppedNoCity = 0;
  let droppedNoName = 0;

  for await (const page of fetchSocrataJson({
    host: SOCRATA_HOST,
    viewId: SOCRATA_VIEW_ID,
    pageSize: 1_000,
    maxRows: limit,
    order: "notary_id",
  })) {
    for (const row of page) {
      const notaryId = socrataPick(row, ["notary_id"]);
      if (!notaryId) continue;

      const firstName = socrataPick(row, ["first_name"]) ?? "";
      const lastName = socrataPick(row, ["last_name"]) ?? "";
      const name = `${firstName} ${lastName}`.trim();
      if (!name) {
        droppedNoName += 1;
        continue;
      }

      const rawCity = socrataPick(row, ["city"]);
      const citySlug = rawCity ? slugify(rawCity) : undefined;
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      const dedupeKey = `${SOURCE_NAME}:${notaryId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const street = socrataPick(row, ["address"]);
      const state = socrataPick(row, ["state"]) ?? "TX";
      const zip = socrataPick(row, ["zip"]);
      const address = [street, rawCity, state, zip].filter(Boolean).join(", ");

      out.push(
        normalise({
          source: SOURCE_NAME,
          country: "US",
          sourceId: dedupeKey,
          name,
          categoryKey: "notario",
          citySlug,
          email: socrataPick(row, ["email_address"]) ?? undefined,
          address: address || undefined,
          licenseNumber: notaryId,
          metadata: {
            country: "US",
            state: "TX",
            authority: "Texas Secretary of State",
            verified_by_authority: true,
            effective_date: socrataPick(row, ["effective_date"]) ?? undefined,
            expire_date: socrataPick(row, ["expire_date"]) ?? undefined,
            surety_company: socrataPick(row, ["surety_company"]) ?? undefined,
          },
        }),
      );
    }
  }

  console.log(
    `[${SOURCE_NAME}] parsed=${out.length} ` +
      `droppedNoName=${droppedNoName} droppedNoCity=${droppedNoCity}`,
  );
  return out;
}
