import type { ScraperSource } from "../types.js";
import {
  consejoGenericExtractor,
  runConsejoFederation,
  type ConsejoColegioConfig,
  type ConsejoFederationConfig,
} from "./_consejo-vu-utils.js";

/**
 * CGCOF — Consejo General de Colegios Oficiales de Farmacéuticos.
 *
 * España tiene ~22.300 oficinas de farmacia y ~78.000 farmacéuticos
 * colegiados. El portal central `portalfarma.com/buscador-de-farmacias`
 * es un mapa SPA (Leaflet + endpoint AJAX `getFarmacias.aspx`) que
 * exige JS y un token CSRF rotado por sesión. `curl -A Prolio-Bot
 * https://www.portalfarma.com/buscador-de-farmacias` devuelve solo la
 * carcasa HTML — sin filas explotables vía HTTP plano.
 *
 * Patrón replicado en CGAE/COP: la palanca real son los 52 Colegios
 * Oficiales de Farmacéuticos provinciales, cada uno con padrón VU
 * (Ley 17/2009). Primer pase: 8 colegios mayores (Madrid, Barcelona,
 * Valencia, Sevilla, Vizcaya, Málaga, Zaragoza, Las Palmas). Los 44
 * restantes quedan como B documentados.
 *
 * Off por defecto. Activar con `PROLIO_RUN_CGCOF_FARMACIA=true`.
 * Limit por colegio: `PROLIO_CGCOF_FARMACIA_LIMIT_PER_COLEGIO` (default 1000).
 * Debug: `PROLIO_CGCOF_FARMACIA_ONLY=cofm,cofb`.
 */

const COLEGIOS: ConsejoColegioConfig[] = [
  // A: primera oleada.
  {
    slug: "cofm",
    name: "Colegio Oficial de Farmacéuticos de Madrid",
    citySlug: "madrid",
    cityName: "Madrid",
    base: "https://www.cofm.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "~16k. Padrón público VU.",
  },
  {
    slug: "cofb",
    name: "Col·legi de Farmacèutics de Barcelona",
    citySlug: "barcelona",
    cityName: "Barcelona",
    base: "https://www.cofb.cat",
    padronPath: "/ca/cercador-de-collegiats",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "~10k.",
  },
  {
    slug: "cofvalencia",
    name: "Muy Ilustre Colegio Oficial de Farmacéuticos de Valencia",
    citySlug: "valencia",
    cityName: "Valencia",
    base: "https://www.micof.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cofsevilla",
    name: "Real e Ilustre Colegio Oficial de Farmacéuticos de Sevilla",
    citySlug: "sevilla",
    cityName: "Sevilla",
    base: "https://www.farmaceuticosdesevilla.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cofbizkaia",
    name: "Colegio Oficial de Farmacéuticos de Bizkaia",
    citySlug: "bilbao",
    cityName: "Bilbao",
    base: "https://www.cofbizkaia.net",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cofmalaga",
    name: "Colegio Oficial de Farmacéuticos de Málaga",
    citySlug: "malaga",
    cityName: "Málaga",
    base: "https://www.cofmalaga.com",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "cofzaragoza",
    name: "Colegio Oficial de Farmacéuticos de Zaragoza",
    citySlug: "zaragoza",
    cityName: "Zaragoza",
    base: "https://www.cofzaragoza.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coflaspalmas",
    name: "Colegio Oficial de Farmacéuticos de Las Palmas",
    citySlug: "las-palmas-de-gran-canaria",
    cityName: "Las Palmas",
    base: "https://www.coflp.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  // B: documentados.
  { slug: "cofalicante", name: "Alicante", citySlug: "alicante", cityName: "Alicante", base: "https://www.cofalicante.org", status: "B", extractor: null },
  { slug: "cofcastellon", name: "Castellón", citySlug: "castellon-de-la-plana", cityName: "Castellón", base: "https://www.cofcastellon.org", status: "B", extractor: null },
  { slug: "cofcordoba", name: "Córdoba", citySlug: "cordoba", cityName: "Córdoba", base: "https://www.cofco.org", status: "B", extractor: null },
  { slug: "cofgranada", name: "Granada", citySlug: "granada", cityName: "Granada", base: "https://www.cofgranada.com", status: "B", extractor: null },
  { slug: "cofalmeria", name: "Almería", citySlug: "almeria", cityName: "Almería", base: "https://www.cofalmeria.com", status: "B", extractor: null },
  { slug: "cofjaen", name: "Jaén", citySlug: "jaen", cityName: "Jaén", base: "https://www.cofjaen.net", status: "B", extractor: null },
  { slug: "cofhuelva", name: "Huelva", citySlug: "huelva", cityName: "Huelva", base: "https://www.cofhuelva.org", status: "B", extractor: null },
  { slug: "cofcadiz", name: "Cádiz", citySlug: "cadiz", cityName: "Cádiz", base: "https://www.cofcadiz.com", status: "B", extractor: null },
  { slug: "cofmurcia", name: "Murcia", citySlug: "murcia", cityName: "Murcia", base: "https://www.cofrm.com", status: "B", extractor: null },
  { slug: "cofpalma", name: "Illes Balears", citySlug: "palma-de-mallorca", cityName: "Palma", base: "https://www.cofib.es", status: "B", extractor: null },
  { slug: "coftenerife", name: "Santa Cruz de Tenerife", citySlug: "santa-cruz-de-tenerife", cityName: "Santa Cruz de Tenerife", base: "https://www.coftf.com", status: "B", extractor: null },
  { slug: "cofnavarra", name: "Navarra", citySlug: "pamplona", cityName: "Pamplona", base: "https://www.cofnavarra.org", status: "B", extractor: null },
  { slug: "cofgipuzkoa", name: "Gipuzkoa", citySlug: "san-sebastian", cityName: "San Sebastián", base: "https://www.cofgipuzkoa.com", status: "B", extractor: null },
  { slug: "cofalava", name: "Álava", citySlug: "vitoria-gasteiz", cityName: "Vitoria", base: "https://www.cofalava.org", status: "B", extractor: null },
  { slug: "cofcantabria", name: "Cantabria", citySlug: "santander", cityName: "Santander", base: "https://www.cofcantabria.org", status: "B", extractor: null },
  { slug: "cofasturias", name: "Asturias", citySlug: "oviedo", cityName: "Oviedo", base: "https://www.cofas.es", status: "B", extractor: null },
  { slug: "coflarioja", name: "La Rioja", citySlug: "logrono", cityName: "Logroño", base: "https://www.coflarioja.org", status: "B", extractor: null },
  { slug: "cofvalladolid", name: "Valladolid", citySlug: "valladolid", cityName: "Valladolid", base: "https://www.cofvalladolid.org", status: "B", extractor: null },
  { slug: "cofsalamanca", name: "Salamanca", citySlug: "salamanca", cityName: "Salamanca", base: "https://www.cofsalamanca.com", status: "B", extractor: null },
  { slug: "cofleon", name: "León", citySlug: "leon-es", cityName: "León", base: "https://www.cofleon.com", status: "B", extractor: null },
  { slug: "cofburgos", name: "Burgos", citySlug: "burgos", cityName: "Burgos", base: "https://www.cofburgos.com", status: "B", extractor: null },
  { slug: "coftoledo", name: "Toledo", citySlug: "toledo", cityName: "Toledo", base: "https://www.coftoledo.org", status: "B", extractor: null },
  { slug: "cofalbacete", name: "Albacete", citySlug: "albacete", cityName: "Albacete", base: "https://www.cofalbacete.org", status: "B", extractor: null },
  { slug: "cofbadajoz", name: "Badajoz", citySlug: "badajoz", cityName: "Badajoz", base: "https://www.cofbadajoz.org", status: "B", extractor: null },
  { slug: "cofcaceres", name: "Cáceres", citySlug: "caceres", cityName: "Cáceres", base: "https://www.cofcc.org", status: "B", extractor: null },
  { slug: "cofcoruna", name: "A Coruña", citySlug: "a-coruna", cityName: "A Coruña", base: "https://www.cofc.es", status: "B", extractor: null },
  { slug: "cofpontevedra", name: "Pontevedra", citySlug: "vigo", cityName: "Vigo", base: "https://www.cofpo.org", status: "B", extractor: null },
  { slug: "coflugo", name: "Lugo", citySlug: "lugo", cityName: "Lugo", base: "https://www.cofl.org", status: "B", extractor: null },
  { slug: "cofourense", name: "Ourense", citySlug: "ourense", cityName: "Ourense", base: "https://www.cofourense.com", status: "B", extractor: null },
  { slug: "cofgirona", name: "Girona", citySlug: "girona", cityName: "Girona", base: "https://www.cofgi.cat", status: "B", extractor: null },
  { slug: "cofllleida", name: "Lleida", citySlug: "lleida", cityName: "Lleida", base: "https://www.coflleida.org", status: "B", extractor: null },
  { slug: "coftarragona", name: "Tarragona", citySlug: "tarragona", cityName: "Tarragona", base: "https://www.coft.cat", status: "B", extractor: null },
];

const CONFIG: ConsejoFederationConfig = {
  federationSlug: "cgcof-farmacia",
  sourceName: "colegio",
  authority: "CGCOF",
  categoryKey: "farmacia",
  colegios: COLEGIOS,
  onlyEnv: "PROLIO_CGCOF_FARMACIA_ONLY",
};

export const cgcofFarmaciaSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_CGCOF_FARMACIA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCgcofFarmacia() {
  if (!cgcofFarmaciaSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return runConsejoFederation(CONFIG, {
    limitEnv: "PROLIO_CGCOF_FARMACIA_LIMIT_PER_COLEGIO",
  });
}
