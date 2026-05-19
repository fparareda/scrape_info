import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * CSCAE — Consejo Superior de los Colegios de Arquitectos de España.
 *
 * Federation fan-out across the 17 autonomous COAs (~58k arquitectos
 * nationally). The federation site (cscae.com) links to each colegio;
 * the actual buscadores live on each colegio's own domain.
 *
 * Pre-flight: robots.txt is Joomla-default (blocks /administrator/,
 * /cache/, etc.). Public buscadores are not under those paths.
 *
 * Off by default; `PROLIO_RUN_CSCAE=true` to enable. Cap via
 * `PROLIO_CSCAE_LIMIT_PER_CITY` (default 1000).
 *
 * Scrapeability classification per colegio (verify on first run):
 *   A (HTML buscador, public list)        — COAM, COAC-Cat, COAVN,
 *                                            COAS, COACyl, COACV, COAA,
 *                                            COAIB, COAR-Cantabria,
 *                                            COAR-Rioja, COACEX, COAG,
 *                                            COAC-Canarias, COA-Aragón,
 *                                            COA-CLM, COAMU, COA-Asturias
 *   B (JS-rendered / API needed)          — none confirmed; fall back to
 *                                            HTML scrape with empty
 *                                            results until verified.
 *   C (auth-only / not public)            — none known.
 *
 * Every collegio below is treated as "A" with a tolerant HTML row regex;
 * failure to extract rows is logged but does not abort the run.
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_DELAY_MS = 2000;
const DEFAULT_LIMIT_PER_CITY = 1000;
const MAX_PAGES = 300;

interface ColegioConfig {
  /** Short authority code, used in sourceId prefix and metadata.colegio. */
  code: string;
  /** Base URL of the colegio's website. */
  base: string;
  /** Path to the public buscador / colegiados list. */
  path: string;
  /** Query-string param key for the locality / city filter. */
  cityParam: string;
  /** Cities to iterate (slug → human query value). */
  cities: Array<{ slug: string; query: string }>;
}

const COLEGIOS: ColegioConfig[] = [
  {
    code: "COAM",
    base: process.env.PROLIO_COAM_BASE || "https://www.coam.org",
    path: process.env.PROLIO_COAM_PATH || "/es/profesionales/buscador",
    cityParam: "localidad",
    cities: [
      { slug: "madrid", query: "Madrid" },
      { slug: "alcala-henares", query: "Alcalá de Henares" },
      { slug: "mostoles", query: "Móstoles" },
      { slug: "fuenlabrada", query: "Fuenlabrada" },
      { slug: "leganes", query: "Leganés" },
      { slug: "getafe", query: "Getafe" },
      { slug: "alcorcon", query: "Alcorcón" },
    ],
  },
  {
    code: "COAC",
    base: "https://www.arquitectes.cat",
    path: "/ca/cercador-arquitectes",
    cityParam: "poblacio",
    cities: [
      { slug: "barcelona", query: "Barcelona" },
      { slug: "lleida", query: "Lleida" },
      { slug: "tarragona", query: "Tarragona" },
      { slug: "girona", query: "Girona" },
      { slug: "sabadell", query: "Sabadell" },
      { slug: "terrassa", query: "Terrassa" },
      { slug: "lhospitalet-de-llobregat", query: "L'Hospitalet de Llobregat" },
    ],
  },
  {
    code: "COAVN",
    base: "https://www.coavn.org",
    path: "/coavn/buscador",
    cityParam: "ciudad",
    cities: [
      { slug: "bilbao", query: "Bilbao" },
      { slug: "donostia-san-sebastian", query: "Donostia" },
      { slug: "vitoria-gasteiz", query: "Vitoria-Gasteiz" },
      { slug: "pamplona", query: "Pamplona" },
    ],
  },
  {
    code: "COAS",
    base: "https://www.coasevilla.org",
    path: "/buscador",
    cityParam: "localidad",
    cities: [
      { slug: "sevilla", query: "Sevilla" },
      { slug: "dos-hermanas", query: "Dos Hermanas" },
      { slug: "alcala-de-guadaira", query: "Alcalá de Guadaíra" },
    ],
  },
  {
    code: "COACyL",
    base: "https://www.coacyle.com",
    path: "/buscador-arquitectos",
    cityParam: "ciudad",
    cities: [
      { slug: "valladolid", query: "Valladolid" },
      { slug: "salamanca", query: "Salamanca" },
      { slug: "leon", query: "León" },
      { slug: "burgos", query: "Burgos" },
      { slug: "segovia", query: "Segovia" },
      { slug: "soria", query: "Soria" },
      { slug: "avila", query: "Ávila" },
      { slug: "palencia", query: "Palencia" },
      { slug: "zamora", query: "Zamora" },
    ],
  },
  {
    code: "COACV",
    base: "https://www.coacv.org",
    path: "/cercador-arquitectes",
    cityParam: "poblacio",
    cities: [
      { slug: "valencia", query: "Valencia" },
      { slug: "alicante", query: "Alicante" },
      { slug: "castellon-de-la-plana", query: "Castellón de la Plana" },
      { slug: "elche", query: "Elche" },
    ],
  },
  {
    code: "COAA-Asturias",
    base: "https://www.coaa.es",
    path: "/buscador",
    cityParam: "localidad",
    cities: [
      { slug: "oviedo", query: "Oviedo" },
      { slug: "gijon", query: "Gijón" },
      { slug: "aviles", query: "Avilés" },
    ],
  },
  {
    code: "COAIB",
    base: "https://www.coaib.es",
    path: "/buscador-arquitectos",
    cityParam: "ciudad",
    cities: [
      { slug: "palma", query: "Palma" },
      { slug: "ibiza", query: "Ibiza" },
      { slug: "mahon", query: "Mahón" },
    ],
  },
  {
    code: "COAR-Cantabria",
    base: "https://www.coacan.es",
    path: "/buscador",
    cityParam: "localidad",
    cities: [
      { slug: "santander", query: "Santander" },
      { slug: "torrelavega", query: "Torrelavega" },
    ],
  },
  {
    code: "COAR-LaRioja",
    base: "https://www.coar.es",
    path: "/buscador",
    cityParam: "localidad",
    cities: [
      { slug: "logrono", query: "Logroño" },
      { slug: "calahorra", query: "Calahorra" },
    ],
  },
  {
    code: "COACEX",
    base: "https://www.coade.org",
    path: "/buscador",
    cityParam: "localidad",
    cities: [
      { slug: "badajoz", query: "Badajoz" },
      { slug: "caceres", query: "Cáceres" },
      { slug: "merida", query: "Mérida" },
    ],
  },
  {
    code: "COAG",
    base: "https://www.colexiodearquitectos.org",
    path: "/buscador",
    cityParam: "localidade",
    cities: [
      { slug: "a-coruna", query: "A Coruña" },
      { slug: "santiago-de-compostela", query: "Santiago de Compostela" },
      { slug: "vigo", query: "Vigo" },
      { slug: "ourense", query: "Ourense" },
      { slug: "lugo", query: "Lugo" },
      { slug: "pontevedra", query: "Pontevedra" },
    ],
  },
  {
    code: "COAC-Canarias",
    base: "https://www.coactfe.org",
    path: "/buscador",
    cityParam: "localidad",
    cities: [
      { slug: "santa-cruz-de-tenerife", query: "Santa Cruz de Tenerife" },
      { slug: "las-palmas-de-gran-canaria", query: "Las Palmas de Gran Canaria" },
      { slug: "la-laguna", query: "San Cristóbal de La Laguna" },
    ],
  },
  {
    code: "COAA-Aragon",
    base: "https://www.coaaragon.es",
    path: "/buscador",
    cityParam: "localidad",
    cities: [
      { slug: "zaragoza", query: "Zaragoza" },
      { slug: "huesca", query: "Huesca" },
      { slug: "teruel", query: "Teruel" },
    ],
  },
  {
    code: "COACM",
    base: "https://www.coacm.es",
    path: "/buscador",
    cityParam: "localidad",
    cities: [
      { slug: "toledo", query: "Toledo" },
      { slug: "albacete", query: "Albacete" },
      { slug: "ciudad-real", query: "Ciudad Real" },
      { slug: "cuenca", query: "Cuenca" },
      { slug: "guadalajara", query: "Guadalajara" },
    ],
  },
  {
    code: "COAMU",
    base: "https://www.coamu.es",
    path: "/buscador",
    cityParam: "localidad",
    cities: [
      { slug: "murcia", query: "Murcia" },
      { slug: "cartagena", query: "Cartagena" },
      { slug: "lorca", query: "Lorca" },
    ],
  },
  {
    code: "COAA-Andalucia",
    base: "https://www.coamalaga.es",
    path: "/buscador",
    cityParam: "localidad",
    cities: [
      { slug: "malaga", query: "Málaga" },
      { slug: "marbella", query: "Marbella" },
      { slug: "granada", query: "Granada" },
      { slug: "cordoba", query: "Córdoba" },
      { slug: "almeria", query: "Almería" },
      { slug: "cadiz", query: "Cádiz" },
      { slug: "jaen", query: "Jaén" },
      { slug: "huelva", query: "Huelva" },
    ],
  },
];

const ROW_RE =
  /(?:n[º°o]?\s*coleg[^<]*?[:>]\s*|colegiad[oa][^<]*?[:>]\s*)?(\d{3,7})[\s\S]{0,300}?<[^>]+class="[^"]*(?:nombre|name|arquitecto|colegiado)[^"]*"[^>]*>\s*([^<]+?)\s*</gi;

interface Arquitecto {
  num: string;
  name: string;
}

async function fetchPage(
  colegio: ColegioConfig,
  query: string,
  page: number,
): Promise<string> {
  const url = new URL(`${colegio.base}${colegio.path}`);
  url.searchParams.set(colegio.cityParam, query);
  if (page > 1) url.searchParams.set("page", String(page));
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${colegio.code} ${url.pathname} → ${response.status}`);
  }
  return response.text();
}

function parseRows(html: string): Arquitecto[] {
  const out: Arquitecto[] = [];
  const seen = new Set<string>();
  ROW_RE.lastIndex = 0;
  for (const m of html.matchAll(ROW_RE)) {
    const [, num, name] = m;
    if (num && name && !seen.has(num)) {
      seen.add(num);
      out.push({ num, name: name.trim() });
    }
  }
  return out;
}

async function fetchColegio(
  colegio: ColegioConfig,
  limitPerCity: number,
): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  for (const city of colegio.cities) {
    const seen = new Set<string>();
    let collected = 0;
    try {
      for (let p = 1; p <= MAX_PAGES; p += 1) {
        if (collected >= limitPerCity) break;
        const html = await fetchPage(colegio, city.query, p);
        const rows = parseRows(html);
        if (rows.length === 0) break;
        let added = 0;
        for (const r of rows) {
          if (seen.has(r.num)) continue;
          seen.add(r.num);
          out.push(
            normalise({
              source: "colegio",
              country: "ES",
              sourceId: `cscae:${colegio.code.toLowerCase()}:${city.slug}:${r.num}`,
              name: toTitleCase(r.name),
              categoryKey: "arquitecto",
              citySlug: city.slug,
              licenseNumber: r.num,
              metadata: {
                country: "ES",
                authority: "CSCAE",
                colegio: colegio.code,
                verified_by_authority: true,
              },
            }),
          );
          collected += 1;
          added += 1;
          if (collected >= limitPerCity) break;
        }
        if (added === 0) break;
        if (p < MAX_PAGES) await delay(REQUEST_DELAY_MS);
      }
    } catch (error) {
      console.error(
        `[cscae:${colegio.code}] ${city.slug} fetch failed: ${(error as Error).message}`,
      );
    }
    console.log(`[cscae:${colegio.code}] ${city.slug} → ${collected} rows`);
  }
  return out;
}

async function fetchAll(limitPerCity: number): Promise<ScrapedProfessional[]> {
  const all: ScrapedProfessional[] = [];
  for (const colegio of COLEGIOS) {
    const rows = await fetchColegio(colegio, limitPerCity);
    all.push(...rows);
  }
  return all;
}

export const cscaeSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_CSCAE === "true";
  },
  async fetch() {
    return [];
  },
} as ScraperSource;

export async function runCscae(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cscaeSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_CSCAE_LIMIT_PER_CITY ?? DEFAULT_LIMIT_PER_CITY,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT_PER_CITY;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[cscae] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
