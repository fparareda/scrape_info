import type { CategoryKey } from "../prolio-types.js";
import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * ADEME RGE — Liste des entreprises Reconnu Garant de l'Environnement.
 * Published by the Agence de l'environnement et de la maîtrise de
 * l'énergie. ~165k qualifications across plomberie / électricité / HVAC
 * / menuiserie / isolation. Each row is a qualification (one entreprise
 * may hold several). Already labelled by discipline so the category
 * mapping is straightforward.
 *
 *   Dataset (data.ademe.fr / data-fair):
 *     https://data.ademe.fr/datasets/liste-des-entreprises-rge-2
 *   API:
 *     https://data.ademe.fr/data-fair/api/v1/datasets/liste-des-entreprises-rge-2/lines
 *     — cursor pagination via the `next` URL returned in each page.
 *   License: Lov2 (commercial reuse OK)
 *
 * Note: the parent dataset is virtual; the `/raw` download endpoint
 * returns 404. The `lines` JSON API is the supported access path.
 *
 * Discipline → Prolio category (matches the libellé in `domaine` /
 * `nom_qualification`):
 *   Plomberie / chauffage eau                   → fontaneria
 *   Électricité                                 → electricidad
 *   Chauffage / Climatisation / Pompe à chaleur → hvac
 *   Menuiserie / Fenêtres / Isolation murs ext. → carpinteria
 *   Architecte                                  → arquitecto
 *
 * Off by default. `PROLIO_RUN_ADEME_RGE=true` to enable.
 * Cap with `PROLIO_ADEME_RGE_LIMIT` (default 5000).
 */

const API_BASE =
  "https://data.ademe.fr/data-fair/api/v1/datasets/liste-des-entreprises-rge-2/lines";
const SELECT =
  "siret,nom_entreprise,adresse,code_postal,commune,domaine,nom_qualification,nom_certificat,organisme,telephone,email,site_internet,lien_date_debut,lien_date_fin";
const PAGE_SIZE = 1000;
const DEFAULT_LIMIT = 5000;
const USER_AGENT =
  "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";

interface RgeLine {
  siret?: string;
  nom_entreprise?: string;
  adresse?: string;
  code_postal?: string;
  commune?: string;
  domaine?: string;
  nom_qualification?: string;
  nom_certificat?: string;
  organisme?: string;
  telephone?: string;
  email?: string;
  site_internet?: string;
  lien_date_debut?: string;
  lien_date_fin?: string;
}
interface LinesPage {
  total?: number;
  next?: string;
  results?: RgeLine[];
}

function disciplineToCategory(text: string): CategoryKey | undefined {
  const t = text.toLowerCase();
  if (t.includes("architecte")) return "arquitecto";
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
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let url: string | null = `${API_BASE}?size=${PAGE_SIZE}&select=${SELECT}`;
  let pages = 0;

  while (url && out.length < limit) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      console.error(`[ademe-rge] fetch failed: ${(error as Error).message}`);
      break;
    }
    if (!response.ok) {
      console.error(`[ademe-rge] ${response.status} on ${url}`);
      break;
    }
    const page = (await response.json()) as LinesPage;
    const rows = page.results ?? [];
    pages += 1;
    if (rows.length === 0) break;

    for (const row of rows) {
      if (out.length >= limit) break;

      const siret = (row.siret ?? "").trim();
      if (!siret) continue;

      const discipline =
        row.nom_qualification ||
        row.domaine ||
        row.nom_certificat ||
        "";
      const category = disciplineToCategory(discipline);
      if (!category) continue;

      const cp = (row.code_postal ?? "").trim();
      const citySlug = frPostalCodeToCitySlug(cp);
      if (!citySlug) continue;

      // Dedup at (siret, category) level so the same entreprise across
      // multiple qualifications in the same category produces one row.
      const idKey = `${siret}-${category}`;
      if (seen.has(idKey)) continue;
      seen.add(idKey);

      const name = (row.nom_entreprise ?? "").trim();
      if (!name) continue;

      const address = [row.adresse, cp, row.commune]
        .map((s) => (s ?? "").trim())
        .filter(Boolean)
        .join(", ");

      out.push(
        normalise({
          source: "ademe-rge" as ScrapeSource,
          country: "FR",
          sourceId: `ademe-rge:${idKey}`,
          name,
          categoryKey: category,
          citySlug,
          phone: row.telephone || undefined,
          email: row.email || undefined,
          website: row.site_internet || undefined,
          address: address || undefined,
          licenseNumber: siret,
          metadata: {
            country: "FR",
            authority: "ADEME — Reconnu Garant de l'Environnement (RGE)",
            verified_by_authority: true,
            siret,
            discipline,
            domaine: row.domaine,
            certificat: row.nom_certificat,
            organisme: row.organisme,
            date_debut: row.lien_date_debut,
            date_fin: row.lien_date_fin,
          },
        }),
      );
    }

    url = page.next ?? null;
  }

  console.log(`[ademe-rge] parsed=${out.length} pages=${pages}`);
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
