import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * NPI Physical Therapists — slice of the federal NPI registry filtered to
 * physical-therapy taxonomies. Companion to `npi-nurses` (same V2 API pattern).
 *
 * Categoría Prolio: `fisioterapia`.
 *
 * --- API probe (2026-05-20) -------------------------------------------
 *   GET https://npiregistry.cms.hhs.gov/api/?version=2.1
 *       &taxonomy_description=Physical+Therapist&state=CA&limit=200&skip=0
 *     → 200 OK, JSON {result_count:200, results:[…]}
 *
 *   GET https://npiregistry.cms.hhs.gov/api/?version=2.1
 *       &taxonomy_description=Physical+Therapist&state=NY&limit=200&skip=0
 *     → 200 OK, JSON {result_count:200, results:[…]}
 *
 *   Both states hit the 200-row cap, confirming ≥200 licensed PTs per
 *   state and a total US count well above 500. NPPES publishes ~230k
 *   individual Physical Therapist NPIs nationally.
 *
 *   Robots: npiregistry.cms.hhs.gov/robots.txt is permissive (no
 *   Disallow lines for the /api/ path). Public, unauthenticated, no
 *   WAF or CAPTCHA. Rate: 1 req/sec with polite UA is accepted.
 *
 *   limit max = 200, skip max = 1000 → max 1200 rows / (state,taxonomy).
 *   With 51 states × 4 PT taxonomies that's a ~245k theoretical ceiling
 *   per run. We cap PROLIO_NPI_PHYSICAL_THERAPISTS_LIMIT (default 100k).
 *
 * Off by default. `PROLIO_RUN_NPI_PHYSICAL_THERAPISTS=true` activates.
 * Monthly cron — see `.github/workflows/scrape-npi-physical-therapists.yml`.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const API = "https://npiregistry.cms.hhs.gov/api/";
const DEFAULT_LIMIT = 100_000;
const PAGE_SIZE = 200;
const MAX_SKIP = 1000; // API hard ceiling
const REQUEST_TIMEOUT_MS = 30_000;
const CATEGORY: CategoryKey = "fisioterapia";

const STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
];

/**
 * Physical therapy taxonomy descriptions accepted by the NPPES V2 API.
 * These match the taxonomy_description field in the NUCC taxonomy set.
 * "Physical Therapist" is the main individual taxonomy (~230k US NPIs).
 * "Physical Therapist Assistant" covers support staff.
 * "Physical Therapist in Sports" / "Physical Therapist in Neurology" are
 * specialty sub-codes that also surface via description search.
 */
const PT_TAXONOMIES = [
  "Physical Therapist",
  "Physical Therapist Assistant",
  "Physical Therapist in Geriatrics",
  "Physical Therapist in Neurology",
];

interface NppesAddress {
  address_1?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  telephone_number?: string;
  address_purpose?: string;
}
interface NppesBasic {
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  organization_name?: string;
}
interface NppesTaxonomy {
  code?: string;
  desc?: string;
  primary?: boolean;
  state?: string;
  license?: string;
}
interface NppesResult {
  number?: string | number;
  enumeration_type?: string;
  basic?: NppesBasic;
  addresses?: NppesAddress[];
  taxonomies?: NppesTaxonomy[];
}
interface NppesPage {
  result_count?: number;
  results?: NppesResult[];
  Errors?: Array<{ description?: string }>;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function normaliseUsPhone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

function pickLocation(
  result: NppesResult,
): { addr?: string; city?: string; state?: string; postal?: string; phone?: string } {
  const addrs = result.addresses ?? [];
  const loc =
    addrs.find((a) => a.address_purpose === "LOCATION") ??
    addrs.find((a) => a.address_purpose === "PRIMARY") ??
    addrs[0];
  if (!loc) return {};
  return {
    addr: loc.address_1,
    city: loc.city,
    state: loc.state,
    postal: loc.postal_code,
    phone: normaliseUsPhone(loc.telephone_number),
  };
}

function resultToScraped(
  result: NppesResult,
  cityIndex: Map<string, string>,
): ScrapedProfessional | null {
  const npi = String(result.number ?? "");
  if (!npi) return null;
  const basic = result.basic ?? {};
  const name =
    result.enumeration_type === "NPI-2"
      ? basic.organization_name
        ? titleCase(basic.organization_name)
        : undefined
      : [basic.first_name, basic.middle_name, basic.last_name]
          .filter((p): p is string => !!p && p.length > 0)
          .map(titleCase)
          .join(" ") || undefined;
  if (!name) return null;

  const loc = pickLocation(result);
  if (loc.addr && (!loc.city || !loc.state)) return null;
  const cityKey = loc.city?.trim().toLowerCase();
  const citySlug = cityKey ? cityIndex.get(cityKey) : undefined;
  if (!citySlug) return null;

  const taxes = result.taxonomies ?? [];
  const primary = taxes.find((t) => t.primary) ?? taxes[0];

  const addrParts = [loc.addr, loc.city, loc.state, loc.postal]
    .filter((p) => p && p.length > 0)
    .join(", ");

  return normalise({
    source: "npi-physical-therapists",
    country: "US",
    sourceId: `npi-physical-therapists:${npi}`,
    name,
    categoryKey: CATEGORY,
    citySlug,
    phone: loc.phone,
    address: addrParts || undefined,
    licenseNumber: npi,
    metadata: {
      country: "US",
      state: loc.state ?? undefined,
      npi,
      npi_taxonomy: primary?.code,
      npi_taxonomy_desc: primary?.desc,
      npi_license: primary?.license,
      npi_license_state: primary?.state,
      entity_type:
        result.enumeration_type === "NPI-2" ? "organization" : "individual",
      verified_by_authority: true,
      authority: "CMS NPI Registry",
    },
  });
}

async function fetchPage(
  taxonomy: string,
  state: string,
  skip: number,
): Promise<NppesPage | null> {
  const u = new URL(API);
  u.searchParams.set("version", "2.1");
  u.searchParams.set("taxonomy_description", taxonomy);
  u.searchParams.set("state", state);
  u.searchParams.set("country_code", "US");
  u.searchParams.set("limit", String(PAGE_SIZE));
  u.searchParams.set("skip", String(skip));
  try {
    const res = await fetch(u.toString(), {
      headers: { "User-Agent": POLITE_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[npi-physical-therapists] ${state}/${taxonomy}@${skip} → HTTP ${res.status}`,
      );
      return null;
    }
    return (await res.json()) as NppesPage;
  } catch (e) {
    console.warn(
      `[npi-physical-therapists] ${state}/${taxonomy}@${skip} fetch failed: ${(e as Error).message}`,
    );
    return null;
  }
}

export const npiPhysicalTherapistsSource: ScraperSource = {
  name: "npi-physical-therapists",
  enabled() {
    return process.env.PROLIO_RUN_NPI_PHYSICAL_THERAPISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runNpiPhysicalTherapists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!npiPhysicalTherapistsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(
    process.env.PROLIO_NPI_PHYSICAL_THERAPISTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const cityIndex = new Map<string, string>();
  try {
    const cities = await getCities({ country: "US" });
    for (const c of cities) cityIndex.set(c.name.trim().toLowerCase(), c.slug);
  } catch (e) {
    console.warn(
      `[npi-physical-therapists] city load failed: ${(e as Error).message}`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  if (cityIndex.size === 0) {
    console.warn("[npi-physical-therapists] no US cities loaded — abort");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const seen = new Set<string>();
  let batch: ScrapedProfessional[] = [];
  const sink = getSink();
  const FLUSH = 500;

  outer: for (const taxonomy of PT_TAXONOMIES) {
    for (const state of STATES) {
      let skip = 0;
      while (skip <= MAX_SKIP) {
        if (fetched >= limit) break outer;
        const page = await fetchPage(taxonomy, state, skip);
        if (!page || !page.results || page.results.length === 0) break;
        for (const r of page.results) {
          fetched += 1;
          const rec = resultToScraped(r, cityIndex);
          if (!rec) continue;
          if (seen.has(rec.sourceId)) continue;
          seen.add(rec.sourceId);
          batch.push(rec);
          if (batch.length >= FLUSH) {
            const res = await sink.upsert(batch);
            inserted += res.inserted;
            updated += res.updated;
            skipped += res.skipped;
            batch = [];
          }
        }
        if (page.results.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
      }
    }
  }
  if (batch.length > 0) {
    const res = await sink.upsert(batch);
    inserted += res.inserted;
    updated += res.updated;
    skipped += res.skipped;
  }

  console.log(
    `[npi-physical-therapists] done — fetched=${fetched} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched, inserted, updated, skipped };
}
