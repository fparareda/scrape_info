import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapeSource,
  ScrapedProfessional,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * Chambre des Métiers et de l'Artisanat (CMA) — artisans français.
 *
 * Verified 2026-05-18. The CMA network (`www.artisanat.fr/annuaire` and
 * the per-region CMA portals) does NOT expose a structured public
 * search-by-trade endpoint — the artisanat.fr "recherche" is a
 * Drupal-based site search for articles + themes, with no nominative
 * artisan records. data.gouv.fr has no bulk dump of the Répertoire
 * National des Métiers (RNM) either.
 *
 * **HOWEVER** every artisan registered at a CMA is also recorded at
 * INSEE with the flag `est_artisan=1`, surfaced by the public
 * Recherche d'Entreprises API. That flag is precisely what makes this a
 * complementary source rather than a sirene-insee duplicate:
 *
 *   - `sirene-insee` queries by NAF + dept without the artisan flag, so
 *     it pulls in non-artisan SAS/SARL (large plumbing/electrical
 *     companies, franchises) alongside one-person artisans. It uses the
 *     standard "fontaneria/hvac/electricidad/carpinteria" NAF set.
 *   - `chambre-metiers-fr` adds `est_artisan=1` to every request and
 *     covers a *wider* artisan NAF basket (sole-trader trades not in
 *     sirene-insee: locksmiths, masons, painters, tilers, roofers,
 *     stoneworkers, glaziers, joiners-wood) → 200k+ potential rows.
 *   - Distinct namespace: `cma-fr:<SIREN>` (vs `sirene:<SIREN>`).
 *     Cross-match is handled downstream by the de-dup pass, so two
 *     sources lighting up the same SIREN reinforces verification
 *     instead of double-counting.
 *
 * API:
 *   GET https://recherche-entreprises.api.gouv.fr/search
 *     ?activite_principale=<NAF>&est_artisan=1
 *     &departement=<dept>&etat_administratif=A
 *     &per_page=25&page=<n>
 *
 *   Same hard caps as sirene-insee: per_page ≤ 25, page*per_page ≤ 10k.
 *   We fan out by department per NAF, then break early on the limit.
 *
 * Off by default. `PROLIO_RUN_CHAMBRE_METIERS_FR=true`. Cap with
 * `PROLIO_CHAMBRE_METIERS_FR_LIMIT` (default 50_000).
 * Optional category restrict: `PROLIO_CHAMBRE_METIERS_FR_CATEGORY`
 * picks a single Prolio category to fetch this run (rotate via cron).
 */

const API_BASE = "https://recherche-entreprises.api.gouv.fr/search";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 300;
const PER_PAGE = 25;
const MAX_PAGE = Math.floor(10_000 / PER_PAGE);
const DEFAULT_LIMIT = 50_000;

// NAFs to Prolio categories. Intentionally broader than sirene-insee:
// these are the small-trade NAFs where almost every entity is an
// artisan (carpenters, masons, painters, etc.). The big-company NAFs
// already covered by sirene-insee (43.21A/43.22A core) are kept here
// too so that the artisan-flagged subset gets the dedicated CMA tag —
// the namespace separation avoids row duplication.
const NAF_TO_CATEGORY: Record<string, CategoryKey> = {
  // Plomberie / sanitaire
  "43.22A": "fontaneria",
  // Climatisation / ventilation / froid (HVAC)
  "43.22B": "hvac",
  // Installations électriques
  "43.21A": "electricidad",
  // Travaux de menuiserie bois et PVC / métallique
  "43.32A": "carpinteria",
  "43.32B": "carpinteria",
  // Fabrication de charpentes et autres menuiseries bois
  "16.23Z": "carpinteria",
  // Travaux de menuiserie métallique et serrurerie
  "43.32C": "carpinteria",
  // Travaux de couverture (couvreur) — still trade-adjacent
  "43.91A": "carpinteria",
  "43.91B": "carpinteria",
};

const CATEGORY_TO_NAFS: Record<string, string[]> = {};
for (const [naf, cat] of Object.entries(NAF_TO_CATEGORY)) {
  (CATEGORY_TO_NAFS[cat] ||= []).push(naf);
}

const FR_DEPARTMENTS: string[] = (() => {
  const out: string[] = [];
  for (let i = 1; i <= 95; i += 1) {
    if (i === 20) continue;
    out.push(String(i).padStart(2, "0"));
  }
  out.push("2A", "2B", "971", "972", "973", "974", "976");
  return out;
})();

interface ApiSiege {
  activite_principale?: string;
  adresse?: string;
  code_postal?: string;
  commune?: string;
  coordonnees?: string;
  departement?: string;
  region?: string;
  libelle_commune?: string;
  etat_administratif?: string;
}
interface ApiResult {
  siren?: string;
  nom_complet?: string;
  nom_raison_sociale?: string;
  activite_principale?: string;
  nature_juridique?: string;
  date_creation?: string;
  etat_administratif?: string;
  nombre_etablissements?: number;
  nombre_etablissements_ouverts?: number;
  est_artisan?: boolean;
  siege?: ApiSiege;
}
interface ApiResponse {
  total_results?: number;
  total_pages?: number;
  results?: ApiResult[];
}

async function fetchPage(
  naf: string,
  dept: string,
  page: number,
): Promise<ApiResponse | null> {
  const url =
    `${API_BASE}?activite_principale=${encodeURIComponent(naf)}` +
    `&est_artisan=1&departement=${encodeURIComponent(dept)}` +
    `&etat_administratif=A&per_page=${PER_PAGE}&page=${page}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[chambre-metiers-fr] ${res.status} on ${naf}/${dept} page=${page}`,
      );
      return null;
    }
    return (await res.json()) as ApiResponse;
  } catch (err) {
    console.warn(
      `[chambre-metiers-fr] network on ${naf}/${dept} page=${page}: ${(err as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseCoords(
  raw: string | undefined,
): { lat: number; lng: number } | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => parseFloat(s.trim()));
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) return undefined;
  return { lat: parts[0], lng: parts[1] };
}

function toRecord(
  e: ApiResult,
  naf: string,
  category: CategoryKey,
): ScrapedProfessional | null {
  const siren = (e.siren ?? "").trim();
  const name = (e.nom_complet || e.nom_raison_sociale || "").trim();
  if (!siren || !name) return null;
  const siege = e.siege ?? {};
  const cp = siege.code_postal;
  const citySlug = frPostalCodeToCitySlug(cp ?? "") ?? "paris";
  const coords = parseCoords(siege.coordonnees);
  return normalise({
    source: "chambre-metiers-fr" as ScrapeSource,
    sourceId: `cma-fr:${siren}`,
    name,
    categoryKey: category,
    citySlug,
    licenseNumber: siren,
    lat: coords?.lat,
    lng: coords?.lng,
    address: siege.adresse,
    metadata: {
      country: "FR",
      authority: "Chambre des Métiers et de l'Artisanat (via INSEE est_artisan)",
      verified_by_authority: true,
      est_artisan: true,
      siren,
      naf_code: naf,
      naf_label: siege.activite_principale || e.activite_principale,
      raw_postal_code: cp,
      raw_commune: siege.libelle_commune || siege.commune,
      raw_departement: siege.departement,
      raw_region: siege.region,
      nombre_etablissements: e.nombre_etablissements,
      nombre_etablissements_ouverts: e.nombre_etablissements_ouverts,
      date_creation: e.date_creation,
      nature_juridique: e.nature_juridique,
      etat_administratif: e.etat_administratif,
    },
  });
}

async function fetchCategory(
  category: CategoryKey,
  limit: number,
): Promise<ScrapedProfessional[]> {
  const nafs = CATEGORY_TO_NAFS[category];
  if (!nafs || nafs.length === 0) {
    console.warn(`[chambre-metiers-fr] no NAF mapped for category=${category}`);
    return [];
  }
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (const naf of nafs) {
    if (out.length >= limit) break;
    for (const dept of FR_DEPARTMENTS) {
      if (out.length >= limit) break;
      let page = 1;
      let total: number | undefined;
      while (out.length < limit && page <= MAX_PAGE) {
        const data = await fetchPage(naf, dept, page);
        if (!data || !data.results || data.results.length === 0) break;
        if (total === undefined && typeof data.total_results === "number") {
          total = data.total_results;
          if (total > 0) {
            console.log(
              `[chambre-metiers-fr] ${naf}/${dept}: total=${total}`,
            );
          }
        }
        for (const e of data.results) {
          const r = toRecord(e, naf, category);
          if (!r) continue;
          if (seen.has(r.sourceId)) continue;
          seen.add(r.sourceId);
          out.push(r);
          if (out.length >= limit) break;
        }
        if (data.results.length < PER_PAGE) break;
        if (total !== undefined && page * PER_PAGE >= total) break;
        page += 1;
        await sleep(REQUEST_DELAY_MS);
      }
    }
  }
  return out;
}

export const chambreMetiersFrSource: ScraperSource = {
  name: "chambre-metiers-fr" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CHAMBRE_METIERS_FR === "true";
  },
  async fetch() {
    return [];
  },
};

const TARGET_CATEGORIES: CategoryKey[] = [
  "fontaneria",
  "hvac",
  "electricidad",
  "carpinteria",
];

export async function runChambreMetiersFr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!chambreMetiersFrSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_CHAMBRE_METIERS_FR_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const onlyCategory = (
    process.env.PROLIO_CHAMBRE_METIERS_FR_CATEGORY ?? ""
  ).trim() as CategoryKey | "";
  const categories = onlyCategory
    ? TARGET_CATEGORIES.filter((c) => c === onlyCategory)
    : TARGET_CATEGORIES;
  if (categories.length === 0) {
    console.warn(
      `[chambre-metiers-fr] requested category="${onlyCategory}" not in target list — bailing`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const allRecords: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (const cat of categories) {
    if (allRecords.length >= limit) break;
    const remaining = limit - allRecords.length;
    const rows = await fetchCategory(cat, remaining);
    for (const r of rows) {
      if (seen.has(r.sourceId)) continue;
      seen.add(r.sourceId);
      allRecords.push(r);
      if (allRecords.length >= limit) break;
    }
    console.log(
      `[chambre-metiers-fr] category=${cat} contributed=${rows.length} cumulative=${allRecords.length}`,
    );
  }

  if (allRecords.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(allRecords);
  console.log(
    `[chambre-metiers-fr] done — fetched=${allRecords.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return {
    fetched: allRecords.length,
    inserted,
    updated,
    skipped,
  };
}
