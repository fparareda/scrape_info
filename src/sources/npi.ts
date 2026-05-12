import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * NPI Registry — US healthcare provider scraper.
 *
 * The National Provider Identifier (NPI) registry is the official US
 * directory of healthcare providers operated by CMS. Public JSON API,
 * no auth, no key. ~7M individual + organisational providers.
 *
 *   https://npiregistry.cms.hhs.gov/api/?version=2.1
 *
 * Strategy: iterate (state × taxonomy) tuples and page via &skip. The
 * API requires at least 2 search criteria when state is supplied
 * (probe 2026-04-24: state=CA alone returns "Field state requires
 * additional search criteria"), so we always pair state with
 * taxonomy_description. We use the taxonomy description (e.g.
 * "Family Medicine") because the API rejects bare codes for that
 * field. We retain the code in metadata + license_number flow.
 *
 * Off by default. Enable via PROLIO_RUN_NPI=true. Per-state cap via
 * PROLIO_NPI_LIMIT_PER_STATE (default 200). Total ceiling
 * 51 × 5 × 200 = 51k absolute, ~10k realistic after city/taxonomy
 * pruning. Monthly cron — see .github/workflows/scrape-npi.yml.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 25_000;
const PAGE_SIZE = 200;
const DEFAULT_LIMIT_PER_STATE = 200;

const US_STATES: readonly string[] = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
  "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

interface TaxonomyEntry {
  code: string;
  description: string;
  category: CategoryKey;
}

// Five taxonomies — kept small so a full run stays well under any
// reasonable wall-clock budget. Codes from the NUCC Health Care
// Provider Taxonomy. `description` matches what the API returns and
// is used for the search filter.
// Note on category mapping: our public CategoryKey enum has only 9
// keys today and lacks dedicated `dentista` / `fisioterapeuta` slots.
// All medical taxonomies fold into `medicina`; Psychologist maps to
// `psicologia`. The granular taxonomy is preserved in
// metadata.npi_taxonomy + metadata.npi_taxonomy_desc so a future
// taxonomy split can re-bucket without re-scraping.
const TAXONOMIES: readonly TaxonomyEntry[] = [
  { code: "207Q00000X", description: "Family Medicine",     category: "medicina" },
  { code: "122300000X", description: "Dentist",             category: "medicina" },
  { code: "103T00000X", description: "Psychologist",        category: "psicologia" },
  { code: "224P00000X", description: "Physical Therapist",  category: "medicina" },
  { code: "207L00000X", description: "Anesthesiology",      category: "medicina" },
];

// --- API types (loose; API ships nullable fields) ----------------------

interface NpiAddress {
  address_1?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  telephone_number?: string;
  address_purpose?: string;
}
interface NpiTaxonomy {
  code?: string;
  desc?: string;
  license?: string;
  primary?: boolean;
  state?: string;
}
interface NpiBasic {
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  credential?: string;
  organization_name?: string;
  name?: string;
}
interface NpiResult {
  number?: string | number;
  enumeration_type?: string; // "NPI-1" individual, "NPI-2" org
  basic?: NpiBasic;
  addresses?: NpiAddress[];
  taxonomies?: NpiTaxonomy[];
}
interface NpiResponse {
  result_count?: number;
  results?: NpiResult[];
  Errors?: Array<{ description?: string; field?: string; number?: string }>;
}

// --- Helpers -----------------------------------------------------------

function normaliseUsPhone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

function buildName(basic: NpiBasic | undefined): string | undefined {
  if (!basic) return undefined;
  const org = basic.organization_name?.trim();
  if (org) return org;
  const parts = [basic.first_name, basic.middle_name, basic.last_name]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  // NPI returns names UPPERCASE. Title-case for presentation.
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

function pickAddress(addresses: NpiAddress[] | undefined): NpiAddress | undefined {
  if (!Array.isArray(addresses) || addresses.length === 0) return undefined;
  const loc = addresses.find((a) => a.address_purpose === "LOCATION");
  return loc ?? addresses[0];
}

async function fetchNpiPage(
  state: string,
  taxonomyDesc: string,
  skip: number,
): Promise<NpiResponse | null> {
  const url =
    `https://npiregistry.cms.hhs.gov/api/?version=2.1` +
    `&state=${encodeURIComponent(state)}` +
    `&taxonomy_description=${encodeURIComponent(taxonomyDesc)}` +
    `&limit=${PAGE_SIZE}&skip=${skip}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": POLITE_UA, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(`[npi] ${state}/${taxonomyDesc} skip=${skip} status=${response.status}`);
      return null;
    }
    return (await response.json()) as NpiResponse;
  } catch (error) {
    clearTimeout(timer);
    console.warn(
      `[npi] ${state}/${taxonomyDesc} skip=${skip} error: ${(error as Error).message}`,
    );
    return null;
  }
}

// --- Public entrypoint -------------------------------------------------

export const npiSource: ScraperSource = {
  name: "npi",
  enabled() {
    return process.env.PROLIO_RUN_NPI === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNpi(): Promise<void> {
  if (!npiSource.enabled()) return;

  const perStateLimit = (() => {
    const raw = Number(process.env.PROLIO_NPI_LIMIT_PER_STATE ?? DEFAULT_LIMIT_PER_STATE);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT_PER_STATE;
  })();

  // Build a set of US city slugs from public.cities. Drop rows whose
  // city doesn't map to a seeded slug — the sink would drop them
  // anyway, but pre-filtering keeps batches small.
  const cityIndex = new Map<string, string>();
  try {
    const usCities = await getCities({ country: "US" });
    for (const c of usCities) {
      cityIndex.set(c.name.trim().toLowerCase(), c.slug);
    }
  } catch (e) {
    console.warn(`[npi] failed to load US cities: ${(e as Error).message}`);
    return;
  }
  if (cityIndex.size === 0) {
    console.warn(`[npi] no US cities loaded — aborting`);
    return;
  }

  const sink = getSink();
  let totalFetched = 0;
  let totalUpserted = 0;
  let totalSkipped = 0;
  let totalDroppedNoCity = 0;
  const seen = new Set<string>();

  for (const state of US_STATES) {
    let perStateCount = 0;
    for (const tax of TAXONOMIES) {
      if (perStateCount >= perStateLimit) break;
      let skip = 0;
      // Pagination: stop on empty page or when per-state cap hit.
      for (;;) {
        if (perStateCount >= perStateLimit) break;
        const page = await fetchNpiPage(state, tax.description, skip);
        if (!page || !Array.isArray(page.results) || page.results.length === 0) break;

        const batch: ScrapedProfessional[] = [];
        for (const r of page.results) {
          if (perStateCount >= perStateLimit) break;
          const npi = r.number != null ? String(r.number).trim() : "";
          if (!npi) continue;
          const sourceId = `npi:${npi}`;
          if (seen.has(sourceId)) continue;
          const name = buildName(r.basic);
          if (!name) continue;
          const addr = pickAddress(r.addresses);
          const cityRaw = addr?.city?.trim().toLowerCase();
          const citySlug = cityRaw ? cityIndex.get(cityRaw) : undefined;
          if (!citySlug) {
            totalDroppedNoCity += 1;
            continue;
          }
          seen.add(sourceId);
          perStateCount += 1;

          const taxRow = (r.taxonomies ?? []).find((t) => t.primary) ?? r.taxonomies?.[0];
          const addressParts = [addr?.address_1, addr?.city, addr?.state, addr?.postal_code]
            .map((p) => (typeof p === "string" ? p.trim() : ""))
            .filter((p) => p.length > 0);

          batch.push(
            normalise({
              source: "npi",
              sourceId,
              name,
              categoryKey: tax.category,
              citySlug,
              phone: normaliseUsPhone(addr?.telephone_number),
              address: addressParts.length > 0 ? addressParts.join(", ") : undefined,
              licenseNumber: taxRow?.license?.trim() || undefined,
              metadata: {
                country: "US",
                state: addr?.state ?? state,
                npi,
                npi_taxonomy: taxRow?.code ?? tax.code,
                npi_taxonomy_desc: taxRow?.desc ?? tax.description,
                enumeration_type: r.enumeration_type,
                verified_by_authority: true,
                authority: "CMS NPI Registry",
              },
            }),
          );
        }

        totalFetched += page.results.length;
        if (batch.length > 0) {
          const { inserted, updated, skipped } = await sink.upsert(batch);
          totalUpserted += inserted + updated;
          totalSkipped += skipped;
        }
        if (page.results.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
      }
    }
    console.log(
      `[npi] ${state}: count=${perStateCount} (cap ${perStateLimit})`,
    );
  }
  console.log(
    `[npi] done — fetched=${totalFetched} upserted=${totalUpserted} ` +
      `skipped=${totalSkipped} droppedNoCity=${totalDroppedNoCity}`,
  );
}
