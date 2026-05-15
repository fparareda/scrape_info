import type { ScraperSource } from "../types.js";
import {
  consejoGenericExtractor,
  runConsejoFederation,
  type ConsejoColegioConfig,
  type ConsejoFederationConfig,
} from "./_consejo-vu-utils.js";

/**
 * CGCFE — Consejo General de Colegios de Fisioterapeutas de España.
 *
 * Federación de 17 colegios autonómicos/provinciales. Por mandato Ley
 * 17/2009 (Servicios) cada colegio expone una Ventanilla Única con padrón
 * público de colegiados. El consejo central concentra el ~80k nacional.
 *
 * Primer pase: 8 colegios mayores (Madrid, Cataluña, Andalucía, Valencia,
 * Galicia, Castilla-León, País Vasco, Canarias). Los 9 restantes se dejan
 * marcados B/C como documentación; un segundo pase con HTML real podrá
 * reclasificarlos.
 *
 * Off por defecto. Activar con `PROLIO_RUN_CGCFE_FISIO=true`.
 * Limit por colegio: `PROLIO_CGCFE_FISIO_LIMIT_PER_COLEGIO` (default 1000).
 * Subset debug: `PROLIO_CGCFE_FISIO_ONLY=icofcv,colfisiomad`.
 */

const COLEGIOS: ConsejoColegioConfig[] = [
  {
    slug: "colfisiomad",
    name: "Colegio Profesional de Fisioterapeutas de la Comunidad de Madrid",
    citySlug: "madrid",
    cityName: "Madrid",
    base: "https://www.colfisiomad.org",
    padronPath: "/ciudadanos/buscador-de-colegiados/",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "~12k. Padrón público con paginación.",
  },
  {
    slug: "cfc",
    name: "Col·legi de Fisioterapeutes de Catalunya",
    citySlug: "barcelona",
    cityName: "Barcelona",
    base: "https://www.fisioterapeutes.cat",
    padronPath: "/ciutadania/cerca-de-fisioterapeutes",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "~10k.",
  },
  {
    slug: "icofcv",
    name: "Il·lustre Col·legi Oficial de Fisioterapeutes de la Comunitat Valenciana",
    citySlug: "valencia",
    cityName: "Valencia",
    base: "https://www.colfisiocv.com",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "colefisioand",
    name: "Ilustre Colegio Profesional de Fisioterapeutas de Andalucía",
    citySlug: "sevilla",
    cityName: "Sevilla",
    base: "https://www.colfisio.org",
    padronPath: "/buscador-de-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cofiga",
    name: "Colexio Oficial de Fisioterapeutas de Galicia",
    citySlug: "a-coruna",
    cityName: "A Coruña",
    base: "https://www.cofiga.org",
    padronPath: "/cidadania/buscador-colexiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cpfcm",
    name: "Colegio Profesional de Fisioterapeutas de Castilla y León",
    citySlug: "valladolid",
    cityName: "Valladolid",
    base: "https://www.cpfcyl.com",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cofpv",
    name: "Colegio Oficial de Fisioterapeutas del País Vasco",
    citySlug: "bilbao",
    cityName: "Bilbao",
    base: "https://www.cofpv.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "colfican",
    name: "Colegio Oficial de Fisioterapeutas de Canarias",
    citySlug: "las-palmas-de-gran-canaria",
    cityName: "Las Palmas",
    base: "https://www.colfican.com",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  // B: documented only — verify on second pass.
  { slug: "cofib", name: "Illes Balears", citySlug: "palma", cityName: "Palma", base: "https://www.colfisiobalear.org", status: "B", extractor: null },
  { slug: "colfisioar", name: "Aragón", citySlug: "zaragoza", cityName: "Zaragoza", base: "https://www.colfisioaragon.org", status: "B", extractor: null },
  { slug: "cofiex", name: "Extremadura", citySlug: "badajoz", cityName: "Badajoz", base: "https://www.cofext.org", status: "B", extractor: null },
  { slug: "cofcam", name: "Castilla-La Mancha", citySlug: "toledo", cityName: "Toledo", base: "https://www.colfisioclm.org", status: "B", extractor: null },
  { slug: "cofican", name: "Cantabria", citySlug: "santander", cityName: "Santander", base: "https://www.colfisiocant.org", status: "B", extractor: null },
  { slug: "cofna", name: "Navarra", citySlug: "pamplona", cityName: "Pamplona", base: "https://www.cofna.org", status: "B", extractor: null },
  { slug: "cofla", name: "La Rioja", citySlug: "logrono", cityName: "Logroño", base: "https://www.cofrioja.org", status: "B", extractor: null },
  { slug: "cofiast", name: "Asturias", citySlug: "oviedo", cityName: "Oviedo", base: "https://www.cofispa.org", status: "B", extractor: null },
  { slug: "cofmu", name: "Murcia", citySlug: "murcia", cityName: "Murcia", base: "https://www.cofrm.com", status: "B", extractor: null },
];

const CONFIG: ConsejoFederationConfig = {
  federationSlug: "cgcfe-fisio",
  sourceName: "colegio",
  authority: "CGCFE",
  categoryKey: "fisioterapia",
  colegios: COLEGIOS,
  onlyEnv: "PROLIO_CGCFE_FISIO_ONLY",
};

export const cgcfeFisioSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_CGCFE_FISIO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCgcfeFisio() {
  if (!cgcfeFisioSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return runConsejoFederation(CONFIG, {
    limitEnv: "PROLIO_CGCFE_FISIO_LIMIT_PER_COLEGIO",
  });
}
