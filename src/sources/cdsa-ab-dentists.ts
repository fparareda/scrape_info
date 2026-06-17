import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { fetchThentiaDirectory } from "./_thentia-utils.js";

/**
 * CDSA — College of Dental Surgeons of Alberta (Thentia Cloud).
 *
 * Mandatory regulatory registry of Alberta dentists, hosted at:
 *   https://cdsa.portalca.thentiacloud.net/webs/portal/register/#/
 * (linked from https://cdsab.ca footer → "Dentist Directory").
 *
 * Pre-flight (2026-06-06):
 *   - robots.txt (cdsab.ca): ALLOWED — only blocks Gravity Forms admin
 *     paths and /wp-admin/. No restrictions on registrant directory.
 *   - Technology: Thentia Cloud SPA. The _thentia-utils fetchThentiaDirectory
 *     auto-discovers the REST endpoint at the tenant root.
 *   - Tenant: cdsa.portalca (base: https://cdsa.portalca.thentiacloud.net/)
 *   - Record count: ~4,000–5,000 licensed Alberta dentists.
 *   - No anti-scraping ToS found on cdsab.ca or the Thentia portal.
 *   - Gap filled: Alberta dentists (RCDSO=Ontario, ODQ=Quebec, BCCOHP=BC).
 *
 * CategoryKey: dentista (mandatory regulatory registry, all records are
 * licensed dentists).
 *
 * Off by default. Enable via `PROLIO_RUN_CDSA_AB_DENTISTS=true`.
 * Cap via `PROLIO_CDSA_AB_DENTISTS_LIMIT` (default 5000).
 * Monthly cadence (dental rolls update annually).
 */

const TENANT = "cdsa.portalca";
const DEFAULT_LIMIT = 5_000;
const CATEGORY: CategoryKey = "dentista";
const DEFAULT_CITY = "edmonton";

const AB_CITY_MAP: Record<string, string> = {
  edmonton: "edmonton",
  calgary: "calgary",
  "red deer": "red-deer",
  lethbridge: "lethbridge",
  "medicine hat": "medicine-hat",
  "grande prairie": "grande-prairie",
  "fort mcmurray": "fort-mcmurray",
  airdrie: "airdrie",
  leduc: "leduc",
  "st. albert": "st-albert",
  "st albert": "st-albert",
  "fort saskatchewan": "fort-saskatchewan",
  "sherwood park": "sherwood-park",
  "spruce grove": "spruce-grove",
  camrose: "camrose",
  lloydminster: "lloydminster",
  wetaskiwin: "wetaskiwin",
  beaumont: "beaumont",
  "cold lake": "cold-lake",
  lacombe: "lacombe",
  canmore: "canmore",
  banff: "banff",
  "brooks": "brooks",
  "high river": "high-river",
};

function mapCity(raw: string | undefined): string {
  if (!raw) return DEFAULT_CITY;
  const k = raw.toLowerCase().trim();
  return AB_CITY_MAP[k] ?? DEFAULT_CITY;
}

export const cdsaAbDentistsSource: ScraperSource = {
  name: "cdsa-ab-dentists" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CDSA_AB_DENTISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCdsaAbDentists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cdsaAbDentistsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(
    process.env.PROLIO_CDSA_AB_DENTISTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoName = 0;
  let droppedInactive = 0;

  for await (const rec of fetchThentiaDirectory(TENANT, { limit })) {
    if (!rec.name || rec.name.trim().length === 0) {
      droppedNoName += 1;
      continue;
    }

    // Skip non-Active registrants when status is available.
    if (rec.status && !/active|current|registered/i.test(rec.status)) {
      droppedInactive += 1;
      continue;
    }

    const licNum = rec.licenseNumber ?? `${rec.name.slice(0, 30)}-${rec.city ?? ""}`;
    const sourceId = `cdsa:${licNum}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const citySlug = mapCity(rec.city);

    records.push(
      normalise({
        source: "cdsa-ab-dentists" as ScrapeSource,
        country: "CA",
        sourceId,
        name: rec.name.trim(),
        categoryKey: CATEGORY,
        citySlug,
        address: rec.address,
        phone: rec.phone,
        email: rec.email,
        website: rec.website,
        licenseNumber: rec.licenseNumber ?? undefined,
        metadata: {
          province: rec.province ?? "AB",
          status: rec.status,
          verified_by_authority: true,
          authority: "CDSA",
          country: "CA",
          raw: rec.raw,
        },
      }),
    );
  }

  if (records.length === 0) {
    console.log(
      `[cdsa-ab-dentists] done — accepted=0 ` +
        `droppedNoName=${droppedNoName} droppedInactive=${droppedInactive}`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[cdsa-ab-dentists] done — accepted=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped} ` +
      `droppedNoName=${droppedNoName} droppedInactive=${droppedInactive}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
