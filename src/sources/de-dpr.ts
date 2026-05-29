import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * Delaware Division of Professional Regulation — multi-category
 * professional licensing dataset.
 *
 * Dataset: "Professional and Occupational Licensing"
 * Portal:  https://data.delaware.gov/Licenses-and-Certifications/Professional-and-Occupational-Licensing/pjnv-eaih
 * API:     https://data.delaware.gov/resource/pjnv-eaih.json  (Socrata SODA v2)
 *
 * Pre-flight 2026-05-29:
 *   robots.txt — data.delaware.gov allows /resource/ paths. Only browse-UI
 *     filter params (/browse?*&category= etc.) and /api/odata/ are Disallowed.
 *     crawl-delay: 1 (respected via REQUEST_DELAY_MS). ✓
 *   API type — Socrata SODA v2 JSON. Plain GET, no auth, no JS, no Cloudflare.
 *     HTTP 200 from datacenter IPs. ✓
 *   Record counts (active, state=DE):
 *     Nursing                      20,404  → enfermeria
 *     Medical Practice              4,664  → medicina
 *     Electrical Examiners          3,843  → electricidad
 *     Physical Therapy/Athletic Trg 1,801  → fisioterapia
 *     Dentistry                     1,458  → dentista
 *     Plumbing/HVACR                1,096  → fontaneria / hvac
 *     Pharmacy                      1,107  → farmacia
 *     Veterinary Medicine             482  → veterinario
 *     Architecture                    166  → arquitecto
 *     Psychology                      337  → psicologia
 *     Total                        ~35,358 ✓ (>500 threshold met)
 *
 * Only records with state='DE' and license_status='Active' are ingested;
 * out-of-state rows are dropped.
 *
 * Env knobs:
 *   PROLIO_RUN_DE_DPR=true          enable
 *   PROLIO_DE_DPR_LIMIT=5000        max records (default 5000)
 */

const SOURCE_NAME = "de-dpr" as ScrapeSource;
const SODA_BASE = "https://data.delaware.gov/resource/pjnv-eaih.json";
const PAGE_SIZE = 1000;
const DEFAULT_LIMIT = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 1_100; // honour crawl-delay: 1 from robots.txt

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

// ---------------------------------------------------------------------------
// Profession → CategoryKey mapping
// ---------------------------------------------------------------------------

/** Map profession_id values from the dataset to Prolio category keys. */
const PROFESSION_CATEGORY: ReadonlyMap<string, CategoryKey> = new Map([
  ["Nursing",                        "enfermeria"],
  ["Medical Practice",               "medicina"],
  ["Electrical Examiners",           "electricidad"],
  ["Physical Therapy/Athletic Trg",  "fisioterapia"],
  ["Dentistry",                      "dentista"],
  ["Plumbing/HVACR",                 "fontaneria"],
  ["Pharmacy",                       "farmacia"],
  ["Veterinary Medicine",            "veterinario"],
  ["Architecture",                   "arquitecto"],
  ["Psychology",                     "psicologia"],
]);

// Plumbing/HVACR licence types that map to `hvac` instead of `fontaneria`
const HVAC_LICENSE_TYPES = new Set([
  "master hvacr",
  "master hvacr restricted",
  "hvacr temporary",
]);

function categoryForRecord(professionId: string, licenseType: string): CategoryKey | undefined {
  const base = PROFESSION_CATEGORY.get(professionId);
  if (!base) return undefined;
  // Sub-split Plumbing/HVACR into fontaneria vs hvac
  if (professionId === "Plumbing/HVACR" && HVAC_LICENSE_TYPES.has(licenseType.toLowerCase())) {
    return "hvac";
  }
  return base;
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

interface DprRecord {
  last_name?: string;
  first_name?: string;
  combined_name?: string;
  license_no?: string;
  profession_id?: string;
  license_type?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  issue_date?: string;
  expiration_date?: string;
  license_status?: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(
  professionId: string,
  offset: number,
): Promise<DprRecord[] | null> {
  const params = new URLSearchParams({
    $where: `profession_id='${professionId}' AND state='DE' AND license_status='Active'`,
    $limit: String(PAGE_SIZE),
    $offset: String(offset),
    $order: "license_no ASC",
  });
  const url = `${SODA_BASE}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[de-dpr] profession=${professionId} offset=${offset} HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as DprRecord[];
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[de-dpr] profession=${professionId} offset=${offset} error: ${(err as Error).message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Name builder
// ---------------------------------------------------------------------------

function buildName(r: DprRecord): string | undefined {
  // combined_name is "LAST,FIRST" — prefer reconstructed "First Last"
  const first = r.first_name?.trim() ?? "";
  const last = r.last_name?.trim() ?? "";
  if (first || last) {
    const full = [first, last].filter(Boolean).join(" ");
    return full
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }
  // Fallback: combined_name may be an organisation name
  const combined = r.combined_name?.trim();
  if (combined) {
    // Strip the LAST,FIRST comma-format if present
    const parts = combined.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 2) {
      return `${parts[1].charAt(0).toUpperCase()}${parts[1].slice(1).toLowerCase()} ${parts[0].charAt(0).toUpperCase()}${parts[0].slice(1).toLowerCase()}`;
    }
    return combined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Source export
// ---------------------------------------------------------------------------

export const deDprSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_DE_DPR === "true";
  },
  async fetch(): Promise<ScrapedProfessional[]> {
    return [];
  },
};

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runDeDpr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!deDprSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(process.env.PROLIO_DE_DPR_LIMIT ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  // Load US city index
  const cityIndex = new Map<string, string>();
  try {
    const cities = await getCities({ country: "US" });
    for (const c of cities) cityIndex.set(c.name.trim().toLowerCase(), c.slug);
  } catch (e) {
    console.warn(`[de-dpr] city load failed: ${(e as Error).message}`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  if (cityIndex.size === 0) {
    console.warn("[de-dpr] no US cities loaded — abort");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const seen = new Set<string>();
  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let droppedNoCity = 0;
  let droppedNoName = 0;

  for (const [professionId] of PROFESSION_CATEGORY) {
    if (totalFetched >= limit) break;
    let offset = 0;
    console.log(`[de-dpr] fetching profession="${professionId}"`);

    for (;;) {
      if (totalFetched >= limit) break;

      const page = await fetchPage(professionId, offset);
      if (!page || page.length === 0) break;

      const batch: ScrapedProfessional[] = [];

      for (const r of page) {
        if (totalFetched >= limit) break;

        const licenseNo = r.license_no?.trim();
        if (!licenseNo) continue;

        const licenseType = r.license_type?.trim() ?? "";
        const category = categoryForRecord(professionId, licenseType);
        if (!category) continue;

        const sourceId = `de-dpr:${licenseNo}`;
        if (seen.has(sourceId)) continue;
        seen.add(sourceId);

        const name = buildName(r);
        if (!name) {
          droppedNoName += 1;
          continue;
        }

        const rawCity = r.city?.trim() ?? "";
        const citySlug = cityIndex.get(rawCity.toLowerCase());
        if (!citySlug) {
          droppedNoCity += 1;
          continue;
        }

        totalFetched += 1;
        batch.push(
          normalise({
            source: SOURCE_NAME,
            country: "US",
            sourceId,
            name,
            categoryKey: category,
            citySlug,
            licenseNumber: licenseNo,
            metadata: {
              state: "DE",
              authority: "Delaware Division of Professional Regulation",
              verified_by_authority: true,
              profession_id: professionId,
              license_type: licenseType || null,
              zip: r.zip_code?.trim() ?? null,
              issue_date: r.issue_date ?? null,
              expiration_date: r.expiration_date ?? null,
            },
          }),
        );
      }

      if (batch.length > 0) {
        const res = await sink.upsert(batch);
        totalInserted += res.inserted;
        totalUpdated += res.updated;
        totalSkipped += res.skipped;
      }

      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      await delay(REQUEST_DELAY_MS);
    }
  }

  console.log(
    `[de-dpr] done — fetched=${totalFetched} inserted=${totalInserted} updated=${totalUpdated} skipped=${totalSkipped} droppedNoCity=${droppedNoCity} droppedNoName=${droppedNoName}`,
  );
  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    skipped: totalSkipped,
  };
}
