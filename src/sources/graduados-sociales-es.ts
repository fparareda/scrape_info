import type { ScraperSource } from "../types.js";
import {
  consejoGenericExtractor,
  runConsejoFederation,
  type ConsejoColegioConfig,
  type ConsejoFederationConfig,
} from "./_consejo-vu-utils.js";

/**
 * Consejo General de Colegios Oficiales de Graduados Sociales de España.
 *
 * Federación de 43 colegios provinciales (~30k colegiados). Los graduados
 * sociales son profesionales del ámbito laboral, fiscal y de seguridad
 * social — el equivalente ES más cercano a asesoría laboral/fiscal. Se
 * enruta a Prolio `fiscal` por proximidad funcional.
 *
 * Padrón público obligatorio por Ley 17/2009.
 *
 * Off por defecto. `PROLIO_RUN_GRADUADOS_SOCIALES_ES=true` para activar.
 * Limit: `PROLIO_GRADUADOS_SOCIALES_ES_LIMIT_PER_COLEGIO` (default 1000).
 * Debug: `PROLIO_GRADUADOS_SOCIALES_ES_ONLY=cgsmadrid,cgsbcn`.
 */

const COLEGIOS: ConsejoColegioConfig[] = [
  // A: scrapable.
  {
    slug: "cgsmadrid",
    name: "Colegio Oficial de Graduados Sociales de Madrid",
    citySlug: "madrid",
    cityName: "Madrid",
    base: "https://www.graduadosocialmadrid.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "~5k.",
  },
  {
    slug: "cgsbcn",
    name: "Col·legi Oficial de Graduats Socials de Barcelona",
    citySlug: "barcelona",
    cityName: "Barcelona",
    base: "https://www.graduados-sociales.com",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cgsvalencia",
    name: "Colegio Oficial de Graduados Sociales de Valencia",
    citySlug: "valencia",
    cityName: "Valencia",
    base: "https://www.cograsova.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cgssevilla",
    name: "Colegio Oficial de Graduados Sociales de Sevilla",
    citySlug: "sevilla",
    cityName: "Sevilla",
    base: "https://www.graduadosocialsevilla.com",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cgsmalaga",
    name: "Colegio Oficial de Graduados Sociales de Málaga",
    citySlug: "malaga",
    cityName: "Málaga",
    base: "https://www.graduadosocialmalaga.com",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cgszaragoza",
    name: "Colegio Oficial de Graduados Sociales de Aragón",
    citySlug: "zaragoza",
    cityName: "Zaragoza",
    base: "https://www.cograsoa.com",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cgsvalladolid",
    name: "Colegio Oficial de Graduados Sociales de Valladolid",
    citySlug: "valladolid",
    cityName: "Valladolid",
    base: "https://www.graduadosocialvalladolid.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cgsbilbao",
    name: "Colegio Oficial de Graduados Sociales de Bizkaia",
    citySlug: "bilbao",
    cityName: "Bilbao",
    base: "https://www.graduadosocialbizkaia.com",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  // B: documented only.
  { slug: "cgsalava", name: "Álava", citySlug: "vitoria-gasteiz", cityName: "Vitoria", base: "https://www.graduadosocialalava.com", status: "B", extractor: null },
  { slug: "cgsalbacete", name: "Albacete", citySlug: "albacete", cityName: "Albacete", base: "https://www.cograsoab.com", status: "B", extractor: null },
  { slug: "cgsalicante", name: "Alicante", citySlug: "alicante", cityName: "Alicante", base: "https://www.cograsoalicante.com", status: "B", extractor: null },
  { slug: "cgsalmeria", name: "Almería", citySlug: "almeria", cityName: "Almería", base: "https://www.graduadosocialalmeria.com", status: "B", extractor: null },
  { slug: "cgsbadajoz", name: "Badajoz", citySlug: "badajoz", cityName: "Badajoz", base: "https://www.graduadosocialbadajoz.com", status: "B", extractor: null },
  { slug: "cgsburgos", name: "Burgos", citySlug: "burgos", cityName: "Burgos", base: "https://www.graduadosocialburgos.org", status: "B", extractor: null },
  { slug: "cgscaceres", name: "Cáceres", citySlug: "caceres", cityName: "Cáceres", base: "https://www.graduadosocialcaceres.com", status: "B", extractor: null },
  { slug: "cgscadiz", name: "Cádiz", citySlug: "cadiz", cityName: "Cádiz", base: "https://www.graduadosocialcadiz.org", status: "B", extractor: null },
  { slug: "cgscantabria", name: "Cantabria", citySlug: "santander", cityName: "Santander", base: "https://www.graduadosocialcantabria.com", status: "B", extractor: null },
  { slug: "cgscastellon", name: "Castellón", citySlug: "castellon-de-la-plana", cityName: "Castellón", base: "https://www.cograsocs.es", status: "B", extractor: null },
  { slug: "cgscordoba", name: "Córdoba", citySlug: "cordoba", cityName: "Córdoba", base: "https://www.graduadosocialcordoba.com", status: "B", extractor: null },
  { slug: "cgscoruna", name: "A Coruña-Ourense", citySlug: "a-coruna", cityName: "A Coruña", base: "https://www.cograsocor.com", status: "B", extractor: null },
  { slug: "cgsciudadreal", name: "Ciudad Real", citySlug: "ciudad-real", cityName: "Ciudad Real", base: "https://www.graduadosocialcr.com", status: "B", extractor: null },
  { slug: "cgscuenca", name: "Cuenca", citySlug: "cuenca", cityName: "Cuenca", base: "https://www.graduadosocialcuenca.com", status: "B", extractor: null },
  { slug: "cgsgirona", name: "Girona", citySlug: "girona", cityName: "Girona", base: "https://www.gsocialgirona.cat", status: "B", extractor: null },
  { slug: "cgsgranada", name: "Granada", citySlug: "granada", cityName: "Granada", base: "https://www.graduadosocialgranada.com", status: "B", extractor: null },
  { slug: "cgsguadalajara", name: "Guadalajara", citySlug: "guadalajara-es", cityName: "Guadalajara", base: "https://www.graduadosocialguadalajara.com", status: "B", extractor: null },
  { slug: "cgsgipuzkoa", name: "Gipuzkoa", citySlug: "donostia-san-sebastian", cityName: "Donostia", base: "https://www.graduadosocialgipuzkoa.com", status: "B", extractor: null },
  { slug: "cgshuelva", name: "Huelva", citySlug: "huelva", cityName: "Huelva", base: "https://www.graduadosocialhuelva.com", status: "B", extractor: null },
  { slug: "cgshuesca", name: "Huesca", citySlug: "huesca", cityName: "Huesca", base: "https://www.cograsohu.com", status: "B", extractor: null },
  { slug: "cgsjaen", name: "Jaén", citySlug: "jaen", cityName: "Jaén", base: "https://www.graduadosocialjaen.com", status: "B", extractor: null },
  { slug: "cgslaspalmas", name: "Las Palmas", citySlug: "las-palmas-de-gran-canaria", cityName: "Las Palmas", base: "https://www.graduadossocialeslaspalmas.com", status: "B", extractor: null },
  { slug: "cgsleon", name: "León", citySlug: "leon-es", cityName: "León", base: "https://www.graduadosocialleon.com", status: "B", extractor: null },
  { slug: "cgslleida", name: "Lleida", citySlug: "lleida", cityName: "Lleida", base: "https://www.graduadossocialslleida.cat", status: "B", extractor: null },
  { slug: "cgslarioja", name: "La Rioja", citySlug: "logrono", cityName: "Logroño", base: "https://www.graduadosocialrioja.com", status: "B", extractor: null },
  { slug: "cgslugo", name: "Lugo", citySlug: "lugo", cityName: "Lugo", base: "https://www.graduadosocial-lugo.com", status: "B", extractor: null },
  { slug: "cgsmurcia", name: "Murcia", citySlug: "murcia", cityName: "Murcia", base: "https://www.graduadosocialmurcia.com", status: "B", extractor: null },
  { slug: "cgsnavarra", name: "Navarra", citySlug: "pamplona", cityName: "Pamplona", base: "https://www.graduadosocialnavarra.com", status: "B", extractor: null },
  { slug: "cgsasturias", name: "Asturias", citySlug: "oviedo", cityName: "Oviedo", base: "https://www.graduadosocialasturias.com", status: "B", extractor: null },
  { slug: "cgsbaleares", name: "Illes Balears", citySlug: "palma", cityName: "Palma", base: "https://www.graduadossocialesbaleares.com", status: "B", extractor: null },
  { slug: "cgssalamanca", name: "Salamanca", citySlug: "salamanca", cityName: "Salamanca", base: "https://www.graduadosocialsalamanca.com", status: "B", extractor: null },
  { slug: "cgstenerife", name: "Santa Cruz de Tenerife", citySlug: "santa-cruz-de-tenerife", cityName: "Santa Cruz de Tenerife", base: "https://www.graduadosocialtenerife.com", status: "B", extractor: null },
  { slug: "cgstarragona", name: "Tarragona", citySlug: "tarragona", cityName: "Tarragona", base: "https://www.graduadossocialstarragona.cat", status: "B", extractor: null },
  { slug: "cgsteruel", name: "Teruel", citySlug: "teruel", cityName: "Teruel", base: "https://www.graduadosocialteruel.com", status: "B", extractor: null },
  { slug: "cgstoledo", name: "Toledo", citySlug: "toledo", cityName: "Toledo", base: "https://www.graduadosocialtoledo.com", status: "B", extractor: null },
];

const CONFIG: ConsejoFederationConfig = {
  federationSlug: "graduados-sociales-es",
  sourceName: "colegio",
  authority: "ConsejoGS",
  categoryKey: "fiscal",
  colegios: COLEGIOS,
  onlyEnv: "PROLIO_GRADUADOS_SOCIALES_ES_ONLY",
};

export const graduadosSocialesEsSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_GRADUADOS_SOCIALES_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runGraduadosSocialesEs() {
  if (!graduadosSocialesEsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return runConsejoFederation(CONFIG, {
    limitEnv: "PROLIO_GRADUADOS_SOCIALES_ES_LIMIT_PER_COLEGIO",
  });
}
