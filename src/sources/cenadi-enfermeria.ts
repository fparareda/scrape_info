import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * CENADI-Enfermería — Comisión Permanente de Enfermería (CPE) +
 * Registro Nacional de Enfermería (RNE), Secretaría de Salud.
 *
 *   Landing: https://www.gob.mx/salud/cpe
 *
 * Universo teórico: ~250,000 enfermeras/os con registro CPE vigente.
 * Es el MAYOR potencial de cobertura para la nueva categoría Prolio
 * `enfermeria` en México (sumado al estimado de 300k-500k personal
 * de enfermería trabajando en sector público + privado).
 *
 * ---------------------------------------------------------------------
 * BLOQUEO — el padrón RNE no es público (2026-05-18)
 * ---------------------------------------------------------------------
 *
 * Probe 2026-05-18:
 *
 *   GET  https://www.gob.mx/salud/cpe                       → 200 (landing)
 *        Solo descripción institucional + boletines, sin link a
 *        directorio nominal de enfermeras/os.
 *   GET  https://www.gob.mx/salud/cpe/acciones-y-programas/registro-nacional-
 *        de-enfermeria                                      → 200 (landing)
 *        Descripción del RNE; menciona que el registro se realiza vía
 *        SEP (cédula) + cursos avalados por CPE. NO se publica padrón.
 *   GET  https://www.datos.gob.mx/busca/dataset?q=enfermeria
 *                                                          → 200, sin
 *        dataset descargable con padrón individual; solo agregados
 *        estadísticos (DGIS censos).
 *   GET  https://www.cedulaprofesional.sep.gob.mx/cedula/   → reCAPTCHA
 *        Mismo bloqueo descrito en `sic-ss-medicina.ts`. Los enfermeros
 *        con licenciatura tienen cédula SEP; los técnicos no aparecen.
 *
 * Colegios profesionales auditados por muestra (CNEM, COMEN-CDMX,
 * Asociación Mexicana de Enfermería en Quirófano AMEQ, etc.):
 *   - Todos publican únicamente junta directiva + cursos.
 *   - Ninguno publica padrón nominal navegable.
 *
 * Cobertura efectiva por otras fuentes del repo:
 *   - `clues-sinais-mx` indirectamente (cada unidad médica reporta su
 *     plantilla de enfermería como NÚMERO, no nombres).
 *   - `denue-mx` no tiene SCIAN de enfermería independiente.
 *
 * Reactivación cuando:
 *   a) CPE publique directorio (han anunciado modernización RNE 2025-26
 *      sin fecha firme — monitorear),
 *   b) acceso INAI a CENADI/CPE vía solicitud de transparencia,
 *   c) convenio Prolio ⇄ Comisión Permanente de Enfermería.
 *
 * Categoría: `enfermeria`.
 *
 * Off by default. `PROLIO_RUN_CENADI_ENFERMERIA=true`.
 * Cap con `PROLIO_CENADI_ENFERMERIA_LIMIT` (default 250000).
 */

const BASE_URL =
  process.env.PROLIO_CENADI_ENFERMERIA_URL || "https://www.gob.mx/salud/cpe";
const DEFAULT_LIMIT = 250_000;
const CATEGORY: CategoryKey = "enfermeria";
void CATEGORY;
void BASE_URL;

async function fetchAll(_limit: number): Promise<ScrapedProfessional[]> {
  console.warn(
    `[cenadi-enfermeria] BLOCKED — CPE/RNE no publican padrón; colegios ` +
      `profesionales solo junta directiva; SEP cédula uno-a-uno con ` +
      `reCAPTCHA. Ver header para reactivación.`,
  );
  return [];
}

export const cenadiEnfermeriaEnabled = (): boolean =>
  process.env.PROLIO_RUN_CENADI_ENFERMERIA === "true";

export const cenadiEnfermeriaSource: ScraperSource = {
  name: "cenadi-enfermeria" as ScrapeSource,
  enabled: cenadiEnfermeriaEnabled,
  async fetch() {
    return [];
  },
};

export async function runCenadiEnfermeria(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cenadiEnfermeriaEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("cenadi-enfermeria" as ScrapeSource, async () => {
    const rawLimit = Number(
      process.env.PROLIO_CENADI_ENFERMERIA_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
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
