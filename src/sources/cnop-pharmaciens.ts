import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { splitCsvLine, frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * CNOP — Conseil National de l'Ordre des Pharmaciens. The dataset
 * "les-pharmacies" referenced in earlier docs no longer exists on
 * data.gouv.fr (verified 2026-05). The next-best canonical source for
 * the national list of officines is FINESS itself, filtered to
 * `categetab=620` ("Pharmacie d'Officine"). ~21k officines.
 *
 *   Source: same CSV as `finess` source —
 *     https://www.data.gouv.fr/datasets/finess-extraction-du-fichier-des-etablissements
 *     Resource: etalab-cs1100502-stock-<date>.csv
 *   License: Lov2.
 *
 * Pharmacien individuels (~74k) live in the ANS extract covered by
 * `annuaire-sante-ans`; no overlap.
 *
 * Category: `medicina` (officine ≈ medical retail / pharmacie).
 *
 * Off by default. `PROLIO_RUN_CNOP_PHARMACIENS=true` to enable.
 * Cap with `PROLIO_CNOP_PHARMACIENS_LIMIT` (default 10000 covers full).
 */

const FINESS_DATASET_API =
  "https://www.data.gouv.fr/api/1/datasets/finess-extraction-du-fichier-des-etablissements/";
const PHARMACY_CATEGETAB = "620"; // Pharmacie d'Officine in FINESS nomenclature
const DEFAULT_LIMIT = 10000;
const USER_AGENT =
  "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";

interface DatasetResource {
  title?: string;
  format?: string;
  url?: string;
}
interface DatasetMeta {
  resources?: DatasetResource[];
}

async function findFinessCsvUrl(): Promise<string | null> {
  try {
    const response = await fetch(FINESS_DATASET_API, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const meta = (await response.json()) as DatasetMeta;
    const resources = meta.resources ?? [];
    const target =
      resources.find((r) => /cs1100502/i.test(r.url ?? "")) ||
      resources.find((r) => /cs1100507/i.test(r.url ?? ""));
    return target?.url ?? null;
  } catch (error) {
    console.error(
      `[cnop-pharmaciens] metadata failed: ${(error as Error).message}`,
    );
    return null;
  }
}

function parseLigneAcheminement(s: string): { cp: string; ville: string } {
  const m = s.trim().match(/^(\d{5})\s+(.+?)(?:\s+CEDEX(?:\s+\d+)?)?$/i);
  if (!m) return { cp: "", ville: s.trim() };
  return { cp: m[1], ville: m[2].trim() };
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const overrideUrl = process.env.PROLIO_CNOP_PHARMACIENS_CSV;
  const url = overrideUrl || (await findFinessCsvUrl());
  if (!url) {
    console.error("[cnop-pharmaciens] no FINESS CSV URL available");
    return [];
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    console.error(
      `[cnop-pharmaciens] download failed: ${(error as Error).message}`,
    );
    return [];
  }
  if (!response.ok) {
    console.error(`[cnop-pharmaciens] ${response.status} on ${url}`);
    return [];
  }
  const text = await response.text();
  const lines = text.split(/\r?\n/);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    if (out.length >= limit) break;
    const line = lines[i];
    if (!line) continue;
    const cells = splitCsvLine(line, ";");
    if (cells[0] !== "structureet") continue;
    if (cells.length < 22) continue;

    const categetab = (cells[18] ?? "").trim();
    const libcategetab = (cells[19] ?? "").trim();
    // FINESS code 620 = Pharmacie d'Officine. Belt-and-braces: also
    // accept entries whose libellé clearly identifies an officine in
    // case the numeric code is missing on edge rows.
    const isOfficine =
      categetab === PHARMACY_CATEGETAB ||
      /officine/i.test(libcategetab) ||
      /pharmacie/i.test(libcategetab);
    if (!isOfficine) continue;

    const finess = (cells[1] ?? "").trim();
    if (!finess || seen.has(finess)) continue;
    seen.add(finess);

    const { cp, ville } = parseLigneAcheminement(cells[15] ?? "");
    const citySlug = frPostalCodeToCitySlug(cp);
    if (!citySlug) continue;

    const name = (cells[4] || cells[3] || "").trim();
    if (!name) continue;

    const street = [cells[7], cells[8], cells[9]]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join(" ");
    const address = [street, cp, ville].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "cnop-pharmaciens" as ScrapeSource,
        sourceId: `cnop:${finess}`,
        name,
        categoryKey: "medicina",
        citySlug,
        phone: (cells[16] ?? "").trim() || undefined,
        address: address || undefined,
        licenseNumber: finess,
        metadata: {
          country: "FR",
          authority:
            "FINESS — Pharmacie d'Officine (categetab 620, surfaced via CNOP source)",
          verified_by_authority: true,
          profession: "pharmacie-officine",
          finess,
          finess_juridique: cells[2] || undefined,
          siret: cells[22] || undefined,
          categetab,
          libcategetab,
        },
      }),
    );
  }

  console.log(`[cnop-pharmaciens] parsed=${out.length}`);
  return out;
}

export const cnopPharmaciensSource: ScraperSource = {
  name: "cnop-pharmaciens" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CNOP_PHARMACIENS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCnopPharmaciens(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cnopPharmaciensSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_CNOP_PHARMACIENS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[cnop-pharmaciens] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
