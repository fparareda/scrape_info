import type { CategoryKey } from "../prolio-types.js";
import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { splitCsvLine, frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * FINESS — Fichier National des Établissements Sanitaires et Sociaux.
 * Official directory of every French healthcare establishment (hôpital,
 * clinique, centre médical, EHPAD, cabinet médical, laboratoire,
 * pharmacie d'officine, …). Maintained by DREES, published monthly on
 * data.gouv.fr as a semicolon-delimited CSV with NO header row — the
 * file is column-positional and the first line is metadata ("finess;
 * etalab;<count>;<date>"). Each subsequent line starts with a record
 * type marker ("structureet" for établissements, "geolocalisation" for
 * coords). ~150k établissements per release.
 *
 *   Dataset: https://www.data.gouv.fr/datasets/finess-extraction-du-fichier-des-etablissements
 *   Resource we use: `etalab-cs1100502-stock-<date>.csv` (Etablissements,
 *   not the géolocalisation file).
 *   License: Lov2 (commercial reuse OK).
 *
 * Positional schema (verified 2026-05 release, 32 cells):
 *   [0]  rec_type ("structureet")
 *   [1]  nofinesset
 *   [2]  nofinessej
 *   [3]  rs (short name)
 *   [4]  rslongue
 *   [5]-[6] complement
 *   [7]  numvoie
 *   [8]  typvoie
 *   [9]  voie
 *   [10] compvoie
 *   [11] lieudit_bp
 *   [12] commune insee
 *   [13] departement
 *   [14] libdep
 *   [15] ligneacheminement ("01440 VIRIAT" — CP + ville)
 *   [16] telephone
 *   [17] fax
 *   [18] categetab (numeric code)
 *   [19] libcategetab
 *   [20] categagretab
 *   [21] libcategagretab
 *   [22] siret
 *
 * Category mapping by `categetab` + libellé text:
 *   medicina     — Hôpitaux, cabinets médicaux, centres de santé
 *   dentista     — Cabinets dentaires / centres de soins dentaires
 *   fisioterapia — Cabinets de masseur-kinésithérapeute
 *
 * Off by default. `PROLIO_RUN_FINESS=true` to enable.
 * Cap with `PROLIO_FINESS_LIMIT` (default 5000).
 */

const DATASET_API =
  "https://www.data.gouv.fr/api/1/datasets/finess-extraction-du-fichier-des-etablissements/";
const DEFAULT_LIMIT = 5000;
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

function categoryFromLibelle(libelle: string): CategoryKey | undefined {
  const t = libelle.toLowerCase();
  if (t.includes("dentaire") || t.includes("dentiste")) return "dentista";
  if (t.includes("kinésithéra") || t.includes("kinesithera"))
    return "fisioterapia";
  if (
    t.includes("hôpital") ||
    t.includes("hopital") ||
    t.includes("clinique") ||
    t.includes("centre de santé") ||
    t.includes("centre medical") ||
    t.includes("cabinet médical") ||
    t.includes("cabinet medical") ||
    t.includes("médical") ||
    t.includes("medical") ||
    t.includes("polyclinique") ||
    t.includes("centre hospitalier")
  )
    return "medicina";
  return undefined;
}

async function findLatestEtablissementCsvUrl(): Promise<string | null> {
  try {
    const response = await fetch(DATASET_API, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const meta = (await response.json()) as DatasetMeta;
    // FINESS publishes two CSVs per release:
    //   etalab-cs1100502-stock-<date>.csv  ← Etablissements (this one)
    //   etalab-cs1100507-stock-<date>.csv  ← Etablissements géolocalisés
    // Both have name/address; cs1100502 is the canonical reference,
    // cs1100507 is the same with lat/lon appended. Prefer cs1100502.
    const resources = meta.resources ?? [];
    const target =
      resources.find((r) => /cs1100502/i.test(r.url ?? "")) ||
      resources.find((r) => /cs1100507/i.test(r.url ?? "")) ||
      resources.find((r) => /etablissements?/i.test(r.title ?? ""));
    return target?.url ?? null;
  } catch (error) {
    console.error(
      `[finess] metadata failed: ${(error as Error).message}`,
    );
    return null;
  }
}

// Parse "01440 VIRIAT" or "01606 TREVOUX CEDEX" → { cp, ville }.
function parseLigneAcheminement(s: string): { cp: string; ville: string } {
  const m = s.trim().match(/^(\d{5})\s+(.+?)(?:\s+CEDEX(?:\s+\d+)?)?$/i);
  if (!m) return { cp: "", ville: s.trim() };
  return { cp: m[1], ville: m[2].trim() };
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const overrideUrl = process.env.PROLIO_FINESS_CSV;
  const url = overrideUrl || (await findLatestEtablissementCsvUrl());
  if (!url) {
    console.error("[finess] no CSV URL available");
    return [];
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    console.error(`[finess] download failed: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[finess] ${response.status} on ${url}`);
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
    // Skip the file header line ("finess;etalab;…") and any geolocation
    // rows (the cs1100507 file interleaves "structureet" with
    // "geolocalisation" — only the former carries the address fields).
    if (cells[0] !== "structureet") continue;
    if (cells.length < 22) continue;

    const finess = (cells[1] ?? "").trim();
    if (!finess || seen.has(finess)) continue;

    const libcategetab = (cells[19] ?? "").trim();
    const libcategagretab = (cells[21] ?? "").trim();
    const category =
      categoryFromLibelle(libcategetab) ||
      categoryFromLibelle(libcategagretab);
    if (!category) continue;

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
        source: "finess" as ScrapeSource,
        sourceId: `finess:${finess}`,
        name,
        categoryKey: category,
        citySlug,
        phone: (cells[16] ?? "").trim() || undefined,
        address: address || undefined,
        licenseNumber: finess,
        metadata: {
          country: "FR",
          authority: "DREES — FINESS",
          verified_by_authority: true,
          finess,
          finess_juridique: cells[2] || undefined,
          siret: cells[22] || undefined,
          categetab: cells[18] || undefined,
          libcategetab,
          libcategagretab,
        },
      }),
    );
  }

  console.log(`[finess] parsed=${out.length}`);
  return out;
}

export const finessSource: ScraperSource = {
  name: "finess" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_FINESS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runFiness(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!finessSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_FINESS_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[finess] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
