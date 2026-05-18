import type { ScraperSource } from "../types.js";
import {
  consejoGenericExtractor,
  runConsejoFederation,
  type ConsejoColegioConfig,
  type ConsejoFederationConfig,
} from "./_consejo-vu-utils.js";

/**
 * CGE — Consejo General de Enfermería de España.
 *
 * Federación de 52 colegios provinciales (~320k enfermeros colegiados, el
 * cuerpo profesional sanitario más numeroso del país). El buscador central
 * en consejogeneralenfermeria.org/buscador-colegiados está protegido por
 * reCAPTCHA + sesión PHP — `curl -A Prolio-Bot https://www.consejogeneralenfermeria.org/buscador-colegiados`
 * devuelve la cáscara HTML con un formulario JS, sin datos públicos
 * accesibles desde un cliente sin navegador.
 *
 * Como en CGAE/COP, la palanca real son las Ventanillas Únicas de cada
 * colegio provincial (obligación Ley 17/2009). Primer pase: 8 colegios
 * mayores (Madrid, Barcelona, Valencia, Sevilla, Bilbao, Málaga, Zaragoza,
 * A Coruña) — concentran ~50% del nacional. Los 44 restantes se dejan
 * marcados B/C como documentación; un segundo pase con HTML real podrá
 * reclasificarlos.
 *
 * Off por defecto. Activar con `PROLIO_RUN_CGE_ENFERMERIA=true`.
 * Limit por colegio: `PROLIO_CGE_ENFERMERIA_LIMIT_PER_COLEGIO` (default 1000).
 * Subset debug: `PROLIO_CGE_ENFERMERIA_ONLY=codem,coib`.
 */

const COLEGIOS: ConsejoColegioConfig[] = [
  // A: primera oleada — colegios provinciales mayores con padrón público.
  {
    slug: "codem",
    name: "Colegio Oficial de Enfermería de Madrid",
    citySlug: "madrid",
    cityName: "Madrid",
    base: "https://www.codem.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "~50k. Padrón público obligatorio Ley 17/2009.",
  },
  {
    slug: "coib",
    name: "Col·legi Oficial d'Infermeres i Infermers de Barcelona",
    citySlug: "barcelona",
    cityName: "Barcelona",
    base: "https://www.coib.cat",
    padronPath: "/ca-es/cerca-collegiats",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "~38k.",
  },
  {
    slug: "coecova",
    name: "Colegio Oficial de Enfermería de Valencia",
    citySlug: "valencia",
    cityName: "Valencia",
    base: "https://www.enfervalencia.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coesevilla",
    name: "Colegio Oficial de Enfermería de Sevilla",
    citySlug: "sevilla",
    cityName: "Sevilla",
    base: "https://www.colegioenfermeriasevilla.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coebizkaia",
    name: "Colegio Oficial de Enfermería de Bizkaia",
    citySlug: "bilbao",
    cityName: "Bilbao",
    base: "https://www.enfermeriabizkaia.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coemalaga",
    name: "Colegio Oficial de Enfermería de Málaga",
    citySlug: "malaga",
    cityName: "Málaga",
    base: "https://www.colegioenfermeriamalaga.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coezaragoza",
    name: "Colegio Oficial de Enfermería de Zaragoza",
    citySlug: "zaragoza",
    cityName: "Zaragoza",
    base: "https://www.ocez.net",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coecoruna",
    name: "Colexio Oficial de Enfermaría de A Coruña",
    citySlug: "a-coruna",
    cityName: "A Coruña",
    base: "https://www.coecoruna.com",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  // B: documentados — verificar HTML en segunda oleada.
  { slug: "coevalladolid", name: "Valladolid", citySlug: "valladolid", cityName: "Valladolid", base: "https://www.enfermeriavalladolid.com", status: "B", extractor: null },
  { slug: "coegranada", name: "Granada", citySlug: "granada", cityName: "Granada", base: "https://www.ccenfermeria.com", status: "B", extractor: null },
  { slug: "coealicante", name: "Alicante", citySlug: "alicante", cityName: "Alicante", base: "https://www.enferalicante.org", status: "B", extractor: null },
  { slug: "coemurcia", name: "Murcia", citySlug: "murcia", cityName: "Murcia", base: "https://www.enfermeriademurcia.org", status: "B", extractor: null },
  { slug: "coebaleares", name: "Illes Balears", citySlug: "palma-de-mallorca", cityName: "Palma", base: "https://www.enfermeriabalear.com", status: "B", extractor: null },
  { slug: "coetenerife", name: "Tenerife", citySlug: "santa-cruz-de-tenerife", cityName: "Santa Cruz de Tenerife", base: "https://www.colegiodeenfermeriadetenerife.es", status: "B", extractor: null },
  { slug: "coelaspalmas", name: "Las Palmas", citySlug: "las-palmas-de-gran-canaria", cityName: "Las Palmas", base: "https://www.colegioenfermerialaspalmas.org", status: "B", extractor: null },
  { slug: "coenavarra", name: "Navarra", citySlug: "pamplona", cityName: "Pamplona", base: "https://www.enfermerianavarra.com", status: "B", extractor: null },
  { slug: "coegipuzkoa", name: "Gipuzkoa", citySlug: "san-sebastian", cityName: "San Sebastián", base: "https://www.coegi.org", status: "B", extractor: null },
  { slug: "coealava", name: "Álava", citySlug: "vitoria-gasteiz", cityName: "Vitoria", base: "https://www.coealava.org", status: "B", extractor: null },
  { slug: "coecantabria", name: "Cantabria", citySlug: "santander", cityName: "Santander", base: "https://www.enfermeriacantabria.com", status: "B", extractor: null },
  { slug: "coeasturias", name: "Asturias", citySlug: "oviedo", cityName: "Oviedo", base: "https://www.codenas.es", status: "B", extractor: null },
  { slug: "coerioja", name: "La Rioja", citySlug: "logrono", cityName: "Logroño", base: "https://www.enfermerialarioja.com", status: "B", extractor: null },
  { slug: "coevigo", name: "Pontevedra", citySlug: "vigo", cityName: "Vigo", base: "https://www.coepontevedra.es", status: "B", extractor: null },
  { slug: "coelugo", name: "Lugo", citySlug: "lugo", cityName: "Lugo", base: "https://www.enfermerialugo.org", status: "B", extractor: null },
  { slug: "coeourense", name: "Ourense", citySlug: "ourense", cityName: "Ourense", base: "https://www.enfermeriaourense.org", status: "B", extractor: null },
  { slug: "coecastellon", name: "Castellón", citySlug: "castellon-de-la-plana", cityName: "Castellón", base: "https://www.enfermeriacastellon.org", status: "B", extractor: null },
  { slug: "coetarragona", name: "Tarragona", citySlug: "tarragona", cityName: "Tarragona", base: "https://www.codita.org", status: "B", extractor: null },
  { slug: "coelleida", name: "Lleida", citySlug: "lleida", cityName: "Lleida", base: "https://www.coill.org", status: "B", extractor: null },
  { slug: "coegirona", name: "Girona", citySlug: "girona", cityName: "Girona", base: "https://www.codgi.cat", status: "B", extractor: null },
  { slug: "coecadiz", name: "Cádiz", citySlug: "cadiz", cityName: "Cádiz", base: "https://www.coecadiz.com", status: "B", extractor: null },
  { slug: "coecordoba", name: "Córdoba", citySlug: "cordoba", cityName: "Córdoba", base: "https://www.ccenfermeria.org", status: "B", extractor: null },
  { slug: "coealmeria", name: "Almería", citySlug: "almeria", cityName: "Almería", base: "https://www.cecova.org", status: "B", extractor: null },
  { slug: "coehuelva", name: "Huelva", citySlug: "huelva", cityName: "Huelva", base: "https://www.colegioenfermeriahuelva.org", status: "B", extractor: null },
  { slug: "coejaen", name: "Jaén", citySlug: "jaen", cityName: "Jaén", base: "https://www.colegioenfermeriajaen.com", status: "B", extractor: null },
  { slug: "coebadajoz", name: "Badajoz", citySlug: "badajoz", cityName: "Badajoz", base: "https://www.colegioenfermeriabadajoz.com", status: "B", extractor: null },
  { slug: "coecaceres", name: "Cáceres", citySlug: "caceres", cityName: "Cáceres", base: "https://www.coec.org", status: "B", extractor: null },
];

const CONFIG: ConsejoFederationConfig = {
  federationSlug: "cge-enfermeria",
  sourceName: "colegio",
  authority: "CGE",
  categoryKey: "enfermeria",
  colegios: COLEGIOS,
  onlyEnv: "PROLIO_CGE_ENFERMERIA_ONLY",
};

export const cgeEnfermeriaSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_CGE_ENFERMERIA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCgeEnfermeria() {
  if (!cgeEnfermeriaSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return runConsejoFederation(CONFIG, {
    limitEnv: "PROLIO_CGE_ENFERMERIA_LIMIT_PER_COLEGIO",
  });
}
