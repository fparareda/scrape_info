import type { CategoryKey } from "../prolio-types.js";
import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { splitCsvLine, frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * SIRENE — Base SIRENE des entreprises et de leurs établissements
 * (SIREN/SIRET). Published monthly by INSEE on data.gouv.fr under
 * Lov2. ~30M établissements covering every registered business in
 * France, with NAF/APE code that maps cleanly to Prolio categories.
 *
 *   Dataset: https://www.data.gouv.fr/datasets/base-sirene-des-entreprises-et-de-leurs-etablissements-siren-siret
 *   Bulk files (CSV, gzipped):
 *     StockEtablissement_utf8.zip  (~2 GB unpacked, ~30M rows)
 *     StockUniteLegale_utf8.zip    (~1 GB unpacked, ~20M rows)
 *
 * NAF/APE → Prolio category mapping (sub-set; expand as needed):
 *   4322A  Travaux d'installation d'eau et de gaz                → fontaneria
 *   4322B  Travaux d'installation d'équipements thermiques/clim → hvac
 *   4321A  Travaux d'installation électrique                    → electricidad
 *   4520A  Entretien et réparation de véhicules automobiles    → mecanica
 *   7120A  Contrôle technique automobile                        → itv
 *   4332A  Travaux de menuiserie bois et PVC                    → carpinteria
 *   6920Z  Activités comptables                                 → fiscal
 *   7111Z  Activités d'architecture                             → arquitecto
 *   6910Z  Activités juridiques                                 → extranjeria
 *   7112B  Ingénierie, études techniques                        → ingenieria
 *   8690D  Activités des infirmiers et des sages-femmes         → medicina
 *   8623Z  Pratique dentaire                                    → dentista
 *   8690E  Activités des médecins généralistes/spéc.            → medicina
 *   8690F  Activités des auxiliaires médicaux                   → fisioterapia
 *   7500Z  Activités vétérinaires                               → veterinario
 *   6910Z (notaire — distinguished by libelle)                  → notario
 *
 * Implementation status: STUB. The full bulk download is ~2-3 GB of
 * ZIP and parsing CSV inside ZIP on a GH free runner requires a
 * dedicated streaming approach (ZIP + chunked CSV + early-break per
 * NAF). For first pass we ship:
 *
 *   1. Source enabled() / runSireneInsee() entry points
 *   2. A category-specific override URL `PROLIO_SIRENE_INSEE_CSV`
 *      pointing to a pre-filtered subset (e.g. a CSV produced offline)
 *   3. `PROLIO_SIRENE_CATEGORY` to process one category per run.
 *   4. NAF→category mapping table (verified above)
 *
 * Full streaming-ZIP implementation tracked in scripts/download-sirene.mjs
 * — that script can be run locally to generate per-category CSVs that
 * are then uploaded as private artifacts the runner can pull cheaply.
 *
 * Off by default. `PROLIO_RUN_SIRENE_INSEE=true` to enable.
 * Cap with `PROLIO_SIRENE_LIMIT_PER_CATEGORY` (default 5000).
 */

const DEFAULT_LIMIT_PER_CATEGORY = 5000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const NAF_TO_CATEGORY: Record<string, CategoryKey> = {
  "4322A": "fontaneria",
  "4322B": "hvac",
  "4321A": "electricidad",
  "4520A": "mecanica",
  "7120A": "itv",
  "4332A": "carpinteria",
  "6920Z": "fiscal",
  "7111Z": "arquitecto",
  "6910Z": "extranjeria",
  "7112B": "ingenieria",
  "8690D": "medicina",
  "8623Z": "dentista",
  "8690E": "medicina",
  "8690F": "fisioterapia",
  "7500Z": "veterinario",
};

function nafToCategory(naf: string): CategoryKey | undefined {
  if (!naf) return undefined;
  // Normalise (lower vs upper case Z, drop spaces).
  const key = naf.trim().toUpperCase().replace(/\s+/g, "");
  return NAF_TO_CATEGORY[key];
}

/**
 * Parse a pre-filtered SIRENE CSV (semicolon-separated) — produced
 * either by `scripts/download-sirene.mjs` or by INSEE's own API.
 * Expected columns: siret, denominationUniteLegale, enseigne1Etablissement,
 * numeroVoieEtablissement, typeVoieEtablissement, libelleVoieEtablissement,
 * codePostalEtablissement, libelleCommuneEtablissement,
 * activitePrincipaleEtablissement, etatAdministratifEtablissement.
 */
async function fetchFromCsv(
  url: string,
  limitPerCategory: number,
  filterCategory: CategoryKey | undefined,
): Promise<ScrapedProfessional[]> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok || !response.body) {
    console.error(`[sirene-insee] ${response.status} on ${url}`);
    return [];
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const reader = response.body.getReader();
  let buffer = "";
  let header: string[] | null = null;
  const counts = new Map<CategoryKey, number>();
  const seen = new Set<string>();
  const out: ScrapedProfessional[] = [];

  const handle = (line: string): void => {
    if (!line) return;
    const cells = splitCsvLine(line, line.includes(";") ? ";" : ",");
    if (!header) {
      header = cells.map((h) =>
        h
          .trim()
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, ""),
      );
      return;
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i += 1) {
      row[header[i]] = (cells[i] ?? "").trim();
    }

    const naf =
      row["activiteprincipaleetablissement"] ||
      row["activite_principale_etablissement"] ||
      row["activite_principale"] ||
      "";
    const category = nafToCategory(naf);
    if (!category) return;
    if (filterCategory && category !== filterCategory) return;
    if ((counts.get(category) ?? 0) >= limitPerCategory) return;

    const state =
      row["etatadministratifetablissement"] ||
      row["etat_administratif_etablissement"] ||
      "A";
    if (state !== "A") return; // skip closed établissements

    const siret = row["siret"];
    if (!siret || seen.has(siret)) return;
    seen.add(siret);

    const cp =
      row["codepostaletablissement"] ||
      row["code_postal_etablissement"] ||
      "";
    const citySlug = frPostalCodeToCitySlug(cp);
    if (!citySlug) return;

    const denom =
      row["denominationunitelegale"] ||
      row["denomination_unite_legale"] ||
      "";
    const enseigne =
      row["enseigne1etablissement"] ||
      row["enseigne_1_etablissement"] ||
      "";
    const name = (enseigne || denom || "").trim();
    if (!name) return;

    const street = [
      row["numerovoieetablissement"] || row["numero_voie_etablissement"],
      row["typevoieetablissement"] || row["type_voie_etablissement"],
      row["libellevoieetablissement"] || row["libelle_voie_etablissement"],
    ]
      .filter(Boolean)
      .join(" ");
    const city =
      row["libellecommuneetablissement"] ||
      row["libelle_commune_etablissement"] ||
      "";
    const address = [street, cp, city].filter(Boolean).join(", ");

    counts.set(category, (counts.get(category) ?? 0) + 1);

    out.push(
      normalise({
        source: "sirene-insee" as ScrapeSource,
        sourceId: `sirene:${siret}`,
        name,
        categoryKey: category,
        citySlug,
        address: address || undefined,
        licenseNumber: siret,
        metadata: {
          country: "FR",
          authority: "INSEE — Base SIRENE",
          verified_by_authority: true,
          siren: siret.slice(0, 9),
          siret,
          naf,
        },
      }),
    );
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const raw = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      handle(raw);
      nl = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) handle(buffer.replace(/\r$/, ""));
  try {
    await reader.cancel();
  } catch {
    // ignore
  }

  console.log(
    `[sirene-insee] parsed=${out.length} categories=${[...counts.entries()]
      .map(([k, v]) => `${k}:${v}`)
      .join(",")}`,
  );
  return out;
}

export const sireneInseeSource: ScraperSource = {
  name: "sirene-insee" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_SIRENE_INSEE === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runSireneInsee(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!sireneInseeSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const csvUrl = process.env.PROLIO_SIRENE_INSEE_CSV;
  if (!csvUrl) {
    console.log(
      "[sirene-insee] PROLIO_SIRENE_INSEE_CSV not set — see scripts/download-sirene.mjs " +
        "to pre-filter the 2 GB StockEtablissement_utf8.zip into per-category CSVs. " +
        "TODO: implement bulk Parquet/CSV streaming directly in this scraper.",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const rawLimit = Number(
    process.env.PROLIO_SIRENE_LIMIT_PER_CATEGORY ?? DEFAULT_LIMIT_PER_CATEGORY,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? rawLimit
      : DEFAULT_LIMIT_PER_CATEGORY;
  const filterCategory = (process.env.PROLIO_SIRENE_CATEGORY ||
    undefined) as CategoryKey | undefined;

  const records = await fetchFromCsv(csvUrl, limit, filterCategory);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[sirene-insee] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
