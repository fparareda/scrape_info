/**
 * IRS Exempt Organizations Business Master File (BMF) bulk ingest.
 * The IRS publishes monthly per-region CSVs (eo1.csv … eo4.csv) listing
 * every 501(c) non-profit recognized in the US (~1.8M rows total) with
 * EIN, name, address, and NTEE classification.
 *
 * Source: https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf
 *
 * Coverage caveat: BMF is non-profits only — most rows are charities
 * that don't map to any scrape_info CategoryKey. Only the slice with
 * NTEE codes in healthcare, mental health, animal welfare, and legal
 * services is kept (~50-80k rows expected after filtering).
 *
 * Workflow downloads each regional CSV and concatenates (or runs the
 * source four times); we point at one extracted CSV via
 * PROLIO_IRS_BMF_URL — same convention as nppes-bulk.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import { bulkCsvLoad } from "../lib/bulk-csv-loader.js";
import { buildProfessionalSlug, slugifyName } from "../lib/slug-id.js";

const DEFAULT_URL = process.env.PROLIO_IRS_BMF_URL || "/tmp/irs-bmf/eo_xx.csv";
const DEFAULT_MAX_ROWS = 200_000;

/**
 * NTEE major group / decile → CategoryKey. NTEE is a hierarchical code
 * (letter + 2 digits, e.g. "E20" = General Hospitals). We match the
 * most specific prefix that has a meaningful equivalent in our taxonomy.
 *
 * Reference: https://nccs.urban.org/project/national-taxonomy-exempt-entities-ntee-codes
 */
const NTEE_TO_CATEGORY: Array<[RegExp, CategoryKey]> = [
  [/^E2/, "medicina"], // E20 Hospitals, E21 Community Health
  [/^E30/, "medicina"], // Ambulatory health
  [/^E32/, "medicina"], // Community Clinics
  [/^E40/, "medicina"], // Reproductive Health Care
  [/^E50/, "medicina"], // Rehabilitative care
  [/^E70/, "enfermeria"], // Public Health Programs
  [/^F2/, "psicologia"], // Substance Abuse
  [/^F3/, "psicologia"], // Mental Health Treatment
  [/^F4/, "psicologia"], // Hot Lines / Crisis
  [/^F6/, "psicologia"], // Counseling
  // NTEE D20 ("Animal Protection & Welfare") is shelters/humane
  // societies, not vets — kept out to avoid polluting `veterinario`.
  // Only D40 ("Veterinary Services") is the real match.
  [/^D4/, "veterinario"],
  [/^I80/, "abogado"], // Legal Services
  [/^I83/, "abogado"], // Public Interest Law
];

function mapNtee(code: string | undefined): CategoryKey | null {
  if (!code) return null;
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return null;
  for (const [re, cat] of NTEE_TO_CATEGORY) {
    if (re.test(trimmed)) return cat;
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

interface IrsBmfProfessionalRow extends Record<string, unknown> {
  source: "irs-bmf-bulk";
  source_id: string;
  slug: string;
  name: string;
  category_key: CategoryKey;
  city_slug: string;
  city_country: "US";
  headline: string;
  description: string;
  phone: null;
  address: string | null;
  license_number: string;
  metadata: Record<string, unknown>;
  is_published: boolean;
  tier: "free";
  claim_status: "unclaimed";
}

// Headers in the BMF CSV are upper-case short codes; the file ships
// without a stable header label but the IRS publishes a data dictionary
// matching: EIN, NAME, ICO, STREET, CITY, STATE, ZIP, GROUP, SUBSECTION,
// ... , NTEE_CD, SORT_NAME.
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function runIrsBmfBulk(
  client: SupabaseClient,
): Promise<{ scanned: number; accepted: number; written: number }> {
  const url = DEFAULT_URL;
  const maxRows = Number.parseInt(
    process.env.PROLIO_IRS_BMF_LIMIT ?? `${DEFAULT_MAX_ROWS}`,
    10,
  );

  console.log(`[irs-bmf-bulk] starting; url=${url} max=${maxRows}`);
  const cities = await loadUsCityIndex(client);
  console.log(`[irs-bmf-bulk] loaded ${cities.bySlug.size} US cities`);

  const seen = new Set<string>();

  const result = await bulkCsvLoad<IrsBmfProfessionalRow>(client, {
    url,
    table: "professionals",
    onConflict: "source,source_id",
    batchSize: 1000,
    maxRows,
    progressEvery: 100_000,
    onProgress(scanned, accepted) {
      console.log(`[irs-bmf-bulk] progress scanned=${scanned} accepted=${accepted}`);
    },
    mapRow(row) {
      const ein = row.EIN?.trim();
      if (!ein || seen.has(ein)) return null;
      seen.add(ein);

      const categoryKey = mapNtee(row.NTEE_CD);
      if (!categoryKey) return null;

      const rawName = row.NAME?.trim();
      if (!rawName) return null;
      const name = titleCase(rawName);

      const cityRaw = row.CITY?.trim();
      if (!cityRaw) return null;
      const citySlug = slugifyName(cityRaw);
      const cityMatch = cities.bySlug.get(citySlug);
      if (!cityMatch) return null;

      const state = row.STATE?.trim();
      const zip = row.ZIP?.trim();
      const street = row.STREET?.trim();
      const address = [street, cityMatch.name, state, zip].filter(Boolean).join(", ");

      const ntee = row.NTEE_CD?.trim() || null;
      const subsection = row.SUBSECTION?.trim() || null;

      return {
        source: "irs-bmf-bulk",
        source_id: ein,
        slug: buildProfessionalSlug(name, ein),
        name,
        category_key: categoryKey,
        city_slug: cityMatch.slug,
        city_country: "US",
        headline: `${categoryKey} en ${cityMatch.name}`,
        description: `${name} — organización 501(c) reconocida por el IRS, EIN ${ein}.`,
        phone: null,
        address: address || null,
        license_number: ein,
        metadata: {
          ein,
          ntee_cd: ntee,
          subsection,
          state: state ?? null,
        },
        is_published: true,
        tier: "free",
        claim_status: "unclaimed",
      };
    },
  });

  console.log(
    `[irs-bmf-bulk] done in ${Math.round(result.durationMs / 1000)}s — ` +
      `scanned ${result.scanned} accepted ${result.accepted} written ${result.written}`,
  );
  return result;
}

export const irsBmfBulkSource = {
  name: "irs-bmf-bulk" as const,
  enabled(): boolean {
    return process.env.PROLIO_RUN_IRS_BMF_BULK === "true";
  },
};
