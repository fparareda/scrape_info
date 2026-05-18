import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * Padrón Abogados MX — Federación de padrones estatales de abogados
 * litigantes inscritos en Tribunales Superiores de Justicia (TSJ).
 *
 * Universo teórico: ~200,000-300,000 abogados con cédula vigente y
 * registro de firma para promover en juicios. Lever principal de la
 * nueva categoría Prolio `abogado`. A diferencia de España (un único
 * CGAE federado por colegios provinciales), México NO tiene colegio
 * profesional obligatorio: cada TSJ estatal lleva su propio "Padrón
 * de Abogados Postulantes" como requisito procesal.
 *
 * ---------------------------------------------------------------------
 * BLOQUEO — los padrones por estado NO son scrapables hoy (2026-05-18)
 * ---------------------------------------------------------------------
 *
 * Probe 2026-05-18 sobre los 4 estados con mayor masa de litigantes
 * (CDMX, Edomex, Jalisco, Nuevo León):
 *
 *   GET  https://www.poderjudicialcdmx.gob.mx/             → HTTP 403
 *        (WAF AzureFront bloquea IPs datacenter; cookies + UA Chrome no
 *         desbloquean).
 *   GET  https://www.pjedomex.gob.mx/                       → 200 (landing)
 *        El padrón se consulta por "registro de cédula" en formulario
 *        uno-a-uno bajo /admin/padron, sin listado público.
 *   GET  https://stj.jalisco.gob.mx/                        → 200 (landing)
 *        Idem — solo formulario de búsqueda por cédula individual.
 *   GET  https://www.pjenl.gob.mx/                          → 200 (landing)
 *        Idem — sin dump público; padrón administrativo interno.
 *
 * Estados que sí publican listados parciales (auditados por muestra):
 *   - SCJN — "Abogados postulantes ante la SCJN": <2,000 entradas,
 *     PDF actualizado anualmente. Útil pero marginal.
 *   - PJF — "Padrón de Abogados Postulantes ante el Poder Judicial de
 *     la Federación": ~25,000 entradas, formulario AJAX con paginado
 *     server-side y firma JWT rotativa por sesión (verificado 2026-05-18,
 *     mismo patrón que CONACEM/IMSS).
 *
 * Cobertura efectiva por otras fuentes del repo:
 *   - `denue-mx` cubre 541110 bufetes jurídicos y 541190 otros servicios
 *     legales como ESTABLECIMIENTOS (~30k razones sociales).
 *
 * Reactivación cuando:
 *   a) algún TSJ libere padrón JSON/CSV (Querétaro ha mencionado abrirlo
 *      en su plan de transparencia 2026, sin fecha firme),
 *   b) acceso INAI a base de cédulas SEP para abogados (probable vía
 *      solicitud federal de transparencia con anonimización parcial),
 *   c) un adaptador headless con anti-WAF para CDMX/Edomex/JAL/NL —
 *      respetando TOS de cada TSJ.
 *
 * Categoría: `abogado`.
 *
 * Off by default. `PROLIO_RUN_PADRON_ABOGADOS_MX=true`.
 * Cap con `PROLIO_PADRON_ABOGADOS_MX_LIMIT` (default 250000).
 */

const BASE_URL =
  process.env.PROLIO_PADRON_ABOGADOS_MX_URL || "https://www.scjn.gob.mx/";
const DEFAULT_LIMIT = 250_000;
const CATEGORY: CategoryKey = "abogado";
void CATEGORY;
void BASE_URL;

/**
 * Referencia: los 32 TSJ estatales + 1 SCJN federal + 1 PJF. Se mantiene
 * inline para que la reactivación pueda iterar directamente. No se
 * golpea hoy en runtime.
 */
const TSJ_REGISTRY_REF: ReadonlyArray<{ estado: string; url: string }> = [
  { estado: "Aguascalientes", url: "https://www.poderjudicialags.gob.mx/" },
  { estado: "Baja California", url: "https://www.pjbc.gob.mx/" },
  { estado: "Baja California Sur", url: "https://www.tribunalbcs.gob.mx/" },
  { estado: "Campeche", url: "https://www.poderjudicialcampeche.gob.mx/" },
  { estado: "CDMX", url: "https://www.poderjudicialcdmx.gob.mx/" },
  { estado: "Chiapas", url: "https://www.poderjudicialchiapas.gob.mx/" },
  { estado: "Chihuahua", url: "https://www.stj.gob.mx/" },
  { estado: "Coahuila", url: "https://www.pjecz.gob.mx/" },
  { estado: "Colima", url: "https://www.stjcolima.gob.mx/" },
  { estado: "Durango", url: "https://tsjdgo.gob.mx/" },
  { estado: "Estado de México", url: "https://www.pjedomex.gob.mx/" },
  { estado: "Guanajuato", url: "https://www.poderjudicial-gto.gob.mx/" },
  { estado: "Guerrero", url: "https://www.tsj-guerrero.gob.mx/" },
  { estado: "Hidalgo", url: "https://www.pjhidalgo.gob.mx/" },
  { estado: "Jalisco", url: "https://stj.jalisco.gob.mx/" },
  { estado: "Michoacán", url: "https://www.poderjudicialmichoacan.gob.mx/" },
  { estado: "Morelos", url: "https://www.tsjmorelos.gob.mx/" },
  { estado: "Nayarit", url: "https://www.tsjnay.gob.mx/" },
  { estado: "Nuevo León", url: "https://www.pjenl.gob.mx/" },
  { estado: "Oaxaca", url: "https://www.tribunaloaxaca.gob.mx/" },
  { estado: "Puebla", url: "https://www.htsjpuebla.gob.mx/" },
  { estado: "Querétaro", url: "https://www.tribunalqro.gob.mx/" },
  { estado: "Quintana Roo", url: "https://www.tsjqroo.gob.mx/" },
  { estado: "San Luis Potosí", url: "https://www.stjslp.gob.mx/" },
  { estado: "Sinaloa", url: "https://www.stj-sin.gob.mx/" },
  { estado: "Sonora", url: "https://www.stjsonora.gob.mx/" },
  { estado: "Tabasco", url: "https://www.tsj-tabasco.gob.mx/" },
  { estado: "Tamaulipas", url: "https://www.pjetam.gob.mx/" },
  { estado: "Tlaxcala", url: "https://www.tsjtlaxcala.gob.mx/" },
  { estado: "Veracruz", url: "https://www.pjeveracruz.gob.mx/" },
  { estado: "Yucatán", url: "https://www.tsjyuc.gob.mx/" },
  { estado: "Zacatecas", url: "https://www.tsjzac.gob.mx/" },
  { estado: "PJF (federal)", url: "https://www.cjf.gob.mx/" },
  { estado: "SCJN (federal)", url: "https://www.scjn.gob.mx/" },
];
void TSJ_REGISTRY_REF;

async function fetchAll(_limit: number): Promise<ScrapedProfessional[]> {
  console.warn(
    `[padron-abogados-mx] BLOCKED — 32 TSJ estatales + PJF + SCJN sin ` +
      `padrón JSON/CSV público. CDMX bloquea por WAF; Edomex/JAL/NL ` +
      `solo formulario uno-a-uno. Ver header para reactivación.`,
  );
  return [];
}

export const padronAbogadosMxEnabled = (): boolean =>
  process.env.PROLIO_RUN_PADRON_ABOGADOS_MX === "true";

export const padronAbogadosMxSource: ScraperSource = {
  name: "padron-abogados-mx" as ScrapeSource,
  enabled: padronAbogadosMxEnabled,
  async fetch() {
    return [];
  },
};

export async function runPadronAbogadosMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!padronAbogadosMxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("padron-abogados-mx" as ScrapeSource, async () => {
    const rawLimit = Number(
      process.env.PROLIO_PADRON_ABOGADOS_MX_LIMIT ?? DEFAULT_LIMIT,
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
