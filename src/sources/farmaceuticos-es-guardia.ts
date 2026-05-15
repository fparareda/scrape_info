import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { getSink } from "../sink.js";

/**
 * farmaceuticos.com — Consejo General de Colegios Oficiales de
 * Farmacéuticos (CGCOF) · Farmacias de Guardia.
 *
 *   https://www.farmaceuticos.com/farmacias-de-guardia/
 *
 * El portal nacional NO publica un listado plano de farmacias. Su
 * landing solo enlaza, vía botón "Consultar", al colegio provincial
 * correspondiente (p.ej. Madrid → https://www.cofm.es/.../farmacias-de-guardia/).
 * Cada colegio provincial expone su propio widget — algunos como mapa
 * Leaflet con backend JSON propio (Madrid, Barcelona, Valencia),
 * otros como tabla HTML semanal (provincias rurales), otros tras
 * captcha / Cloudflare (Sevilla).
 *
 * Decisión 2026-05-15: implementar como STUB HONESTO siguiendo el
 * patrón de `conacem-mx`. Wiring completo (env flag, runner, types,
 * workflow) y comentario explícito de qué falta para producir filas:
 *
 *   1. Para cada provincia con backend JSON conocido, escribir un
 *      adapter independiente (estilo `competitor-es-colegios-medicos`).
 *      Empezar por COFM (Madrid, ~3.000 farmacias), COFB (Barcelona,
 *      ~3.300), MICOF (Valencia, ~2.500).
 *   2. Para provincias con captcha, dejar pendiente o usar
 *      data.gob.es como alternativa.
 *   3. Source agregador en este archivo: orquesta los 52 sub-adapters
 *      una vez existan.
 *
 * Off por defecto. `PROLIO_RUN_FARMACEUTICOS_ES_GUARDIA=true` para
 * enable (devuelve 0 filas hoy).
 * Cap: `PROLIO_FARMACEUTICOS_ES_GUARDIA_LIMIT` (default 30.000).
 *
 * Nota: ~22.000 farmacias censadas en España; el dato existe en
 * COFARES (mayorista) y en CIMA-AEMPS pero ninguno es directorio
 * publico de farmacias por nombre comercial.
 */

const SOURCE_NAME = "farmaceuticos-es-guardia" as ScrapeSource;

/**
 * Mapeo provincia → colegio provincial. Mantenido aquí (en vez de en
 * un sub-adapter) porque es la única información estable que tenemos
 * mientras los adapters por colegio no existan. Útil como referencia
 * para la siguiente iteración.
 */
export const PROVINCIAL_COLEGIOS: Array<{
  provincia: string;
  citySlug: string;
  colegio: string;
  url: string;
}> = [
  { provincia: "Madrid", citySlug: "madrid", colegio: "COFM", url: "https://www.cofm.es/es/farmacias/farmacias-de-guardia/" },
  { provincia: "Barcelona", citySlug: "barcelona", colegio: "COFB", url: "https://www.cofb.cat/ca/farmacies/farmacies-de-guardia" },
  { provincia: "Valencia", citySlug: "valencia", colegio: "MICOF", url: "https://www.micof.es/" },
  { provincia: "Sevilla", citySlug: "sevilla", colegio: "Real e Ilustre Colegio Oficial de Farmacéuticos de Sevilla", url: "https://www.farmaceuticosdesevilla.es/" },
  { provincia: "Málaga", citySlug: "malaga", colegio: "COF Málaga", url: "https://www.cofmalaga.com/" },
  { provincia: "Zaragoza", citySlug: "zaragoza", colegio: "COF Zaragoza", url: "https://www.cofzaragoza.org/" },
  { provincia: "Bilbao", citySlug: "bilbao", colegio: "COF Bizkaia", url: "https://www.cofbi.org/" },
  { provincia: "Murcia", citySlug: "murcia", colegio: "COF Murcia", url: "https://www.cofrm.com/" },
  { provincia: "Palma", citySlug: "palma", colegio: "COFIB", url: "https://www.cofib.es/" },
  { provincia: "Las Palmas", citySlug: "las-palmas-de-gran-canaria", colegio: "COF Las Palmas", url: "https://www.coflp.org/" },
  // … faltan 42 colegios provinciales. Lista exhaustiva al crear los
  // adapters por colegio.
];

export const farmaceuticosEsGuardiaSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_FARMACEUTICOS_ES_GUARDIA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runFarmaceuticosEsGuardia(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!farmaceuticosEsGuardiaSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  console.log(
    "[farmaceuticos-es-guardia] STUB honesto — el portal nacional no expone " +
      "listado plano; los colegios provinciales tienen backends distintos. " +
      "Adapters por colegio pendientes (ver PROVINCIAL_COLEGIOS). 0 filas emitidas.",
  );
  // No upsert hoy: ningún sub-adapter aún produce records. Mantener el
  // wiring del sink listo para cuando el primer adapter (probablemente
  // COFM) aterrice.
  const _records: ScrapedProfessional[] = [];
  if (_records.length > 0) {
    const sink = getSink();
    return await sink
      .upsert(_records)
      .then((r) => ({ fetched: _records.length, ...r }));
  }
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
}
