import type { ScraperSource } from "../types.js";
import {
  consejoGenericExtractor,
  runConsejoFederation,
  type ConsejoColegioConfig,
  type ConsejoFederationConfig,
} from "./_consejo-vu-utils.js";

/**
 * COIIM + similares — Federación de Colegios Oficiales de Ingenieros
 * Industriales (rama superior).
 *
 * España tiene ~50k ingenieros industriales superiores colegiados,
 * agrupados en 19 colegios autonómicos coordinados por el COGITI (no
 * confundir: COGITI agrupa los graduados/técnicos, que ya tienen su
 * propio scraper `cogiti-ingenieros.ts`; este module cubre la rama
 * SUPERIOR — ICAI/ETS — bajo el paraguas del Consejo General de
 * Colegios Oficiales de Ingenieros Industriales).
 *
 * Cada colegio publica padrón VU (Ley 17/2009). Primer pase: 8 colegios
 * mayores (Madrid, Cataluña, Andalucía Occidental, Valencia, Aragón, País
 * Vasco, Galicia, Canarias). Los 11 restantes se quedan como B
 * documentados.
 *
 * Off por defecto. Activar con `PROLIO_RUN_COIIM_INGENIEROS=true`.
 * Limit por colegio: `PROLIO_COIIM_INGENIEROS_LIMIT_PER_COLEGIO` (default 1000).
 * Debug: `PROLIO_COIIM_INGENIEROS_ONLY=coiim,coeic`.
 */

const COLEGIOS: ConsejoColegioConfig[] = [
  // A: primera oleada.
  {
    slug: "coiim",
    name: "Colegio Oficial de Ingenieros Industriales de Madrid",
    citySlug: "madrid",
    cityName: "Madrid",
    base: "https://www.coiim.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "~12k.",
  },
  {
    slug: "coeic",
    name: "Col·legi Oficial d'Enginyers Industrials de Catalunya",
    citySlug: "barcelona",
    cityName: "Barcelona",
    base: "https://www.eic.cat",
    padronPath: "/cercador-collegiats",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "~9k.",
  },
  {
    slug: "coiiaoc",
    name: "Colegio Oficial de Ingenieros Industriales de Andalucía Occidental",
    citySlug: "sevilla",
    cityName: "Sevilla",
    base: "https://www.coiiaoc.com",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coiicv",
    name: "Colegio Oficial de Ingenieros Industriales de la Comunidad Valenciana",
    citySlug: "valencia",
    cityName: "Valencia",
    base: "https://www.coiicv.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coiiar",
    name: "Colegio Oficial de Ingenieros Industriales de Aragón y La Rioja",
    citySlug: "zaragoza",
    cityName: "Zaragoza",
    base: "https://www.coiiar.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coiipv",
    name: "Colegio Oficial de Ingenieros Industriales del País Vasco",
    citySlug: "bilbao",
    cityName: "Bilbao",
    base: "https://www.ingenierosindustrialespv.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "icoiig",
    name: "Colexio Oficial de Enxeñeiros Industriais de Galicia",
    citySlug: "vigo",
    cityName: "Vigo",
    base: "https://www.icoiig.es",
    padronPath: "/buscador-colexiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coiicanarias",
    name: "Colegio Oficial de Ingenieros Industriales de Canarias",
    citySlug: "las-palmas-de-gran-canaria",
    cityName: "Las Palmas",
    base: "https://www.coiic.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  // B: documentados.
  { slug: "coiiaor", name: "Andalucía Oriental", citySlug: "granada", cityName: "Granada", base: "https://www.coiiaor.es", status: "B", extractor: null },
  { slug: "coiiclm", name: "Castilla-La Mancha", citySlug: "toledo", cityName: "Toledo", base: "https://www.coiiclm.es", status: "B", extractor: null },
  { slug: "coiicyl", name: "Castilla y León", citySlug: "valladolid", cityName: "Valladolid", base: "https://www.coiical.com", status: "B", extractor: null },
  { slug: "coiib", name: "Illes Balears", citySlug: "palma-de-mallorca", cityName: "Palma", base: "https://www.coeib.es", status: "B", extractor: null },
  { slug: "coiica", name: "Cantabria", citySlug: "santander", cityName: "Santander", base: "https://www.coiica.com", status: "B", extractor: null },
  { slug: "coiias", name: "Asturias y León", citySlug: "oviedo", cityName: "Oviedo", base: "https://www.icoiial.com", status: "B", extractor: null },
  { slug: "coiiext", name: "Extremadura", citySlug: "badajoz", cityName: "Badajoz", base: "https://www.coiiex.com", status: "B", extractor: null },
  { slug: "coiimu", name: "Región de Murcia", citySlug: "murcia", cityName: "Murcia", base: "https://www.coiirm.es", status: "B", extractor: null },
  { slug: "coiin", name: "Navarra", citySlug: "pamplona", cityName: "Pamplona", base: "https://www.icina.es", status: "B", extractor: null },
];

const CONFIG: ConsejoFederationConfig = {
  federationSlug: "coiim-ingenieros",
  sourceName: "colegio",
  authority: "COIIM",
  categoryKey: "ingenieria",
  colegios: COLEGIOS,
  onlyEnv: "PROLIO_COIIM_INGENIEROS_ONLY",
};

export const coiimIngenierosSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_COIIM_INGENIEROS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCoiimIngenieros() {
  if (!coiimIngenierosSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return runConsejoFederation(CONFIG, {
    limitEnv: "PROLIO_COIIM_INGENIEROS_LIMIT_PER_COLEGIO",
  });
}
