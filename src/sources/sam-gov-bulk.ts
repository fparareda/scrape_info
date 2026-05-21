/**
 * SAM.gov Entity Management bulk ingest. SAM publishes a daily/monthly
 * Public Extract V2 of all entities registered to do business with the
 * US federal government (~700k active). Each row has NAICS codes that
 * map cleanly to our trade/professional CategoryKey set — unlike NPPES
 * which is healthcare-only, this widens the US net into HVAC, plumbing,
 * legal, accounting, engineering, architecture.
 *
 * Source: https://sam.gov/data-services (Entity Management Public Extract)
 *
 * Access caveat: SAM gates the bulk file behind a sam.gov account +
 * data.gov API key. The workflow handles the download and points us at
 * the extracted CSV via PROLIO_SAM_BULK_URL — same convention as
 * nppes-bulk. If the env var isn't set, the run no-ops via `enabled()`.
 *
 * Why a separate source from the per-row APIs:
 *   - Single nightly pass vs. enrichment-per-lead.
 *   - source_kind=`sam-gov-bulk` so dedup picks bulk as authoritative.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import { bulkCsvLoad } from "../lib/bulk-csv-loader.js";
import { buildProfessionalSlug, slugifyName } from "../lib/slug-id.js";

const DEFAULT_URL =
  process.env.PROLIO_SAM_BULK_URL || "/tmp/sam/SAM_FOUO_V2.csv";

const DEFAULT_MAX_ROWS = 300_000;

/**
 * NAICS 2022 prefix → CategoryKey. Exact 6-digit codes are checked
 * first; falls back to 4-digit industry group. Categories without a
 * meaningful federal-contractor footprint (extranjeria, notario, itv,
 * cerrajero) are omitted — those rows are dropped at filter time.
 */
const NAICS_TO_CATEGORY: Array<[RegExp, CategoryKey]> = [
  [/^541110/, "abogado"],
  [/^541211/, "fiscal"],
  [/^541213/, "fiscal"], // tax preparation
  [/^541219/, "fiscal"],
  [/^621111/, "medicina"],
  [/^621112/, "medicina"],
  [/^621210/, "dentista"],
  [/^621310/, "fisioterapia"], // chiropractors — closest fit
  [/^621340/, "fisioterapia"], // physical / occupational therapists
  [/^621330/, "psicologia"], // mental health practitioners
  [/^621399/, "enfermeria"],
  [/^621610/, "enfermeria"], // home health
  [/^446110/, "farmacia"],
  [/^541310/, "arquitecto"],
  [/^54133/, "ingenieria"],
  [/^238110/, "fontaneria"], // foundation/structure — closest base
  [/^238210/, "electricidad"],
  [/^238220/, "hvac"],
  [/^238160/, "carpinteria"], // roofing — adjusted below
  [/^238350/, "carpinteria"], // finish carpentry
  [/^811111/, "mecanica"],
  [/^811112/, "mecanica"],
  [/^811121/, "mecanica"],
  [/^541940/, "veterinario"],
];

function mapNaics(primary: string | undefined, list: string | undefined): CategoryKey | null {
  const candidates: string[] = [];
  if (primary) candidates.push(primary.trim());
  if (list) {
    // SAM ships NAICS_CODE_LIST as pipe- or tilde-separated, e.g.
    // "541110~541199~561110". Split on any non-digit.
    for (const c of list.split(/[^0-9]+/)) {
      if (c && !candidates.includes(c)) candidates.push(c);
    }
  }
  for (const code of candidates) {
    for (const [re, cat] of NAICS_TO_CATEGORY) {
      if (re.test(code)) return cat;
    }
  }
  return null;
}

interface CityIndex {
  bySlug: Map<string, { slug: string; name: string }>;
}

async function loadUsCityIndex(client: SupabaseClient): Promise<CityIndex> {
  const bySlug = new Map<string, { slug: string; name: string }>();
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await client
      .from("cities")
      .select("slug, name")
      .or("country.eq.US,country.eq.us")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`loadUsCityIndex: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) bySlug.set(row.slug, { slug: row.slug, name: row.name });
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { bySlug };
}

interface SamProfessionalRow extends Record<string, unknown> {
  source: "sam-gov-bulk";
  source_id: string;
  slug: string;
  name: string;
  category_key: CategoryKey;
  city_slug: string;
  city_country: "US";
  headline: string;
  description: string;
  phone: string | null;
  address: string | null;
  website: string | null;
  license_number: string | null;
  metadata: Record<string, unknown>;
  is_published: boolean;
  tier: "free";
  claim_status: "unclaimed";
}

// Column header aliases — SAM has changed names between extract versions.
// Try the new V2 name first, then the legacy "FOUO" V1 name.
function col(row: Record<string, string>, names: string[]): string | undefined {
  for (const n of names) {
    const v = row[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export async function runSamGovBulk(
  client: SupabaseClient,
): Promise<{ scanned: number; accepted: number; written: number }> {
  const url = DEFAULT_URL;
  const maxRows = Number.parseInt(
    process.env.PROLIO_SAM_BULK_LIMIT ?? `${DEFAULT_MAX_ROWS}`,
    10,
  );

  console.log(`[sam-gov-bulk] starting; url=${url} max=${maxRows}`);
  const cities = await loadUsCityIndex(client);
  console.log(`[sam-gov-bulk] loaded ${cities.bySlug.size} US cities`);

  const seen = new Set<string>();

  const result = await bulkCsvLoad<SamProfessionalRow>(client, {
    url,
    table: "professionals",
    onConflict: "source,source_id",
    batchSize: 1000,
    maxRows,
    progressEvery: 50_000,
    onProgress(scanned, accepted) {
      console.log(`[sam-gov-bulk] progress scanned=${scanned} accepted=${accepted}`);
    },
    mapRow(row) {
      const uei = col(row, ["Unique Entity ID", "UEI", "ENTITY_UEI"]);
      if (!uei || seen.has(uei)) return null;
      seen.add(uei);

      // Only ACTIVE registrations — purgative records have a delete flag
      // or a past expiration. Tolerant: if missing, accept.
      const status = col(row, ["Registration Status", "REGISTRATION_STATUS"]);
      if (status && status.toUpperCase() !== "ACTIVE") return null;

      const primaryNaics = col(row, ["Primary NAICS Code", "PRIMARY_NAICS"]);
      const naicsList = col(row, ["NAICS Code List", "NAICS_CODE_STRING", "NAICS_CODE_LIST"]);
      const categoryKey = mapNaics(primaryNaics, naicsList);
      if (!categoryKey) return null;

      const name = col(row, ["Legal Business Name", "LEGAL_BUSINESS_NAME"]);
      if (!name) return null;

      const cityRaw = col(row, [
        "Physical Address City",
        "PHYSICAL_ADDRESS_CITY",
      ]);
      if (!cityRaw) return null;
      const citySlug = slugifyName(cityRaw);
      const cityMatch = cities.bySlug.get(citySlug);
      if (!cityMatch) return null;

      // US-only — Public Extract can include foreign registrations.
      const country = col(row, ["Physical Address Country", "PHYSICAL_ADDRESS_COUNTRY_CODE"]);
      if (country && country.toUpperCase() !== "USA" && country.toUpperCase() !== "US") return null;

      const state = col(row, ["Physical Address State", "PHYSICAL_ADDRESS_STATE_CODE"]);
      const postal = col(row, ["Physical Address Zip Code", "PHYSICAL_ADDRESS_ZIP_CODE_5"]);
      const line1 = col(row, ["Physical Address Line 1", "PHYSICAL_ADDRESS_LINE_1"]);
      const address = [line1, cityMatch.name, state, postal].filter(Boolean).join(", ");

      const phone = col(row, ["Entity Phone", "ENTITY_PHONE"]) ?? null;
      const website = col(row, ["Entity URL", "ENTITY_URL"]) ?? null;
      const cage = col(row, ["CAGE Code", "CAGE_CODE"]);

      return {
        source: "sam-gov-bulk",
        source_id: uei,
        slug: buildProfessionalSlug(name, uei),
        name,
        category_key: categoryKey,
        city_slug: cityMatch.slug,
        city_country: "US",
        headline: `${categoryKey} en ${cityMatch.name}`,
        description: `${name} — registro federal SAM.gov UEI ${uei}.`,
        phone,
        address: address || null,
        website,
        license_number: cage ?? null,
        metadata: {
          uei,
          cage: cage ?? null,
          primary_naics: primaryNaics ?? null,
          state: state ?? null,
        },
        is_published: true,
        tier: "free",
        claim_status: "unclaimed",
      };
    },
  });

  console.log(
    `[sam-gov-bulk] done in ${Math.round(result.durationMs / 1000)}s — ` +
      `scanned ${result.scanned} accepted ${result.accepted} written ${result.written}`,
  );
  return result;
}

export const samGovBulkSource = {
  name: "sam-gov-bulk" as const,
  enabled(): boolean {
    return process.env.PROLIO_RUN_SAM_GOV_BULK === "true";
  },
};
