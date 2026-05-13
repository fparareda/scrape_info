import type { CategoryKey } from "../prolio-types.js";
import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * ADEME RGE — Liste des entreprises Reconnu Garant de l'Environnement.
 * Published by the Agence de l'environnement et de la maîtrise de
 * l'énergie. ~85k qualifications across plomberie / électricité / HVAC
 * / menuiserie / isolation. Each row is a qualification (one entreprise
 * may hold several). Already labelled by discipline so the category
 * mapping is straightforward.
 *
 *   Dataset (data.ademe.fr):
 *     https://data.ademe.fr/datasets/liste-des-entreprises-rge-2
 *   API alternative (data.gouv.fr):
 *     https://www.data.gouv.fr/dataservices/api-professionnels-rge
 *   License: Lov2 (commercial reuse OK)
 *
 * Discipline → Prolio category (matches the libellé in `domaine` /
 * `nom_qualif`):
 *   Plomberie / chauffage eau                   → fontaneria
 *   Électricité                                 → electricidad
 *   Chauffage / Climatisation / Pompe à chaleur → hvac
 *   Menuiserie / Fenêtres / Isolation murs ext. → carpinteria
 *
 * Off by default. `PROLIO_RUN_ADEME_RGE=true` to enable.
 * Cap with `PROLIO_ADEME_RGE_LIMIT` (default 5000).
 */

const DATASET_URL =
  "https://data.ademe.fr/data-fair/api/v1/datasets/liste-des-entreprises-rge-2/raw";
const DEFAULT_LIMIT = 5000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

function disciplineToCategory(text: string): CategoryKey | undefined {
  const t = text.toLowerCase();
  if (
    t.includes("plomberie") ||
    t.includes("eau chaude") ||
    t.includes("eau sanitaire")
  )
    return "fontaneria";
  if (t.includes("électricité") || t.includes("electricite") || t.includes("photovolt"))
    return "electricidad";
  if (
    t.includes("chauffage") ||
    t.includes("climatisation") ||
    t.includes("pompe à chaleur") ||
    t.includes("pompe a chaleur") ||
    t.includes("ventilation") ||
    t.includes("vmc")
  )
    return "hvac";
  if (
    t.includes("menuiserie") ||
    t.includes("fenêtre") ||
    t.includes("fenetre") ||
    t.includes("isolation") ||
    t.includes("bois")
  )
    return "carpinteria";
  return undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const overrideUrl = process.env.PROLIO_ADEME_RGE_CSV;
  const url = overrideUrl || DATASET_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    console.error(`[ademe-rge] download failed: ${(error as Error).message}`);
    return [];
  }
  if (!response.ok) {
    console.error(`[ademe-rge] ${response.status} on ${url}`);
    return [];
  }
  const text = await response.text();
  const rows = parseCsv(text);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;

    const siret = row["siret"];
    if (!siret) continue;

    const discipline =
      row["nom_qualif"] ||
      row["nom_certificat"] ||
      row["domaine"] ||
      row["sous_domaine"] ||
      "";
    const category = disciplineToCategory(discipline);
    if (!category) continue;

    const cp = row["code_postal"] || row["adresse_cp"] || "";
    const citySlug = frPostalCodeToCitySlug(cp);
    if (!citySlug) continue;

    // Dedup at (siret, category) level so the same entreprise across
    // multiple qualifications in the same category produces one row.
    const idKey = `${siret}-${category}`;
    if (seen.has(idKey)) continue;
    seen.add(idKey);

    const name =
      row["nom_entreprise"] ||
      row["nom_qualif_titulaire"] ||
      row["raison_sociale"] ||
      "";
    if (!name) continue;

    const street = row["adresse"] || row["adresse_1"] || "";
    const city = row["commune"] || row["ville"] || "";
    const address = [street, cp, city].filter(Boolean).join(", ");

    out.push(
      normalise({
        source: "ademe-rge" as ScrapeSource,
        sourceId: `ademe-rge:${idKey}`,
        name,
        categoryKey: category,
        citySlug,
        phone: row["telephone"] || undefined,
        email: row["email"] || undefined,
        website: row["site_internet"] || undefined,
        address: address || undefined,
        licenseNumber: siret,
        metadata: {
          country: "FR",
          authority: "ADEME — Reconnu Garant de l'Environnement (RGE)",
          verified_by_authority: true,
          siret,
          discipline,
          domaine: row["domaine"],
          certificat: row["nom_certificat"],
          organisme: row["organisme"],
          date_debut: row["date_debut"],
          date_fin: row["date_fin"],
        },
      }),
    );
  }

  console.log(`[ademe-rge] parsed=${out.length}`);
  return out;
}

export const ademeRgeSource: ScraperSource = {
  name: "ademe-rge" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_ADEME_RGE === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runAdemeRge(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!ademeRgeSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_ADEME_RGE_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[ademe-rge] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
