import type { CategoryKey } from "../prolio-types.js";
import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { splitCsvLine, frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * Annuaire Santé (ANS) — consolidated French national healthcare
 * professional registry. SUPERSEDES the older `rpps-fr` and
 * `annuaire-sante-ameli` scrapers, which targeted the same
 * underlying ANS extraction publique with two different lenses:
 *
 *   - rpps-fr targeted the personne-activite pipe-delimited extract
 *     (one row per pro × workplace).
 *   - annuaire-sante-ameli targeted the CNAM Ameli libéral CSV.
 *
 * The ANS publication on data.gouv.fr ("Annuaire santé — extractions
 * des données en libre accès") is the canonical multi-table feed
 * covering ~1.8M PS (medical, dental, paramedical) across libéral +
 * salarié + hospital settings. We pull the single personne-activite
 * extraction as our minimum-viable record because it carries the
 * names + addresses + profession code needed for upsert; the
 * companion `dipl-autexerc` (diplomas) and `savoirfaire` (specialties)
 * tables are joinable by RPPS id but not required.
 *
 * Sources:
 *   Dataset: https://www.data.gouv.fr/datasets/annuaire-sante-extractions-des-donnees-en-libre-acces-des-professionnels-intervenant-dans-le-systeme-de-sante-rpps
 *   ANS portal: https://annuaire.sante.fr/web/site-pro/extractions-publiques
 *   License: Lov2 (Licence Ouverte 2.0 — commercial reuse OK)
 *
 * Category mapping (covers ~80% of file by row count):
 *   medicina      ← Médecin
 *   dentista      ← Chirurgien-Dentiste
 *   fisioterapia  ← Masseur-Kinésithérapeute
 *   psicologia    ← Psychologue / Psychomotricien
 *
 * Off by default. `PROLIO_RUN_ANNUAIRE_SANTE_ANS=true` to enable.
 * Cap with `PROLIO_ANNUAIRE_SANTE_ANS_LIMIT` (default 5000).
 *
 * Reuses the same streaming + pipe-delimited parser as rpps-fr (the
 * file is ~800 MB on a free GH runner so loading via response.text()
 * is OOM-risky).
 */

const DATASET_API =
  "https://www.data.gouv.fr/api/1/datasets/annuaire-sante-extractions-des-donnees-en-libre-acces-des-professionnels-intervenant-dans-le-systeme-de-sante-rpps/";
const DEFAULT_LIMIT = 5000;
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

function professionToCategory(profession: string): CategoryKey | undefined {
  const p = profession.toLowerCase();
  if (p.includes("médecin") || p.includes("medecin")) return "medicina";
  if (p.includes("chirurgien") && p.includes("dentiste")) return "dentista";
  if (p.includes("dentiste")) return "dentista";
  if (p.includes("kinésithéra") || p.includes("kinesithera"))
    return "fisioterapia";
  if (p.includes("psycholog") || p.includes("psychomot"))
    return "psicologia";
  return undefined;
}

async function findLatestPersonneActiviteUrl(): Promise<string | null> {
  try {
    const response = await fetch(DATASET_API, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.error(`[annuaire-sante-ans] metadata ${response.status}`);
      return null;
    }
    const meta = (await response.json()) as DatasetMeta;
    const target = (meta.resources ?? []).find((r) =>
      /personne[-_ ]?activite/i.test(r.title ?? r.url ?? ""),
    );
    return target?.url ?? null;
  } catch (error) {
    console.error(
      `[annuaire-sante-ans] metadata failed: ${(error as Error).message}`,
    );
    return null;
  }
}

async function* streamRows(
  url: string,
): AsyncGenerator<Record<string, string>, void, unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok) {
    console.error(`[annuaire-sante-ans] ${response.status} on ${url}`);
    return;
  }
  if (!response.body) {
    console.error("[annuaire-sante-ans] response.body is null");
    return;
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const reader = response.body.getReader();
  let buffer = "";
  let header: string[] | null = null;

  const handleLine = (line: string): Record<string, string> | null => {
    if (!line) return null;
    const cells = splitCsvLine(line, "|");
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
      return null;
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i += 1) {
      row[header[i]] = (cells[i] ?? "").trim();
    }
    return row;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const raw = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      const row = handleLine(raw);
      if (row) yield row;
      nl = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const row = handleLine(buffer.replace(/\r$/, ""));
    if (row) yield row;
  }
  try {
    await reader.cancel();
  } catch {
    // ignore
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const overrideUrl = process.env.PROLIO_ANNUAIRE_SANTE_ANS_CSV;
  const url = overrideUrl || (await findLatestPersonneActiviteUrl());
  if (!url) {
    console.error("[annuaire-sante-ans] no CSV URL available");
    return [];
  }

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  try {
    for await (const row of streamRows(url)) {
      scanned += 1;
      if (out.length >= limit) break;

      const profession = row["libelle_profession"] ?? "";
      const category = professionToCategory(profession);
      if (!category) continue;

      const lastName = row["nom_d_exercice"];
      const firstName = row["prenom_d_exercice"];
      if (!lastName) continue;

      const cp = row["code_postal_coord_structure"] ?? "";
      const citySlug = frPostalCodeToCitySlug(cp);
      if (!citySlug) continue;

      const ppId =
        row["identification_nationale_pp"] || row["identifiant_pp"];
      const idKey = ppId
        ? `${ppId}-${cp}`
        : `${slugify(lastName)}-${slugify(firstName)}-${cp}-${category}`;
      if (seen.has(idKey)) continue;
      seen.add(idKey);

      const civility =
        row["libelle_civilite_d_exercice"] || row["libelle_civilite"] || "";
      const name = [firstName, lastName].filter(Boolean).join(" ").trim();
      const street = row["libelle_voie_coord_structure"] ?? "";
      const city = row["libelle_commune_coord_structure"] ?? "";
      const address = [street, cp, city].filter(Boolean).join(", ");
      const specialty = row["libelle_savoir_faire"] || undefined;
      const firm = row["raison_sociale_site"] || undefined;

      out.push(
        normalise({
          source: "annuaire-sante-ans" as ScrapeSource,
          sourceId: `ans:${idKey}`,
          name,
          categoryKey: category,
          citySlug,
          phone: row["telephone_coord_structure"] || undefined,
          email: row["adresse_e_mail_coord_structure"] || undefined,
          address: address || undefined,
          metadata: {
            country: "FR",
            authority:
              "ANS (Agence du Numérique en Santé) — Annuaire Santé / RPPS",
            verified_by_authority: true,
            rpps_id: ppId || undefined,
            civilite: civility || undefined,
            profession,
            specialite: specialty,
            firm,
          },
        }),
      );
    }
  } catch (error) {
    console.error(
      `[annuaire-sante-ans] stream failed after ${scanned} rows: ${(error as Error).message}`,
    );
  }

  console.log(
    `[annuaire-sante-ans] scanned=${scanned} parsed=${out.length} (medicina/dentista/fisioterapia/psicologia)`,
  );
  return out;
}

export const annuaireSanteAnsSource: ScraperSource = {
  name: "annuaire-sante-ans" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_ANNUAIRE_SANTE_ANS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runAnnuaireSanteAns(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!annuaireSanteAnsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_ANNUAIRE_SANTE_ANS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[annuaire-sante-ans] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
