import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * IMSS — Directorio de unidades médicas del Instituto Mexicano del
 * Seguro Social.
 *
 *   https://www.gob.mx/imss/directorio
 *
 * Universo estimado: ~6,000 unidades (UMF, HGZ, HGR, UMAE, clínicas
 * de medicina familiar) repartidas por las 35 delegaciones IMSS a lo
 * largo de los 32 estados. Es la red pública de salud más grande del
 * país y, por mucho, la fuente más valiosa de direcciones médicas
 * verificadas (cada unidad tiene CLUES — Clave Única de Establecimientos
 * de Salud — emitida por la DGIS).
 *
 * ---------------------------------------------------------------------
 * BLOQUEO — el directorio público actual NO es scrapable directamente
 * ---------------------------------------------------------------------
 *
 * Auditoría 2026-05-15:
 *
 *   GET  https://www.gob.mx/imss/directorio        → timeout / 504
 *        (la página oficial del directorio sirve un widget JS que
 *         consulta un backend interno; las solicitudes server-side
 *         desde datacenter IPs se cuelgan ≥60s — comportamiento típico
 *         de WAF anti-bot del portal gob.mx).
 *   GET  https://directorio.imss.gob.mx/           → ECONNREFUSED
 *        (subdominio no resoluble desde fuera; antes apuntaba al
 *         buscador interno, ahora migrado).
 *
 * Alternativas exploradas:
 *
 *   1. CLUES (catálogo DGIS-SSA) — incluye TODAS las unidades médicas
 *      del país (IMSS + ISSSTE + SSA estatal + privados). Es un XLSX
 *      en `http://www.dgis.salud.gob.mx/contenidos/sinais/...` y se
 *      actualiza trimestralmente. Es el camino correcto para cubrir
 *      este universo a escala nacional, pero pertenece a la SSA, no
 *      al IMSS, y merece su propia fuente (`clues-mx.ts`, pendiente).
 *
 *   2. datos.gob.mx — el dataset "Directorio de unidades médicas IMSS"
 *      existió en 2018 pero fue retirado del catálogo en 2022. Las
 *      URLs históricas (.csv en `datos.imss.gob.mx`) devuelven 404.
 *
 *   3. Mapa público — `mapa.imss.gob.mx` muestra unidades en un mapa
 *      Leaflet alimentado por un endpoint privado bajo `/api/`, cuyas
 *      llamadas requieren un token rotativo inyectado por el SSR de
 *      Next.js (patrón idéntico al de CONACEM, ver `conacem-mx.ts`).
 *
 * Esta fuente queda como STUB honesto. Recomendación: priorizar
 * `clues-mx` (DGIS-SSA) como sustituto natural — cubre el mismo
 * universo IMSS y además ISSSTE, SSA, SEDENA, privados y veterinarios
 * en un único XLSX trimestral con CLUES, lat/lng, nivel y tipo. La
 * flag IMSS se mantiene para reactivar si el portal gob.mx libera un
 * endpoint público o si conseguimos credenciales del API interno.
 *
 * Categoría Prolio: `medicina`.
 *
 * Off by default. `PROLIO_RUN_IMSS_DIRECTORIO=true`.
 * Cap con `PROLIO_IMSS_DIRECTORIO_LIMIT` (default 8000).
 */

const BASE_URL =
  process.env.PROLIO_IMSS_DIRECTORIO_URL || "https://www.gob.mx/imss/directorio";
const DEFAULT_LIMIT = 8_000;
const CATEGORY: CategoryKey = "medicina";
void CATEGORY;
void BASE_URL;

async function fetchAll(_limit: number): Promise<ScrapedProfessional[]> {
  console.warn(
    `[imss-directorio] BLOCKED — el portal gob.mx/imss/directorio se ` +
      `cuelga (≥60s timeout) y los subdominios alternativos están ` +
      `caídos. Recomendación: usar fuente CLUES (DGIS-SSA) que cubre ` +
      `IMSS + ISSSTE + SSA + privados en un XLSX trimestral. Ver ` +
      `header del fichero para detalles. Salimos sin tocar la red.`,
  );
  return [];
}

export const imssDirectorioEnabled = (): boolean =>
  process.env.PROLIO_RUN_IMSS_DIRECTORIO === "true";

export const imssDirectorioSource: ScraperSource = {
  name: "imss-directorio" as ScrapeSource,
  enabled: imssDirectorioEnabled,
  async fetch() {
    return [];
  },
};

export async function runImssDirectorio(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!imssDirectorioEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("imss-directorio", async () => {
    const rawLimit = Number(
      process.env.PROLIO_IMSS_DIRECTORIO_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
    const records = await fetchAll(limit);
    if (records.length === 0)
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
    return {
      rowsFetched: records.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
    };
  }).then((r) => ({
    fetched: r?.rowsFetched ?? 0,
    inserted: 0,
    updated: 0,
    skipped: r?.rowsSkipped ?? 0,
  }));
}
