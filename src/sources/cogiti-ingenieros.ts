import type { ScraperSource } from "../types.js";
import {
  consejoGenericExtractor,
  runConsejoFederation,
  type ConsejoColegioConfig,
  type ConsejoFederationConfig,
} from "./_consejo-vu-utils.js";

/**
 * COGITI — Consejo General de la Ingeniería Técnica Industrial de España.
 *
 * Federación de 50 colegios provinciales de ingenieros técnicos industriales
 * (~60k colegiados). Padrón público bajo Ventanilla Única (Ley 17/2009).
 *
 * Primer pase: 8 colegios mayores. Los demás documentados como B.
 *
 * Off por defecto. `PROLIO_RUN_COGITI_INGENIEROS=true` para activar.
 * Limit: `PROLIO_COGITI_INGENIEROS_LIMIT_PER_COLEGIO` (default 1000).
 * Debug: `PROLIO_COGITI_INGENIEROS_ONLY=coitim,coitib`.
 */

const COLEGIOS: ConsejoColegioConfig[] = [
  // A: scrapable.
  {
    slug: "coitim",
    name: "Colegio Oficial de Graduados e Ingenieros Técnicos Industriales de Madrid",
    citySlug: "madrid",
    cityName: "Madrid",
    base: "https://www.coitim.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "~10k.",
  },
  {
    slug: "coitib",
    name: "Col·legi d'Enginyers Tècnics Industrials de Barcelona",
    citySlug: "barcelona",
    cityName: "Barcelona",
    base: "https://www.enginyersbcn.cat",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coitiv",
    name: "Colegio Oficial de Ingenieros Técnicos Industriales de Valencia",
    citySlug: "valencia",
    cityName: "Valencia",
    base: "https://www.coitival.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "copitise",
    name: "Colegio Oficial de Peritos e Ingenieros Técnicos Industriales de Sevilla",
    citySlug: "sevilla",
    cityName: "Sevilla",
    base: "https://www.copitise.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "copitiz",
    name: "Colegio Oficial de Peritos e Ingenieros Técnicos Industriales de Zaragoza",
    citySlug: "zaragoza",
    cityName: "Zaragoza",
    base: "https://www.copitiz.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coitibi",
    name: "Colegio Oficial de Ingenieros Técnicos Industriales de Bizkaia",
    citySlug: "bilbao",
    cityName: "Bilbao",
    base: "https://www.coitibi.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coitima",
    name: "Colegio Oficial de Peritos e Ingenieros Técnicos Industriales de Málaga",
    citySlug: "malaga",
    cityName: "Málaga",
    base: "https://www.coitima.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coitivigo",
    name: "Colegio Oficial de Peritos e Ingenieros Técnicos Industriales de Vigo",
    citySlug: "vigo",
    cityName: "Vigo",
    base: "https://www.coetivigo.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  // B: documented only.
  { slug: "coitia", name: "Alicante", citySlug: "alicante", cityName: "Alicante", base: "https://www.coitialicante.es", status: "B", extractor: null },
  { slug: "coitial", name: "Almería", citySlug: "almeria", cityName: "Almería", base: "https://www.coitial.es", status: "B", extractor: null },
  { slug: "coitiav", name: "Ávila", citySlug: "avila", cityName: "Ávila", base: "https://www.coitiavila.com", status: "B", extractor: null },
  { slug: "coitibadajoz", name: "Badajoz", citySlug: "badajoz", cityName: "Badajoz", base: "https://www.coitiba.es", status: "B", extractor: null },
  { slug: "coitiburgos", name: "Burgos", citySlug: "burgos", cityName: "Burgos", base: "https://www.coitiburgos.com", status: "B", extractor: null },
  { slug: "coiticc", name: "Cáceres", citySlug: "caceres", cityName: "Cáceres", base: "https://www.coiticc.es", status: "B", extractor: null },
  { slug: "coiticadiz", name: "Cádiz", citySlug: "cadiz", cityName: "Cádiz", base: "https://www.coiticadiz.com", status: "B", extractor: null },
  { slug: "coiticantabria", name: "Cantabria", citySlug: "santander", cityName: "Santander", base: "https://www.coiticantabria.es", status: "B", extractor: null },
  { slug: "coiticast", name: "Castellón", citySlug: "castellon-de-la-plana", cityName: "Castellón", base: "https://www.coiticas.es", status: "B", extractor: null },
  { slug: "coiticr", name: "Ciudad Real", citySlug: "ciudad-real", cityName: "Ciudad Real", base: "https://www.coiticr.es", status: "B", extractor: null },
  { slug: "coiticordoba", name: "Córdoba", citySlug: "cordoba", cityName: "Córdoba", base: "https://www.coiticordoba.com", status: "B", extractor: null },
  { slug: "coiticoruna", name: "A Coruña", citySlug: "a-coruna", cityName: "A Coruña", base: "https://www.icoiig.es", status: "B", extractor: null },
  { slug: "coiticuenca", name: "Cuenca", citySlug: "cuenca", cityName: "Cuenca", base: "https://www.coiticuenca.org", status: "B", extractor: null },
  { slug: "coitigi", name: "Girona", citySlug: "girona", cityName: "Girona", base: "https://www.coitigi.com", status: "B", extractor: null },
  { slug: "coitigranada", name: "Granada", citySlug: "granada", cityName: "Granada", base: "https://www.coitigr.es", status: "B", extractor: null },
  { slug: "coitiguada", name: "Guadalajara", citySlug: "guadalajara-es", cityName: "Guadalajara", base: "https://www.coitiguada.com", status: "B", extractor: null },
  { slug: "coitigip", name: "Gipuzkoa", citySlug: "donostia-san-sebastian", cityName: "Donostia", base: "https://www.coitigi.eus", status: "B", extractor: null },
  { slug: "coitihuelva", name: "Huelva", citySlug: "huelva", cityName: "Huelva", base: "https://www.coitihuelva.com", status: "B", extractor: null },
  { slug: "coitihu", name: "Huesca", citySlug: "huesca", cityName: "Huesca", base: "https://www.coitihu.es", status: "B", extractor: null },
  { slug: "coitijaen", name: "Jaén", citySlug: "jaen", cityName: "Jaén", base: "https://www.coitijaen.es", status: "B", extractor: null },
  { slug: "coitilas", name: "Las Palmas", citySlug: "las-palmas-de-gran-canaria", cityName: "Las Palmas", base: "https://www.coitilpa.es", status: "B", extractor: null },
  { slug: "coitileon", name: "León", citySlug: "leon-es", cityName: "León", base: "https://www.coitile.es", status: "B", extractor: null },
  { slug: "coitilleida", name: "Lleida", citySlug: "lleida", cityName: "Lleida", base: "https://www.enginyerslleida.cat", status: "B", extractor: null },
  { slug: "coitilarioja", name: "La Rioja", citySlug: "logrono", cityName: "Logroño", base: "https://www.coitiarioja.com", status: "B", extractor: null },
  { slug: "coitilugo", name: "Lugo", citySlug: "lugo", cityName: "Lugo", base: "https://www.coetilugo.com", status: "B", extractor: null },
  { slug: "coitimenorca", name: "Menorca", citySlug: "mao", cityName: "Maó", base: "https://www.coitime.es", status: "B", extractor: null },
  { slug: "coitimurcia", name: "Murcia", citySlug: "murcia", cityName: "Murcia", base: "https://www.coitirm.es", status: "B", extractor: null },
  { slug: "coitinavarra", name: "Navarra", citySlug: "pamplona", cityName: "Pamplona", base: "https://www.coitin.es", status: "B", extractor: null },
  { slug: "coitiour", name: "Ourense", citySlug: "ourense", cityName: "Ourense", base: "https://www.coetiourense.org", status: "B", extractor: null },
  { slug: "coitiasturias", name: "Asturias", citySlug: "oviedo", cityName: "Oviedo", base: "https://www.coitiapa.es", status: "B", extractor: null },
  { slug: "coitipalencia", name: "Palencia", citySlug: "palencia", cityName: "Palencia", base: "https://www.coitipa.com", status: "B", extractor: null },
  { slug: "coitibalear", name: "Illes Balears", citySlug: "palma", cityName: "Palma", base: "https://www.coetib.org", status: "B", extractor: null },
  { slug: "coitipont", name: "Pontevedra", citySlug: "pontevedra", cityName: "Pontevedra", base: "https://www.coetipontevedra.com", status: "B", extractor: null },
  { slug: "coitisal", name: "Salamanca", citySlug: "salamanca", cityName: "Salamanca", base: "https://www.coitisalamanca.es", status: "B", extractor: null },
  { slug: "coitisantacruz", name: "Santa Cruz de Tenerife", citySlug: "santa-cruz-de-tenerife", cityName: "Santa Cruz de Tenerife", base: "https://www.coiitf.es", status: "B", extractor: null },
  { slug: "coitisegovia", name: "Segovia", citySlug: "segovia", cityName: "Segovia", base: "https://www.coitisegovia.com", status: "B", extractor: null },
  { slug: "coitisoria", name: "Soria", citySlug: "soria", cityName: "Soria", base: "https://www.coiti-soria.es", status: "B", extractor: null },
  { slug: "coititarr", name: "Tarragona", citySlug: "tarragona", cityName: "Tarragona", base: "https://www.coetitarragona.org", status: "B", extractor: null },
  { slug: "coititer", name: "Teruel", citySlug: "teruel", cityName: "Teruel", base: "https://www.coitiar-teruel.es", status: "B", extractor: null },
  { slug: "coititoledo", name: "Toledo", citySlug: "toledo", cityName: "Toledo", base: "https://www.coititoledo.com", status: "B", extractor: null },
  { slug: "coitivalladolid", name: "Valladolid", citySlug: "valladolid", cityName: "Valladolid", base: "https://www.coitiva.es", status: "B", extractor: null },
  { slug: "coitiar-vit", name: "Álava", citySlug: "vitoria-gasteiz", cityName: "Vitoria", base: "https://www.coitiar.es", status: "B", extractor: null },
  { slug: "coitizam", name: "Zamora", citySlug: "zamora", cityName: "Zamora", base: "https://www.coiti-zamora.com", status: "B", extractor: null },
];

const CONFIG: ConsejoFederationConfig = {
  federationSlug: "cogiti-ingenieros",
  sourceName: "colegio",
  authority: "COGITI",
  categoryKey: "ingenieria",
  colegios: COLEGIOS,
  onlyEnv: "PROLIO_COGITI_INGENIEROS_ONLY",
};

export const cogitiIngenierosSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_COGITI_INGENIEROS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCogitiIngenieros() {
  if (!cogitiIngenierosSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return runConsejoFederation(CONFIG, {
    limitEnv: "PROLIO_COGITI_INGENIEROS_LIMIT_PER_COLEGIO",
  });
}
