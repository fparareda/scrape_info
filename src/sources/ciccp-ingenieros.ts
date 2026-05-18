import type { ScraperSource } from "../types.js";
import {
  consejoGenericExtractor,
  runConsejoFederation,
  type ConsejoColegioConfig,
  type ConsejoFederationConfig,
} from "./_consejo-vu-utils.js";

/**
 * CICCP — Colegio de Ingenieros de Caminos, Canales y Puertos.
 *
 * Colegio único nacional (no federación) con ~28k colegiados. El buscador
 * central ciccp.es está detrás de un login para miembros — el padrón
 * público VU (Ley 17/2009) sí existe pero usa un componente JS que
 * gestiona la sesión. `curl https://www.ciccp.es/buscador-colegiados`
 * devuelve la cáscara sin filas.
 *
 * Workaround: las 17 demarcaciones territoriales del CICCP (Madrid,
 * Cataluña, Andalucía…) son colegios provinciales legalmente, pero el
 * CICCP no las trata como tales — comparten el sitio central. Aun así,
 * algunos publican páginas estáticas con listados de colegiados ejercientes
 * por demarcación. Primer pase: demarcaciones grandes con padrón directo.
 *
 * Off por defecto. Activar con `PROLIO_RUN_CICCP_INGENIEROS=true`.
 * Limit por demarcación: `PROLIO_CICCP_INGENIEROS_LIMIT_PER_COLEGIO` (default 1000).
 * Debug: `PROLIO_CICCP_INGENIEROS_ONLY=ciccp-madrid`.
 */

const COLEGIOS: ConsejoColegioConfig[] = [
  // A: demarcaciones con padrón público (a verificar tras primer run).
  {
    slug: "ciccp-madrid",
    name: "CICCP — Demarcación de Madrid",
    citySlug: "madrid",
    cityName: "Madrid",
    base: "https://www.ciccp.es",
    padronPath: "/madrid/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "~9k. La mayor demarcación.",
  },
  {
    slug: "ciccp-cataluna",
    name: "CICCP — Demarcación de Cataluña",
    citySlug: "barcelona",
    cityName: "Barcelona",
    base: "https://www.ciccp.es",
    padronPath: "/cataluna/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "ciccp-andalucia",
    name: "CICCP — Demarcación de Andalucía",
    citySlug: "sevilla",
    cityName: "Sevilla",
    base: "https://www.ciccp.es",
    padronPath: "/andalucia/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "ciccp-valencia",
    name: "CICCP — Demarcación de Comunidad Valenciana",
    citySlug: "valencia",
    cityName: "Valencia",
    base: "https://www.ciccp.es",
    padronPath: "/valencia/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "ciccp-galicia",
    name: "CICCP — Demarcación de Galicia",
    citySlug: "a-coruna",
    cityName: "A Coruña",
    base: "https://www.ciccp.es",
    padronPath: "/galicia/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "ciccp-castilla-leon",
    name: "CICCP — Demarcación de Castilla y León",
    citySlug: "valladolid",
    cityName: "Valladolid",
    base: "https://www.ciccp.es",
    padronPath: "/castilla-leon/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "ciccp-pais-vasco",
    name: "CICCP — Demarcación de País Vasco",
    citySlug: "bilbao",
    cityName: "Bilbao",
    base: "https://www.ciccp.es",
    padronPath: "/pais-vasco/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "ciccp-aragon",
    name: "CICCP — Demarcación de Aragón",
    citySlug: "zaragoza",
    cityName: "Zaragoza",
    base: "https://www.ciccp.es",
    padronPath: "/aragon/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  // B: documentadas.
  { slug: "ciccp-asturias", name: "Asturias", citySlug: "oviedo", cityName: "Oviedo", base: "https://www.ciccp.es", status: "B", extractor: null },
  { slug: "ciccp-canarias", name: "Canarias", citySlug: "las-palmas-de-gran-canaria", cityName: "Las Palmas", base: "https://www.ciccp.es", status: "B", extractor: null },
  { slug: "ciccp-cantabria", name: "Cantabria", citySlug: "santander", cityName: "Santander", base: "https://www.ciccp.es", status: "B", extractor: null },
  { slug: "ciccp-castilla-mancha", name: "Castilla-La Mancha", citySlug: "toledo", cityName: "Toledo", base: "https://www.ciccp.es", status: "B", extractor: null },
  { slug: "ciccp-extremadura", name: "Extremadura", citySlug: "badajoz", cityName: "Badajoz", base: "https://www.ciccp.es", status: "B", extractor: null },
  { slug: "ciccp-baleares", name: "Illes Balears", citySlug: "palma-de-mallorca", cityName: "Palma", base: "https://www.ciccp.es", status: "B", extractor: null },
  { slug: "ciccp-rioja", name: "La Rioja", citySlug: "logrono", cityName: "Logroño", base: "https://www.ciccp.es", status: "B", extractor: null },
  { slug: "ciccp-murcia", name: "Murcia", citySlug: "murcia", cityName: "Murcia", base: "https://www.ciccp.es", status: "B", extractor: null },
  { slug: "ciccp-navarra", name: "Navarra", citySlug: "pamplona", cityName: "Pamplona", base: "https://www.ciccp.es", status: "B", extractor: null },
];

const CONFIG: ConsejoFederationConfig = {
  federationSlug: "ciccp-ingenieros",
  sourceName: "colegio",
  authority: "CICCP",
  categoryKey: "ingenieria",
  colegios: COLEGIOS,
  onlyEnv: "PROLIO_CICCP_INGENIEROS_ONLY",
};

export const ciccpIngenierosSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_CICCP_INGENIEROS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCiccpIngenieros() {
  if (!ciccpIngenierosSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return runConsejoFederation(CONFIG, {
    limitEnv: "PROLIO_CICCP_INGENIEROS_LIMIT_PER_COLEGIO",
  });
}
