import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * COFEPRIS-Farmacéuticos — Responsables Sanitarios y Profesionales
 * Farmacéuticos (individuos), Comisión Federal para la Protección
 * contra Riesgos Sanitarios.
 *
 * Universo teórico: ~80,000 químicos farmacéuticos biólogos (QFB) +
 * químicos farmacéuticos industriales (QFI) + técnicos farmacéuticos
 * con responsabilidad sanitaria registrada ante COFEPRIS. Lever de
 * la nueva categoría Prolio `farmacia` (individuos, no establecimientos
 * — ésos los cubre `cofepris-farmacias.ts`).
 *
 * ---------------------------------------------------------------------
 * BLOQUEO — el padrón de responsables sanitarios no es público (2026-05-18)
 * ---------------------------------------------------------------------
 *
 * Probe 2026-05-18:
 *
 *   GET  https://www.gob.mx/cofepris                       → 200 (landing)
 *   GET  https://www.gob.mx/cofepris/articulos/responsables-sanitarios
 *                                                          → 200 (criterios
 *        de registro, sin padrón). Cada responsable sanitario aparece
 *        en el aviso de funcionamiento de la farmacia/laboratorio que
 *        representa — pero NO en una lista nominal independiente.
 *   GET  https://www.cofepris.gob.mx/AS/Paginas/Avisos%20de%20Funcionamiento/
 *        Avisos-de-Funcionamiento.aspx                     → 200 (formulario)
 *        Solo permite consulta uno-a-uno por número de aviso.
 *   GET  https://www.datos.gob.mx/busca/dataset?q=cofepris+farmaceuticos
 *                                                          → 200, sin
 *        dataset descargable con padrón individual.
 *
 * Asociaciones gremiales auditadas por muestra:
 *   - CNQFB (Colegio Nacional de Químicos Farmacéuticos Biólogos):
 *     `cnqfbm.org` → solo junta + revista; sin directorio.
 *   - AMQF (Asociación Mexicana de Químicos Farmacéuticos):
 *     `amqf.com.mx` → idem.
 *
 * Establecimientos farmacéuticos: cubiertos en detalle por
 * `cofepris-farmacias.ts` (PDFs por estado, ~45k licencias). Cada
 * licencia carga el nombre del responsable sanitario en el campo
 * "Razón Social del Establecimiento", no del individuo en sí.
 *
 * Reactivación cuando:
 *   a) COFEPRIS publique padrón de responsables sanitarios (improbable
 *      a corto plazo por confidencialidad de datos personales),
 *   b) acceso INAI a base de RS con consentimiento explícito,
 *   c) CNQFB libere directorio (improbable).
 *
 * Categoría: `farmacia`.
 *
 * Off by default. `PROLIO_RUN_COFEPRIS_FARMACEUTICOS=true`.
 * Cap con `PROLIO_COFEPRIS_FARMACEUTICOS_LIMIT` (default 80000).
 */

const BASE_URL =
  process.env.PROLIO_COFEPRIS_FARMACEUTICOS_URL ||
  "https://www.gob.mx/cofepris/articulos/responsables-sanitarios";
const DEFAULT_LIMIT = 80_000;
const CATEGORY: CategoryKey = "farmacia";
void CATEGORY;
void BASE_URL;

async function fetchAll(_limit: number): Promise<ScrapedProfessional[]> {
  console.warn(
    `[cofepris-farmaceuticos] BLOCKED — COFEPRIS no publica padrón de ` +
      `responsables sanitarios individuales; colegios CNQFB/AMQF tampoco. ` +
      `Ver header del fichero para reactivación.`,
  );
  return [];
}

export const cofeprisFarmaceuticosEnabled = (): boolean =>
  process.env.PROLIO_RUN_COFEPRIS_FARMACEUTICOS === "true";

export const cofeprisFarmaceuticosSource: ScraperSource = {
  name: "cofepris-farmaceuticos" as ScrapeSource,
  enabled: cofeprisFarmaceuticosEnabled,
  async fetch() {
    return [];
  },
};

export async function runCofeprisFarmaceuticos(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cofeprisFarmaceuticosEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("cofepris-farmaceuticos" as ScrapeSource, async () => {
    const rawLimit = Number(
      process.env.PROLIO_COFEPRIS_FARMACEUTICOS_LIMIT ?? DEFAULT_LIMIT,
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
