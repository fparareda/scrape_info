import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { splitCsvLine, frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * RPPS — Répertoire Partagé des Professionnels de Santé.
 *
 * Canonical national French registry of every healthcare professional
 * (medical, dental, paramedical) maintained by ASIP Santé / Agence du
 * Numérique en Santé. Published as a daily extraction on data.gouv.fr
 * under Lov2 license (commercial reuse OK).
 *
 *   Dataset: https://www.data.gouv.fr/fr/datasets/repertoire-partage-des-professionnels-de-sante-rpps/
 *   API:     https://www.data.gouv.fr/api/1/datasets/annuaire-sante-extractions-des-donnees-en-libre-acces-des-professionnels-intervenant-dans-le-systeme-de-sante-rpps/
 *
 * Relation to `annuaire-sante-ameli`: Ameli is the CNAM extract limited
 * to *libéral* (private-practice) professionals with a Sécurité Sociale
 * agreement — i.e. those that bill the public insurance system. RPPS is
 * the underlying national registry covering libéral + salarié + hospital
 * + every regulated healthcare role (incl. those who never see a CNAM
 * patient). Treat as a complementary higher-quality superset; the sink
 * dedups via (source, source_id) so both can run side-by-side.
 *
 * Bulk file: `ps-libreacces-personne-activite.txt` — pipe-delimited
 * (`|`), Windows-1252, ~800 MB / ~2 M activity rows (one per
 * professional × workplace; the same RPPS id can appear several times
 * if a doctor practices in multiple sites). Verified column layout
 * 2026-05-07 from snapshot 20260505-082255:
 *
 *    1  Type d'identifiant PP                (8 = ADELI legacy, ...)
 *    2  Identifiant PP                       (the "RPPS" or ADELI number)
 *    3  Identification nationale PP          (national PP identifier)
 *    8  Nom d'exercice
 *    9  Prénom d'exercice
 *   10  Code profession
 *   11  Libellé profession                   (used for category routing)
 *   17  Libellé savoir-faire                 (specialty)
 *   25  Raison sociale site                  (firm name)
 *   33  Libellé Voie                         (street name only)
 *   36  Code postal (coord. structure)
 *   38  Libellé commune (coord. structure)
 *   41  Téléphone (coord. structure)
 *   44  Adresse e-mail (coord. structure)
 *
 * Profession values seen in real data: "Médecin", "Chirurgien-Dentiste",
 * "Sage-Femme", "Infirmier", "Pharmacien", "Masseur-Kinésithérapeute",
 * "Pédicure-Podologue", "Orthophoniste", "Orthoptiste", "Psychomotricien".
 * We map only the three with a Prolio category today:
 *
 *   - medicina      ← "Médecin"
 *   - dentista      ← "Chirurgien-Dentiste"
 *   - fisioterapia  ← "Masseur-Kinésithérapeute"
 *
 * Implementation notes:
 *   • The file is too large (~800 MB) to load with `await
 *     response.text()` on a free GH runner without OOM risk. We stream
 *     `response.body`, decode chunks, and break out of the loop once
 *     `out.length` reaches `limit` — short-circuiting the download.
 *   • parseCsv()'s separator auto-detect doesn't recognise pipe; we
 *     parse line-by-line with `splitCsvLine(line, "|")`.
 *   • Same FR postal-code → city-slug bucketing as Annuaire Santé Ameli;
 *     rural CPs without a seeded metro are dropped silently (see
 *     `frPostalCodeToCitySlug` in _bulk-utils).
 *
 * Off by default. `PROLIO_RUN_RPPS_FR=true` to enable. Cap with
 * `PROLIO_RPPS_FR_LIMIT` (default 5000 — same first-run discipline as
 * sibling FR sources; bumped to 100k in the GH Actions runner once the
 * URL is verified).
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
  // Primary healthcare
  if (p.includes("médecin") || p.includes("medecin")) return "medicina";
  if ((p.includes("chirurgien") && p.includes("dentiste")) || p.includes("dentiste"))
    return "dentista";
  if (p.includes("kinésithéra") || p.includes("kinesithera") || p.includes("masseur"))
    return "fisioterapia";
  if (p.includes("sage-femme") || p.includes("sage femme") || p.includes("maïeuticien"))
    return "medicina"; // closest category — midwives are healthcare practitioners
  if (p.includes("infirmier") || p.includes("infirmière"))
    return "enfermeria";
  if (p.includes("pharmacien") || p.includes("pharmacie"))
    return "farmacia";
  if (p.includes("vétérinaire") || p.includes("veterinaire"))
    return "veterinario";
  if (p.includes("psychologue") || p.includes("psychothéra"))
    return "psicologia";
  if (p.includes("pédicure") || p.includes("podologue"))
    return "fisioterapia"; // podiatrists → physio as closest
  if (p.includes("orthophoniste") || p.includes("orthoptiste"))
    return "fisioterapia"; // speech/vision therapists → physio as closest
  if (p.includes("ergothéra") || p.includes("psychomotricien"))
    return "fisioterapia";
  return undefined;
}

async function findLatestPersonneActiviteUrl(): Promise<string | null> {
  try {
    const response = await fetch(DATASET_API, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.error(`[rpps-fr] metadata ${response.status}`);
      return null;
    }
    const meta = (await response.json()) as DatasetMeta;
    // Three files in the dataset; we want the personne-activite extract
    // (one row per pro × workplace, with names + addresses). The other
    // two are dipl-autexerc (diplomas) and savoirfaire (specialties),
    // which are joinable but not needed for our minimum viable record.
    const target = (meta.resources ?? []).find((r) =>
      /personne[-_ ]?activite/i.test(r.title ?? r.url ?? ""),
    );
    return target?.url ?? null;
  } catch (error) {
    console.error(
      `[rpps-fr] metadata failed: ${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * Stream-parse the pipe-delimited RPPS file. Yields one record at a
 * time so the caller can stop early once `limit` is hit without
 * downloading the remaining ~700 MB.
 */
async function* streamRows(
  url: string,
): AsyncGenerator<Record<string, string>, void, unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    // 800 MB at typical GH Actions throughput (~10 MB/s) takes ~80 s,
    // but the per-source workflow is given 240 min. Cap fetch at 30
    // min as a safety net against stalled connections.
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok) {
    console.error(`[rpps-fr] ${response.status} on ${url}`);
    return;
  }
  if (!response.body) {
    console.error("[rpps-fr] response.body is null");
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

  // eslint-disable-next-line no-constant-condition
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
  // Flush trailing line (file may not end with \n).
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const row = handleLine(buffer.replace(/\r$/, ""));
    if (row) yield row;
  }
  // Best-effort cancel of any remaining bytes if we already broke out.
  try {
    await reader.cancel();
  } catch {
    // ignore — connection may already be closed
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const overrideUrl = process.env.PROLIO_RPPS_FR_CSV;
  const url = overrideUrl || (await findLatestPersonneActiviteUrl());
  if (!url) {
    console.error("[rpps-fr] no CSV URL available");
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

      // Stable id: use the national PP id (RPPS / ADELI number) +
      // postal code so multi-site practitioners produce one record per
      // site. The national id alone collapses sites; sink dedup is
      // (source, source_id), and we want each workplace addressable.
      const ppId =
        row["identification_nationale_pp"] || row["identifiant_pp"];
      const idKey = ppId
        ? `${ppId}-${cp}`
        : `${slugify(lastName)}-${slugify(firstName)}-${cp}-${category}`;
      if (seen.has(idKey)) continue;
      seen.add(idKey);

      const civility = row["libelle_civilite_d_exercice"] || row["libelle_civilite"] || "";
      const name = [firstName, lastName].filter(Boolean).join(" ").trim();
      const street = row["libelle_voie_coord_structure"] ?? "";
      const city = row["libelle_commune_coord_structure"] ?? "";
      const address = [street, cp, city].filter(Boolean).join(", ");
      const specialty = row["libelle_savoir_faire"] || undefined;
      const firm = row["raison_sociale_site"] || undefined;

      out.push(
        normalise({
          source: "rpps-fr",
          sourceId: `rpps:${idKey}`,
          name,
          categoryKey: category,
          country: "FR",
          citySlug,
          phone: row["telephone_coord_structure"] || undefined,
          email: row["adresse_e_mail_coord_structure"] || undefined,
          address: address || undefined,
          metadata: {
            country: "FR",
            authority: "ANS / RPPS (Répertoire Partagé des Professionnels de Santé)",
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
      `[rpps-fr] stream failed after ${scanned} rows: ${(error as Error).message}`,
    );
  }

  console.log(
    `[rpps-fr] scanned=${scanned} parsed=${out.length} (filtered to medicina/dentista/fisioterapia/enfermeria/farmacia/veterinario/psicologia)`,
  );
  return out;
}

export const rppsFrSource: ScraperSource = {
  name: "rpps-fr",
  enabled() {
    return process.env.PROLIO_RUN_RPPS_FR === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runRppsFr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!rppsFrSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_RPPS_FR_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[rpps-fr] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
