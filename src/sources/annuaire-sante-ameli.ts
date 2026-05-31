import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * Annuaire Santé Ameli — official French national directory of every
 * libéral healthcare professional published by Sécurité Sociale (CNAM).
 * Bulk CSV via data.gouv.fr, license Lov2 (commercial reuse OK).
 *
 * Discovered 2026-05-07 via Chrome MCP search of data.gouv.fr.
 *
 * Single dataset unlocks 3 Prolio FR categories at once:
 *   - medicina      (type_ps_libelle "Médecins généralistes et spécialistes")
 *   - dentista      ("Chirurgiens-dentistes")
 *   - fisioterapia  ("Masseurs-kinésithérapeutes")
 *
 * Other libéral types in the file we don't map (no Prolio category):
 * pharmaciens, sages-femmes, infirmiers, pédicures-podologues,
 * orthophonistes, orthoptistes, psychomotriciens.
 *
 * CSV layout (verified on 20260504 snapshot, ~150 MB, semicolon
 * separator):
 *   ps_activite_nom            last name
 *   ps_activite_prenom         first name
 *   ps_activite_civilite       M/Mme
 *   ps_activite_raison_sociale firm name (often blank for individuals)
 *   specialite_libelle         e.g. "Cardiologue", "Médecin généraliste"
 *   type_ps_libelle            top-level type (used for category routing)
 *   coordonnees_num_tel        phone
 *   coordonnees_voie           street
 *   coordonnees_code_postal    CP
 *   coordonnees_ville          city
 *   secteur_conventionnel_libelle
 *   nature_exercice_libelle
 *
 * Resolution model:
 *   1. GET dataset metadata → find latest CSV resource URL.
 *   2. Stream-fetch (timeout 5 min, ~150 MB at typical GH runner speed).
 *   3. Parse → filter to mapped categories → upsert.
 *
 * Off by default. `PROLIO_RUN_ANNUAIRE_SANTE_AMELI=true` to enable.
 * Cap with `PROLIO_ANNUAIRE_SANTE_AMELI_LIMIT` (default 5000 to keep
 * first run small; bump for production once URL is verified).
 */

const DATASET_API =
  "https://www.data.gouv.fr/api/1/datasets/annuaire-sante-ameli/";
// Bumped 5_000 → 500_000 on 2026-05-16. The conservative 5k was a
// pre-launch safety cap; with the 6 new categories above (enfermeria
// ~360k, farmacia ~76k, allied health ~50k) we need to let the bulk
// pass run to completion. 500k is the FR target per the 500k-per-
// country plan; override via PROLIO_ANNUAIRE_SANTE_AMELI_LIMIT.
const DEFAULT_LIMIT = 500_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

interface DatasetResource {
  title?: string;
  format?: string;
  url?: string;
  filesize?: number;
}
interface DatasetMeta {
  resources?: DatasetResource[];
}

function typeToCategory(type: string, specialty: string): CategoryKey | undefined {
  const t = type.toLowerCase();
  const s = specialty.toLowerCase();
  if (t.includes("médecin") || s.includes("médecin")) return "medicina";
  if (s.includes("psychiatre")) return "medicina";
  if (t.includes("chirurgien") && t.includes("dentiste")) return "dentista";
  if (t.includes("dentiste") || s.includes("dentiste")) return "dentista";
  if (t.includes("kinésithéra") || t.includes("kinesithera")) return "fisioterapia";
  // Added 2026-05-16 — ANS dataset ships ~360k infirmiers, ~76k
  // pharmaciens, ~50k allied-health roles that the original 4-cat
  // filter was silently dropping. Now we accept them too.
  if (t.includes("infirmier") || s.includes("infirmier")) return "enfermeria";
  if (t.includes("sage-femme") || s.includes("sage-femme")) return "enfermeria";
  if (t.includes("pharmacien") || s.includes("pharmacien")) return "farmacia";
  if (t.includes("psycholog") || s.includes("psycholog")) return "psicologia";
  if (t.includes("orthophoniste") || s.includes("orthophoniste")) return "fisioterapia";
  if (t.includes("ostéopathe") || s.includes("osteopathe") || s.includes("ostéopathe")) return "fisioterapia";
  return undefined;
}

async function findLatestPsCsvUrl(): Promise<string | null> {
  try {
    const response = await fetch(DATASET_API, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.error(`[annuaire-sante-ameli] metadata ${response.status}`);
      return null;
    }
    const meta = (await response.json()) as DatasetMeta;
    // The PS (Professionnels de Santé) file title contains "Liste des
    // professionnels de santé". Use that to disambiguate from the CDS
    // (Centres de Santé) file in the same dataset.
    const ps = (meta.resources ?? []).find(
      (r) =>
        r.format?.toLowerCase() === "csv" &&
        /professionnels de sant[ée]/i.test(r.title ?? ""),
    );
    return ps?.url ?? null;
  } catch (error) {
    console.error(
      `[annuaire-sante-ameli] metadata failed: ${(error as Error).message}`,
    );
    return null;
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const overrideUrl = process.env.PROLIO_ANNUAIRE_SANTE_AMELI_CSV;
  const url = overrideUrl || (await findLatestPsCsvUrl());
  if (!url) {
    console.error("[annuaire-sante-ameli] no CSV URL available");
    return [];
  }
  let response: Response;
  try {
    // 150 MB CSV → 5 min timeout for the download. Network jitter on
    // GH Actions runners has caused 60 s aborts on smaller files.
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    console.error(
      `[annuaire-sante-ameli] download failed: ${(error as Error).message}`,
    );
    return [];
  }
  if (!response.ok) {
    console.error(`[annuaire-sante-ameli] ${response.status} on ${url}`);
    return [];
  }
  const text = await response.text();
  const rows = parseCsv(text);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const type = row["type_ps_libelle"] ?? "";
    const specialty = row["specialite_libelle"] ?? "";
    const category = typeToCategory(type, specialty);
    if (!category) continue;

    const lastName = row["ps_activite_nom"];
    const firstName = row["ps_activite_prenom"];
    if (!lastName) continue;

    const city = row["coordonnees_ville"];
    // Bucket by postal-code department to one of the 30 seeded FR
    // metros (see _bulk-utils.frPostalCodeToCitySlug). Trying to
    // slugify the literal commune name (e.g. "BOURG EN BRESSE")
    // misses the cities FK because we only seed metros — would
    // upsert 0 rows otherwise. Rural CPs without a seeded metro
    // are dropped silently (sink filter).
    const cp = row["coordonnees_code_postal"] ?? "";
    const citySlug = frPostalCodeToCitySlug(cp);
    if (!citySlug) continue;

    // Construct a stable id from last name + first name + postal code.
    // The CSV doesn't expose RPPS numbers (privacy) so we synthesise
    // an id; sink dedup uses (source, source_id).
    const idKey = `${slugify(lastName)}-${slugify(firstName)}-${cp}-${category}`;
    if (seen.has(idKey)) continue;
    seen.add(idKey);

    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    const street = row["coordonnees_voie"] ?? "";
    const address = [street, cp, city].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "annuaire-sante-ameli",
        sourceId: `ameli:${idKey}`,
        name,
        categoryKey: category,
        country: "FR",
        citySlug,
        phone: row["coordonnees_num_tel"] || undefined,
        address: address || undefined,
        metadata: {
          country: "FR",
          authority: "CNAM (Annuaire santé Ameli)",
          verified_by_authority: true,
          civilite: row["ps_activite_civilite"],
          specialite: specialty || undefined,
          type_ps: type,
          firm: row["ps_activite_raison_sociale"] || undefined,
          secteur_conventionnel: row["secteur_conventionnel_libelle"] || undefined,
        },
      }),
    );
  }

  console.log(
    `[annuaire-sante-ameli] parsed=${out.length} (filtered to medicina/dentista/fisioterapia)`,
  );
  return out;
}

export const annuaireSanteAmeliSource: ScraperSource = {
  name: "annuaire-sante-ameli",
  enabled() {
    return process.env.PROLIO_RUN_ANNUAIRE_SANTE_AMELI === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runAnnuaireSanteAmeli(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!annuaireSanteAmeliSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_ANNUAIRE_SANTE_AMELI_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[annuaire-sante-ameli] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
