import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * CMS PECOS — Doctors and Clinicians (Provider Enrollment, Chain, and
 * Ownership System). The public dataset under `data.cms.gov` dataset
 * `mj5m-pzi6` exposes ~3.37M Medicare-enrolled individual clinicians
 * with real practice addresses, primary specialty, telephone, NPI and
 * gender. It's the operational complement to the NPI registry:
 *
 *  - NPI Registry   → universe of enumerated providers (~7M, taxonomy)
 *  - CMS PECOS      → those actively billing Medicare (~3M, *practice*
 *                     address & specialty as actually used)
 *
 * Discovery (2026-05-14 probe):
 *   GET https://data.cms.gov/provider-data/api/1/datastore/query/mj5m-pzi6/0?limit=1
 *   →  3,378,753 results. Sample row:
 *     {
 *       "npi":"1235888272",
 *       "provider_last_name":"BAEZ MUNIZ",
 *       "provider_first_name":"EDUARDO",
 *       "pri_spec":"CLINICAL PSYCHOLOGIST",
 *       "adr_ln_1":"", "citytown":"AGUADA", "state":"PR",
 *       "zip_code":"00602", "telephone_number":"9392994522", ...
 *     }
 *
 * The DKAN datastore supports `?limit=&offset=` for paging. We use
 * 1000-row pages (the docs cap individual responses at 10k but 1000 is
 * a friendlier choice when running for hours).
 *
 * Mapping:
 *   pri_spec → CategoryKey:
 *     - PSYCHOLOGIST / CLINICAL PSYCHOLOGIST → psicologia
 *     - DENTIST*                             → dentista
 *     - PHYSICAL THERAPIST                   → medicina   (no fisio slot)
 *     - everything else (MD/DO/PA/NP/…)      → medicina
 *
 * Veterinarians are not in PECOS (Medicare doesn't enroll vets), so we
 * don't emit `veterinario` from this source.
 *
 * Off by default. `PROLIO_RUN_CMS_PECOS=true` activates. Hard cap with
 * `PROLIO_CMS_PECOS_LIMIT` (default 200000). Monthly cron — see
 * .github/workflows/scrape-cms-pecos.yml.
 */

const DATASTORE_URL =
  "https://data.cms.gov/provider-data/api/1/datastore/query/mj5m-pzi6/0";
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 1000;
const DEFAULT_LIMIT = 200_000;

interface PecosRow {
  npi?: string;
  ind_pac_id?: string;
  provider_last_name?: string;
  provider_first_name?: string;
  provider_middle_name?: string;
  suff?: string;
  gndr?: string;
  cred?: string;
  pri_spec?: string;
  facility_name?: string;
  org_pac_id?: string;
  adr_ln_1?: string;
  adr_ln_2?: string;
  citytown?: string;
  state?: string;
  zip_code?: string;
  telephone_number?: string;
}

interface PecosResponse {
  results?: PecosRow[];
  count?: number;
}

function normaliseUsPhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((p) => (p.length > 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ");
}

function buildName(row: PecosRow): string | undefined {
  const last = row.provider_last_name?.trim();
  const first = row.provider_first_name?.trim();
  const mid = row.provider_middle_name?.trim();
  const parts = [first, mid, last].filter((p) => p && p.length > 0) as string[];
  if (parts.length === 0) {
    const facility = row.facility_name?.trim();
    return facility ? titleCase(facility) : undefined;
  }
  return parts.map(titleCase).join(" ");
}

function categoryFromSpecialty(raw: string | undefined): CategoryKey {
  if (!raw) return "medicina";
  const s = raw.toUpperCase();
  if (s.includes("PSYCHOLOG")) return "psicologia";
  if (s.includes("DENTIST") || s.includes("DENTAL")) return "dentista";
  // Physical therapist, MD/DO/PA/NP/podiatrist/etc → medicina.
  return "medicina";
}

async function fetchPage(offset: number): Promise<PecosResponse | null> {
  const url = `${DATASTORE_URL}?limit=${PAGE_SIZE}&offset=${offset}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": POLITE_UA, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(`[cms-pecos] offset=${offset} status=${response.status}`);
      return null;
    }
    return (await response.json()) as PecosResponse;
  } catch (error) {
    clearTimeout(timer);
    console.warn(
      `[cms-pecos] offset=${offset} error: ${(error as Error).message}`,
    );
    return null;
  }
}

export const cmsPecosEnabled = (): boolean =>
  process.env.PROLIO_RUN_CMS_PECOS === "true";

export const cmsPecosSource: ScraperSource = {
  name: "cms-pecos" as ScrapeSource,
  enabled: cmsPecosEnabled,
  async fetch() {
    return [];
  },
};

export async function runCmsPecos(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cmsPecosEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_CMS_PECOS_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const cityIndex = new Map<string, string>();
  try {
    const usCities = await getCities({ country: "US" });
    for (const c of usCities) {
      cityIndex.set(c.name.trim().toLowerCase(), c.slug);
    }
  } catch (e) {
    console.warn(`[cms-pecos] failed to load US cities: ${(e as Error).message}`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  if (cityIndex.size === 0) {
    console.warn(`[cms-pecos] no US cities loaded — aborting`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  return withScrapeRun("cms-pecos", async () => {
    const sink = getSink();
    let offset = 0;
    let totalFetched = 0;
    let totalUpserted = 0;
    let totalSkipped = 0;
    let droppedNoCity = 0;
    const seen = new Set<string>();
    let kept = 0;

    while (kept < limit) {
      const page = await fetchPage(offset);
      if (!page || !Array.isArray(page.results) || page.results.length === 0)
        break;
      totalFetched += page.results.length;

      const batch: ScrapedProfessional[] = [];
      for (const r of page.results) {
        if (kept >= limit) break;
        const npi = r.npi?.trim();
        if (!npi || npi.length < 8) continue;
        // Individual clinicians have unique NPIs; PECOS can list the
        // same NPI at multiple addresses. Key on NPI+PAC for stability.
        const pac = (r.ind_pac_id ?? "").trim();
        const sourceId = `cms-pecos:${npi}${pac ? `:${pac}` : ""}`;
        if (seen.has(sourceId)) continue;

        const name = buildName(r);
        if (!name) continue;
        const cityRaw = r.citytown?.trim().toLowerCase();
        const citySlug = cityRaw ? cityIndex.get(cityRaw) : undefined;
        if (!citySlug) {
          droppedNoCity += 1;
          continue;
        }
        seen.add(sourceId);
        kept += 1;

        const addrParts = [r.adr_ln_1, r.adr_ln_2, r.citytown, r.state, r.zip_code]
          .map((p) => (typeof p === "string" ? p.trim() : ""))
          .filter((p) => p.length > 0);

        batch.push(
          normalise({
            source: "cms-pecos" as ScrapeSource,
            country: "US",
            sourceId,
            name,
            categoryKey: categoryFromSpecialty(r.pri_spec),
            citySlug,
            phone: normaliseUsPhone(r.telephone_number),
            address: addrParts.length > 0 ? addrParts.join(", ") : undefined,
            licenseNumber: npi,
            metadata: {
              country: "US",
              state: r.state,
              npi,
              ind_pac_id: pac || undefined,
              pri_spec: r.pri_spec || undefined,
              credential: r.cred || undefined,
              gender: r.gndr || undefined,
              facility_name: r.facility_name || undefined,
              org_pac_id: r.org_pac_id || undefined,
              verified_by_authority: true,
              authority: "CMS PECOS (Medicare)",
            },
          }),
        );
      }

      if (batch.length > 0) {
        const { inserted, updated, skipped } = await sink.upsert(batch);
        totalUpserted += inserted + updated;
        totalSkipped += skipped;
      }
      if (page.results.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    console.log(
      `[cms-pecos] done — fetched=${totalFetched} kept=${kept} ` +
        `upserted=${totalUpserted} skipped=${totalSkipped} ` +
        `droppedNoCity=${droppedNoCity}`,
    );
    return {
      rowsFetched: totalFetched,
      rowsUpserted: totalUpserted,
      rowsSkipped: totalSkipped,
      metadata: { kept, droppedNoCity },
    };
  }).then((r) => ({
    fetched: r?.rowsFetched ?? 0,
    inserted: 0,
    updated: 0,
    skipped: r?.rowsSkipped ?? 0,
  }));
}
