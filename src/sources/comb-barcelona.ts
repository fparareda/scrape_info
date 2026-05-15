import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";

/**
 * COMB — Col·legi Oficial de Metges de Barcelona · Registre de Metges.
 *
 *   https://www.comb.cat/ca/serveis/registre-metges
 *
 * ~35.000 médicos colegiados en la provincia de Barcelona. Filtros
 * públicos por número de colegiado, nombre, especialidad (60+), comarca
 * (41 comarques de Catalunya) y municipio.
 *
 * Estado al 2026-05-15: el buscador es 100% client-side React/Next sin
 * endpoint AJAX visible en el HTML inicial — los parámetros se envían
 * vía POST a un servicio interno que requiere `X-CSRF-Token` derivado
 * del cookie de sesión. Reproducir el flujo requiere:
 *
 *   1. GET inicial para obtener cookie + token.
 *   2. POST con headers `X-CSRF-Token`, `X-Requested-With`,
 *      `Content-Type: application/json` al endpoint que aún no he
 *      podido aislar sin DevTools real.
 *
 * Stub honesto siguiendo el patrón de `conacem-mx` /
 * `farmaceuticos-es-guardia`: wiring completo (types, env, runner,
 * workflow) y 0 filas hoy. La sustitución es ~1-2 horas con un
 * navegador headless real (Playwright) o una capturita de tráfico.
 *
 * Especialidades / comarcas que el adaptador real iteraría — se dejan
 * documentadas aquí para no tener que volver a descubrir el universo
 * de búsqueda más adelante.
 *
 * Off por defecto: `PROLIO_RUN_COMB_BARCELONA=true`.
 * Cap: `PROLIO_COMB_BARCELONA_LIMIT` (default 40.000).
 *
 * Categoría: medicina (la enrichment de especialidad la haría el
 * email-extractor agent al visitar el detalle).
 */

const SOURCE_NAME = "comb-barcelona" as ScrapeSource;

/**
 * 41 comarques catalanas → citySlug "capital de comarca" (o slug del
 * municipio principal de la provincia de Barcelona). Las comarcas que
 * están fuera de la provincia de Barcelona se incluyen porque el
 * registre del COMB cubre algunos colegiados que residen fuera; el
 * filtro real lo hace el sub-adapter cuando se construya.
 */
export const COMARQUES_BCN: Array<{ comarca: string; citySlug: string }> = [
  { comarca: "Barcelonès", citySlug: "barcelona" },
  { comarca: "Baix Llobregat", citySlug: "l-hospitalet-de-llobregat" },
  { comarca: "Vallès Occidental", citySlug: "sabadell" },
  { comarca: "Vallès Oriental", citySlug: "granollers" },
  { comarca: "Maresme", citySlug: "mataro" },
  { comarca: "Anoia", citySlug: "igualada" },
  { comarca: "Bages", citySlug: "manresa" },
  { comarca: "Berguedà", citySlug: "berga" },
  { comarca: "Garraf", citySlug: "vilanova-i-la-geltru" },
  { comarca: "Alt Penedès", citySlug: "vilafranca-del-penedes" },
  { comarca: "Osona", citySlug: "vic" },
  { comarca: "Moianès", citySlug: "moia" },
  // … faltan 29 comarques fuera de Barcelona provincia que no aplican
  // al COMB pero el formulario las acepta vacías.
];

export const comBarcelonaSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_COMB_BARCELONA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCombBarcelona(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!comBarcelonaSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  console.log(
    "[comb-barcelona] STUB honesto — el registre-metges del COMB es client-side " +
      "con CSRF; aislar el endpoint requiere Playwright. Wiring listo para que " +
      "el sub-adapter aterrice. 0 filas emitidas hoy.",
  );
  const _records: ScrapedProfessional[] = [];
  return { fetched: _records.length, inserted: 0, updated: 0, skipped: 0 };
}
