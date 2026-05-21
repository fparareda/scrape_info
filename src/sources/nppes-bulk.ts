/**
 * NPI bulk re-ingest. The NPPES Public Disclosure file ships monthly at
 * `https://download.cms.gov/nppes/NPI_Files.html` — a ~6 GB CSV inside
 * a ZIP, containing every US healthcare provider that's registered for
 * Medicare/Medicaid billing (~7.5M rows).
 *
 * The pre-existing `npi.ts` source pulls one NPI at a time via the REST
 * API for the enrich phase — total in DB ~12k. This bulk version is the
 * Sprint 2 of the 500k-per-country plan (2026-05-16): a single nightly
 * pass over the public file fills medicina + dentista + veterinario +
 * enfermeria + farmacia for the US in one shot, capped at the target.
 *
 * Why a separate source from `npi`:
 *   - Different cadence (monthly bulk vs. per-row API).
 *   - Different `source_kind` (`nppes-bulk` vs. `npi`) so dedup picks
 *     the bulk row as authoritative on collision.
 *   - Different shape: bulk has phone + license + practice address;
 *     the API enrich was just adding taxonomies on top of a Google row.
 *
 * Disk: streams via `bulkCsvLoad`, so even on a 1 GB GH Actions runner
 * the ~6 GB file fits — we never buffer more than `batchSize` × ~1 KB.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryKey } from "../prolio-types.js";
import { bulkCsvLoad } from "../lib/bulk-csv-loader.js";
import { buildProfessionalSlug, slugifyName } from "../lib/slug-id.js";

// Monthly archive URL. CMS publishes a fresh archive on the 2nd Monday
// at https://download.cms.gov/nppes/NPI_Files.html. The file ships as
// a ZIP (~1 GB) containing a CSV — fetch() can't stream inside ZIP, so
// the workflow downloads + unzips first and points this scraper at the
// extracted CSV via PROLIO_NPPES_BULK_URL.
//
// `||` (not `??`) so an empty string from workflow_dispatch without
// inputs falls through to the default.
const DEFAULT_URL =
  process.env.PROLIO_NPPES_BULK_URL ||
  "/tmp/nppes/npidata_pfile.csv";

// Hard cap on accepted rows per run. The plan target is 500k per
// country; we keep room for other US sources by capping NPI's bulk
// import at this number. Run with `PROLIO_NPPES_BULK_LIMIT` to
// override (e.g. for catch-up imports).
const DEFAULT_MAX_ROWS = 500_000;

/**
 * Map a NUCC taxonomy code prefix to one of our CategoryKey values.
 * Only the categories we actively expose are listed; everything else
 * is dropped at filter time.
 *
 * Sources: nucc.org code-set (10.1.2026 release).
 */
const TAXONOMY_TO_CATEGORY: Array<[RegExp, CategoryKey]> = [
  [/^122/, "dentista"], // 1223* Dentist + sub-specialties
  [/^174M/, "veterinario"], // 174M00000X Veterinary
  [/^174K/, "veterinario"], // legacy code
  [/^163W/, "enfermeria"], // Registered Nurse
  [/^364S/, "enfermeria"], // Clinical Nurse Specialist
  [/^367/, "enfermeria"], // CNS + Midwife + Nurse Practitioner
  [/^183/, "farmacia"], // 1835* Pharmacist (and 1845)
  [/^156F/, "psicologia"], // Counselor
  [/^103T/, "psicologia"], // Psychologist
  [/^1041C/, "psicologia"], // Social Worker (clinical)
  [/^207/, "medicina"], // Allopathic & Osteopathic Physicians
  [/^208/, "medicina"],
  [/^261Q/, "medicina"], // Clinic/Center
  [/^363/, "medicina"], // Physician Assistant
  [/^261/, "medicina"],
];

function mapTaxonomy(code: string | undefined): CategoryKey | null {
  if (!code) return null;
  for (const [re, cat] of TAXONOMY_TO_CATEGORY) {
    if (re.test(code)) return cat;
  }
  return null;
}

interface CityIndex {
  /** slugified city name → (slug, country='us') */
  bySlug: Map<string, { slug: string; name: string }>;
}

async function loadUsCityIndex(client: SupabaseClient): Promise<CityIndex> {
  // We only need the city slugs in the US set. With ~10k US cities the
  // single SELECT is well under PostgREST's 1000-row default cap when we
  // chunk; use range pagination.
  const bySlug = new Map<string, { slug: string; name: string }>();
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await client
      .from("cities")
      // 2026-05-18: was `.eq("country", "us")` — but the cities table
      // stores country uppercase ("US"), per the rest of the scraper
      // (src/cities.ts line ~372). Empty match → loaded 0 US cities →
      // every NPI row got dropped at the city lookup step. Match both
      // cases defensively in case of mixed legacy rows.
      .select("slug, name")
      .or("country.eq.US,country.eq.us")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`loadUsCityIndex: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      bySlug.set(row.slug, { slug: row.slug, name: row.name });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { bySlug };
}

interface NpiProfessionalRow extends Record<string, unknown> {
  source: "nppes-bulk";
  source_id: string;
  slug: string;
  name: string;
  category_key: CategoryKey;
  city_slug: string;
  headline: string;
  description: string;
  phone: string | null;
  address: string | null;
  license_number: string | null;
  metadata: Record<string, unknown>;
  is_published: boolean;
  tier: "free";
  claim_status: "unclaimed";
}

function buildName(row: Record<string, string>): string | null {
  // Entity Type Code: 1 = Individual, 2 = Organization
  const entity = row["Entity Type Code"];
  if (entity === "2") {
    const orgName = row["Provider Organization Name (Legal Business Name)"];
    return orgName?.trim() || null;
  }
  // Individual
  const first = row["Provider First Name"]?.trim() ?? "";
  const last = row["Provider Last Name (Legal Name)"]?.trim() ?? "";
  if (!first && !last) return null;
  // Title-case the upper-case bulk values for the rendered card.
  const titleCase = (s: string): string =>
    s
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  return `${titleCase(first)} ${titleCase(last)}`.trim();
}

/**
 * Top-level run. Streams the bulk file, filters rows by taxonomy →
 * CategoryKey + city slug match against our US city set, and upserts
 * into `professionals`. Idempotent on `(source, source_id)` so a re-run
 * after a refresh skips anything already-seen.
 */
export async function runNppesBulk(
  client: SupabaseClient,
): Promise<{ scanned: number; accepted: number; written: number }> {
  const url = DEFAULT_URL;
  const maxRows = Number.parseInt(
    process.env.PROLIO_NPPES_BULK_LIMIT ?? `${DEFAULT_MAX_ROWS}`,
    10,
  );

  console.log(`[nppes-bulk] starting; url=${url} max=${maxRows}`);
  const cities = await loadUsCityIndex(client);
  console.log(`[nppes-bulk] loaded ${cities.bySlug.size} US cities`);

  const seen = new Set<string>();

  const result = await bulkCsvLoad<NpiProfessionalRow>(client, {
    url,
    table: "professionals",
    onConflict: "source,source_id",
    batchSize: 1000,
    maxRows,
    progressEvery: 100_000,
    onProgress(scanned, accepted) {
      console.log(
        `[nppes-bulk] progress scanned=${scanned} accepted=${accepted}`,
      );
    },
    mapRow(row) {
      const npi = row.NPI?.trim();
      if (!npi || seen.has(npi)) return null;
      seen.add(npi);

      // Taxonomy 1 is the primary; we'd consider 2-15 if needed but
      // skipping for v1 to keep the row count tight.
      const taxonomy = row["Healthcare Provider Taxonomy Code_1"]?.trim();
      const categoryKey = mapTaxonomy(taxonomy);
      if (!categoryKey) return null;

      const name = buildName(row);
      if (!name) return null;

      const cityRaw =
        row["Provider Business Practice Location Address City Name"]?.trim();
      if (!cityRaw) return null;
      const citySlug = slugifyName(cityRaw);
      const cityMatch = cities.bySlug.get(citySlug);
      if (!cityMatch) return null;

      const phone =
        row[
          "Provider Business Practice Location Address Telephone Number"
        ]?.trim() || null;
      const addrLine =
        row[
          "Provider First Line Business Practice Location Address"
        ]?.trim();
      const state = row[
        "Provider Business Practice Location Address State Name"
      ]?.trim();
      const postal = row[
        "Provider Business Practice Location Address Postal Code"
      ]?.trim();
      const address = [addrLine, cityMatch.name, state, postal]
        .filter(Boolean)
        .join(", ");

      const licenseNumber =
        row["Provider License Number_1"]?.trim() || null;

      return {
        source: "nppes-bulk",
        source_id: npi,
        slug: buildProfessionalSlug(name, npi),
        name,
        category_key: categoryKey,
        city_slug: cityMatch.slug,
        headline: `${categoryKey} en ${cityMatch.name}`,
        description: `${name} — registro NPI #${npi}. Datos públicos NPPES (CMS).`,
        phone,
        address: address || null,
        license_number: licenseNumber,
        metadata: {
          npi,
          taxonomy_primary: taxonomy ?? null,
          entity_type: row["Entity Type Code"] ?? null,
          state: state ?? null,
        },
        is_published: true,
        tier: "free",
        claim_status: "unclaimed",
      };
    },
  });

  console.log(
    `[nppes-bulk] done in ${Math.round(result.durationMs / 1000)}s — ` +
      `scanned ${result.scanned} accepted ${result.accepted} ` +
      `written ${result.written}`,
  );
  return result;
}

export const nppesBulkSource = {
  name: "nppes-bulk" as const,
  enabled(): boolean {
    return process.env.PROLIO_RUN_NPPES_BULK === "true";
  },
};
