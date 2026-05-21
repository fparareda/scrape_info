import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";
import { fetchAlinityDirectory } from "./_alinity-utils.js";

/**
 * MVMA — Manitoba Veterinary Medical Association.
 *
 * Public directory at
 *   https://mvma.alinityapp.com/Client/PublicDirectory
 * (Alinity tenant `mvma`, querySID=1000544 as of 2026-05-21).
 *
 * The same register lists Veterinarians and Veterinary Technologists.
 * For the `veterinario` category we keep only entries whose `reg`
 * (registration class) names a Veterinarian; Technologists go to a
 * separate category (paraveterinario / técnico) if/when added.
 *
 * Pre-flight 2026-05-21 (datacenter IP):
 *   GET https://mvma.alinityapp.com/Client/PublicDirectory → 200 in
 *   ~1.5s, querySID discoverable, no Cloudflare, no CAPTCHA. Existing
 *   `_alinity-utils` helper handles tenant search + prefix recursion.
 *
 * Off by default — `PROLIO_RUN_MVMA_MB_VETS=true` to enable.
 * Cap via `PROLIO_MVMA_MB_VETS_LIMIT` (default 3_000 — universe ~1k
 * vets + ~600 techs).
 */

const TENANT = "mvma";
const AUTHORITY = "MVMA";
const PROVINCE = "MB";
const CATEGORY: CategoryKey = "veterinario";
const DEFAULT_CITY = "winnipeg"; // largest MB city; directory is province-wide
const DEFAULT_LIMIT = 3_000;

const MB_CITIES: Record<string, string> = {
  winnipeg: "winnipeg",
  brandon: "winnipeg",
};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return MB_CITIES[k] ?? DEFAULT_CITY;
}

function isVeterinarian(status: string | undefined): boolean {
  if (!status) return true; // keep when missing — better recall than precision here
  return /veterinarian/i.test(status) && !/technolog/i.test(status);
}

export const mvmaMbVetsSource: ScraperSource = {
  name: "mvma-mb-vets" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_MVMA_MB_VETS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runMvmaMbVets(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!mvmaMbVetsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_MVMA_MB_VETS_LIMIT ?? DEFAULT_LIMIT);
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let skippedKind = 0;

  for await (const rec of fetchAlinityDirectory(TENANT, { limit: cap * 2 })) {
    if (records.length >= cap) break;
    if (!isVeterinarian(rec.status)) {
      skippedKind += 1;
      continue;
    }
    const num =
      rec.registrationNumber ?? `${rec.name}-${rec.city ?? ""}`;
    const key = `mvma:${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(
      normalise({
        source: "mvma-mb-vets" as ScrapeSource,
        country: "CA",
        sourceId: key,
        name: toTitleCase(rec.name),
        categoryKey: CATEGORY,
        citySlug: mapCity(rec.city),
        licenseNumber: rec.registrationNumber,
        metadata: {
          country: "CA",
          province: PROVINCE,
          authority: AUTHORITY,
          verified_by_authority: true,
          registration_class: rec.status,
          registration_date: rec.registrationDate,
          practice_city_raw: rec.city ?? null,
        },
      }),
    );
  }

  if (records.length === 0) {
    console.warn(
      `[mvma-mb-vets] no Veterinarian rows (skippedNonVet=${skippedKind}) — Alinity endpoint may have changed`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[mvma-mb-vets] done — fetched=${records.length} skippedNonVet=${skippedKind} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
