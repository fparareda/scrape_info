import type { ScraperSource } from "../types.js";
import {
  consejoGenericExtractor,
  runConsejoFederation,
  type ConsejoColegioConfig,
  type ConsejoFederationConfig,
} from "./_consejo-vu-utils.js";

/**
 * COP — Consejo General de la Psicología de España.
 *
 * Federación de 23 colegios autonómicos. ~80k psicólogos colegiados.
 * Cada colegio publica padrón Ventanilla Única (Ley 17/2009).
 *
 * Nota: COPC (Cataluña) y COPM (Madrid) ya tienen scrapers dedicados en
 * `src/sources/colegios/*` con extractor bespoke; los marcamos B aquí para
 * que el fan-out genérico no los pise. El primer pase del fan-out cubre 7
 * colegios autonómicos que NO están ya cubiertos: Andalucía, Valencia,
 * Galicia, Castilla-León, País Vasco, Canarias, Aragón.
 *
 * Off por defecto. Activar con `PROLIO_RUN_COP_PSICOLOGIA=true`.
 * Limit: `PROLIO_COP_PSICOLOGIA_LIMIT_PER_COLEGIO` (default 1000).
 * Debug: `PROLIO_COP_PSICOLOGIA_ONLY=copao,copcv`.
 */

const COLEGIOS: ConsejoColegioConfig[] = [
  // A: scrapable.
  {
    slug: "copao",
    name: "Colegio Oficial de la Psicología de Andalucía Occidental",
    citySlug: "sevilla",
    cityName: "Sevilla",
    base: "https://www.copao.com",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "~6k. Andalucía Occidental (Sevilla, Huelva, Cádiz, Córdoba).",
  },
  {
    slug: "copcv",
    name: "Col·legi Oficial de Psicologia de la Comunitat Valenciana",
    citySlug: "valencia",
    cityName: "Valencia",
    base: "https://www.cop-cv.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "copgalicia",
    name: "Colexio Oficial de Psicoloxía de Galicia",
    citySlug: "santiago-de-compostela",
    cityName: "Santiago de Compostela",
    base: "https://www.copgalicia.gal",
    padronPath: "/buscador-colexiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "copcyl",
    name: "Colegio Oficial de Psicología de Castilla y León",
    citySlug: "valladolid",
    cityName: "Valladolid",
    base: "https://www.copcyl.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "copbizkaia",
    name: "Colegio Oficial de la Psicología de Bizkaia",
    citySlug: "bilbao",
    cityName: "Bilbao",
    base: "https://www.copbizkaia.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "coplaspalmas",
    name: "Colegio Oficial de la Psicología de Las Palmas",
    citySlug: "las-palmas-de-gran-canaria",
    cityName: "Las Palmas",
    base: "https://www.coplaspalmas.org",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  {
    slug: "copao-east",
    name: "Colegio Oficial de Psicología de Andalucía Oriental",
    citySlug: "granada",
    cityName: "Granada",
    base: "https://www.copao.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
    notes: "Andalucía Oriental (Granada, Almería, Jaén, Málaga).",
  },
  {
    slug: "copa",
    name: "Colegio Profesional de Psicología de Aragón",
    citySlug: "zaragoza",
    cityName: "Zaragoza",
    base: "https://www.coppa.es",
    padronPath: "/buscador-colegiados",
    status: "A",
    extractor: consejoGenericExtractor,
  },
  // B: ya cubiertos por scrapers bespoke en src/sources/colegios/.
  { slug: "copc", name: "Catalunya", citySlug: "barcelona", cityName: "Barcelona", base: "https://www.copc.cat", status: "B", extractor: null, notes: "covered by copc.ts" },
  { slug: "copm", name: "Madrid", citySlug: "madrid", cityName: "Madrid", base: "https://www.copmadrid.org", status: "B", extractor: null, notes: "covered by copm.ts" },
  // B: documented only.
  { slug: "copib", name: "Illes Balears", citySlug: "palma", cityName: "Palma", base: "https://www.copib.es", status: "B", extractor: null },
  { slug: "copao-as", name: "Asturias", citySlug: "oviedo", cityName: "Oviedo", base: "https://www.cop-asturias.org", status: "B", extractor: null },
  { slug: "copcantabria", name: "Cantabria", citySlug: "santander", cityName: "Santander", base: "https://www.copcantabria.es", status: "B", extractor: null },
  { slug: "copcm", name: "Castilla-La Mancha", citySlug: "toledo", cityName: "Toledo", base: "https://www.copclm.com", status: "B", extractor: null },
  { slug: "copext", name: "Extremadura", citySlug: "badajoz", cityName: "Badajoz", base: "https://www.copextremadura.org", status: "B", extractor: null },
  { slug: "coprm", name: "Región de Murcia", citySlug: "murcia", cityName: "Murcia", base: "https://www.coprm.es", status: "B", extractor: null },
  { slug: "coplarioja", name: "La Rioja", citySlug: "logrono", cityName: "Logroño", base: "https://www.coplarioja.org", status: "B", extractor: null },
  { slug: "copnavarra", name: "Navarra", citySlug: "pamplona", cityName: "Pamplona", base: "https://www.colpsinavarra.org", status: "B", extractor: null },
  { slug: "copgipuzkoa", name: "Gipuzkoa", citySlug: "donostia-san-sebastian", cityName: "Donostia", base: "https://www.copgipuzkoa.com", status: "B", extractor: null },
  { slug: "coparaba", name: "Álava", citySlug: "vitoria-gasteiz", cityName: "Vitoria", base: "https://www.coparaba.com", status: "B", extractor: null },
  { slug: "coptenerife", name: "Santa Cruz de Tenerife", citySlug: "santa-cruz-de-tenerife", cityName: "Santa Cruz de Tenerife", base: "https://www.coptenerife.es", status: "B", extractor: null },
  { slug: "copceuta", name: "Ceuta", citySlug: "ceuta", cityName: "Ceuta", base: "https://www.copceuta.es", status: "B", extractor: null },
  { slug: "copmelilla", name: "Melilla", citySlug: "melilla", cityName: "Melilla", base: "https://www.copmelilla.com", status: "B", extractor: null },
];

const CONFIG: ConsejoFederationConfig = {
  federationSlug: "cop-psicologia",
  sourceName: "colegio",
  authority: "COP",
  categoryKey: "psicologia",
  colegios: COLEGIOS,
  onlyEnv: "PROLIO_COP_PSICOLOGIA_ONLY",
};

export const copPsicologiaSource: ScraperSource = {
  name: "colegio",
  enabled() {
    return process.env.PROLIO_RUN_COP_PSICOLOGIA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCopPsicologia() {
  if (!copPsicologiaSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return runConsejoFederation(CONFIG, {
    limitEnv: "PROLIO_COP_PSICOLOGIA_LIMIT_PER_COLEGIO",
  });
}
