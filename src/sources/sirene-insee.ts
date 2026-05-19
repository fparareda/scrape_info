import type { CategoryKey } from "../prolio-types.js";
import type { ScrapeSource, ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { frPostalCodeToCitySlug } from "./_bulk-utils.js";

/**
 * SIRENE / Recherche d'Entreprises — INSEE base maestra de empresas FR.
 *
 *   API REST (sin auth, sin rate-limit anunciado, licencia Etalab):
 *     https://recherche-entreprises.api.gouv.fr/search
 *     Docs: https://recherche-entreprises.api.gouv.fr/docs
 *
 * Reemplaza el approach previo de ZIP bulk (~2-3 GB) por la API REST
 * que envuelve Sirene + INPI con filtros directos por NAF/APE,
 * department, código postal, geo bbox, etc.
 *
 * Constraints verified live 2026-05-13:
 *   - `per_page` MAX = 25 (default 10).
 *   - `page * per_page` MAX = 10,000 — la API rechaza más allá.
 *     Por eso fan-out por department es obligatorio para NAFs > 10k.
 *   - `activite_principale` requiere FORMATO CON PUNTOS (e.g. "43.22A").
 *   - Filtros útiles: `departement`, `code_postal`, `siege=true`,
 *     `etat_administratif=A` (sólo empresas activas).
 *
 * Pre-flight totales (nacional, sin filtro geo):
 *   43.22A (plomberie)       ~75k  → fan-out por dept
 *   43.21A (electricidad)    ~90k  → fan-out por dept
 *   45.20A (mecanica)        ~50k  → fan-out por dept
 *   71.20A (controle tech)    ~7k  → fits 10k cap
 *   71.11Z (architectes)     ~40k  → fan-out
 *   69.20Z (comptabilité)    ~30k  → fan-out
 *
 * Modo de operación: UN run = UNA categoría completa.
 *   PROLIO_SIRENE_CATEGORY env elige qué categoría procesar (default
 *   "fontaneria"). El cron debe rotar la categoría entre runs.
 *
 * Off by default. `PROLIO_RUN_SIRENE_INSEE=true`. Cap con
 * `PROLIO_SIRENE_LIMIT_PER_CATEGORY` (default 10000).
 *
 * Latencia: ~300ms entre requests, 25 reg/req → ~15 min para 10k.
 */

const API_BASE = "https://recherche-entreprises.api.gouv.fr/search";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 300;
const PER_PAGE = 25;
const MAX_PAGE = Math.floor(10_000 / PER_PAGE); // = 400, hard API cap
const DEFAULT_LIMIT_PER_CATEGORY = 10_000;

// NAF/APE codes → Prolio category. Codes use INSEE format with dots.
// Verified against the API's `activite_principale` enum list.
const NAF_TO_CATEGORY: Record<string, CategoryKey> = {
  "43.22A": "fontaneria",
  "43.22B": "hvac",
  "43.21A": "electricidad",
  "45.20A": "mecanica",
  "45.20B": "mecanica",
  "71.20A": "itv",
  "43.32A": "carpinteria",
  "43.32B": "carpinteria",
  "43.32C": "cerrajero",
  "69.20Z": "fiscal",
  "71.11Z": "arquitecto",
  // 69.10Z is the umbrella "Activités juridiques". Most entries are
  // avocats; notaires are a separate profession but France doesn't
  // distinguish them at the NAF level (CSN annuaire-notaires.fr is the
  // canonical source for notaires but blocks datacenter IPs). Emitting
  // abogado here is the closest correct categorization for the avocat
  // majority. notario gap remains in TYPE_B until a datacenter-friendly
  // notarial registry is identified.
  "69.10Z": "abogado",
  "71.12B": "ingenieria",
  "86.21Z": "medicina",
  "86.23Z": "dentista",
  "86.90F": "fisioterapia",
  "86.90E": "psicologia",
  "75.00Z": "veterinario",
};

const CATEGORY_TO_NAFS: Record<string, string[]> = {};
for (const [naf, cat] of Object.entries(NAF_TO_CATEGORY)) {
  (CATEGORY_TO_NAFS[cat] ||= []).push(naf);
}

// 101 French departments. Metro 01-95 (sans 20, qui est 2A+2B) + DOM-TOM.
const FR_DEPARTMENTS: string[] = (() => {
  const out: string[] = [];
  for (let i = 1; i <= 95; i++) {
    if (i === 20) continue; // split into 2A/2B
    out.push(String(i).padStart(2, "0"));
  }
  out.push("2A", "2B");
  out.push("971", "972", "973", "974", "976"); // Guadeloupe/Martinique/Guyane/Réunion/Mayotte
  return out;
})();

interface RechercheSiege {
  activite_principale?: string;
  adresse?: string;
  cedex?: string;
  code_postal?: string;
  commune?: string;
  complement_adresse?: string;
  coordonnees?: string; // "lat,lng"
  departement?: string;
  date_creation?: string;
  date_debut_activite?: string;
  date_fermeture?: string | null;
  etat_administratif?: string; // "A" active, "F" fermé
  geo_id?: string;
  libelle_commune?: string;
  numero_voie?: string;
  type_voie?: string;
  libelle_voie?: string;
  region?: string;
}

interface RechercheResult {
  siren?: string;
  nom_complet?: string;
  nom_raison_sociale?: string;
  sigle?: string | null;
  nature_juridique?: string;
  date_creation?: string;
  date_mise_a_jour?: string;
  tranche_effectif_salarie?: string;
  caractere_employeur?: string;
  activite_principale?: string;
  section_activite_principale?: string;
  etat_administratif?: string;
  nombre_etablissements?: number;
  nombre_etablissements_ouverts?: number;
  siege?: RechercheSiege;
  // matching_etablissements typically also present (deepest match);
  // we use siege as canonical contact info.
}

interface RechercheResponse {
  total_results?: number;
  total_pages?: number;
  results?: RechercheResult[];
  page?: number;
  per_page?: number;
}

async function fetchPage(
  naf: string,
  dept: string,
  page: number,
): Promise<RechercheResponse | null> {
  const url =
    `${API_BASE}?activite_principale=${encodeURIComponent(naf)}` +
    `&departement=${encodeURIComponent(dept)}` +
    `&etat_administratif=A&per_page=${PER_PAGE}&page=${page}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[sirene-insee] ${res.status} on ${naf}/${dept} page=${page}`);
      return null;
    }
    return (await res.json()) as RechercheResponse;
  } catch (err) {
    console.warn(
      `[sirene-insee] network error on ${naf}/${dept} page=${page}: ${(err as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseCoordinates(
  raw: string | undefined,
): { lat: number; lng: number } | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => parseFloat(s.trim()));
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) return undefined;
  return { lat: parts[0], lng: parts[1] };
}

function toRecord(
  e: RechercheResult,
  naf: string,
  category: CategoryKey,
): ScrapedProfessional | null {
  const siren = (e.siren ?? "").trim();
  const name = (e.nom_complet || e.nom_raison_sociale || "").trim();
  if (!siren || !name) return null;
  const siege = e.siege ?? {};
  const cp = siege.code_postal;
  const citySlug = frPostalCodeToCitySlug(cp ?? "") ?? "paris";
  const coords = parseCoordinates(siege.coordonnees);
  return normalise({
    source: "sirene-insee" as ScrapeSource,
    country: "FR",
    sourceId: `sirene:${siren}`,
    name,
    categoryKey: category,
    citySlug,
    licenseNumber: siren,
    lat: coords?.lat,
    lng: coords?.lng,
    address: siege.adresse,
    metadata: {
      country: "FR",
      authority: "INSEE",
      verified_by_authority: true,
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
    console.warn(`[sirene-insee] no NAF codes mapped for category=${category}`);
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
              `[sirene-insee] ${naf}/${dept}: total=${total} pages=${Math.min(data.total_pages ?? 0, MAX_PAGE)}`,
            );
          }
        }
        for (const e of data.results) {
          const r = toRecord(e, naf, category);
          if (!r) continue;
          const key = r.sourceId;
          if (seen.has(key)) continue;
          seen.add(key);
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
  const category = (process.env.PROLIO_SIRENE_CATEGORY ||
    "fontaneria") as CategoryKey;
  const limit = Number(
    process.env.PROLIO_SIRENE_LIMIT_PER_CATEGORY ?? DEFAULT_LIMIT_PER_CATEGORY,
  );
  const cap = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT_PER_CATEGORY;
  console.log(`[sirene-insee] starting category=${category} cap=${cap}`);
  const records = await fetchCategory(category, cap);
  if (records.length === 0) {
    console.warn(`[sirene-insee] no rows for category=${category}`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[sirene-insee] done — category=${category} fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
