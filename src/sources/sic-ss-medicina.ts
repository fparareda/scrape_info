import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * SIC-SS — Sistema de Información en Calidad (Secretaría de Salud).
 *
 * Sistema federal de registro de profesionales y establecimientos de
 * salud. Universo teórico: ~350k médicos con cédula federal vigente,
 * el gran lever para cobertura `medicina` en MX (junto con CLUES,
 * CONACEM, IMSS).
 *
 * ---------------------------------------------------------------------
 * BLOQUEO — no hay endpoint público con padrón descargable (2026-05-18)
 * ---------------------------------------------------------------------
 *
 * Probe 2026-05-18:
 *
 *   GET  https://www.gob.mx/salud/acciones-y-programas/sistema-de-
 *        informacion-en-calidad-sic                       → 200 (landing only)
 *   GET  https://siteproc.salud.gob.mx/                   → 302 → login
 *        (sistema interno SISCALIDAD para administradores estatales,
 *         no público).
 *   GET  https://www.datos.gob.mx/busca/dataset?q=cedula+profesional
 *                                                         → 200, sin
 *        dataset descargable con padrón de médicos (los resultados
 *        apuntan a CLUES y a metadatos de directorios institucionales).
 *
 * El registro nacional de cédulas profesionales (RNP-SEP) es la fuente
 * oficial de cédulas de médicos pero no expone un dump público —
 * únicamente el "Cédula Web" buscador uno-a-uno, sin endpoint REST
 * documentado y con CAPTCHA reCAPTCHA v2 (verificado 2026-05-18 en
 * `https://www.cedulaprofesional.sep.gob.mx/cedula/`).
 *
 * Cobertura efectiva por otras fuentes del repo:
 *   - `clues-sinais-mx` cubre 63k establecimientos médicos (no individuos).
 *   - `denue-mx` cubre 621111-621119 consultorios (~80k unidades).
 *   - `competitor-mx-doctoralia` cubre médicos privados publicados.
 *   - `conacem-mx` (stub) cubre especialistas certificados (también bloqueado).
 *
 * Reactivación cuando:
 *   a) la SEP publique dump de cédulas (improbable a corto plazo),
 *   b) un convenio Prolio ⇄ SEP/Salud abra acceso al API interno,
 *   c) un adaptador headless resuelva el flujo reCAPTCHA-v2 + paginado
 *      del Buscador SIC (sin tocar TOS del portal).
 *
 * Categoría: `medicina`.
 *
 * Off by default. `PROLIO_RUN_SIC_SS_MEDICINA=true`.
 * Cap con `PROLIO_SIC_SS_MEDICINA_LIMIT` (default 350000).
 */

const BASE_URL =
  process.env.PROLIO_SIC_SS_MEDICINA_URL ||
  "https://www.gob.mx/salud/acciones-y-programas/sistema-de-informacion-en-calidad-sic";
const DEFAULT_LIMIT = 350_000;
const CATEGORY: CategoryKey = "medicina";
void CATEGORY;
void BASE_URL;

async function fetchAll(_limit: number): Promise<ScrapedProfessional[]> {
  console.warn(
    `[sic-ss-medicina] BLOCKED — no hay endpoint público con padrón de ` +
      `médicos. SEP cédula web requiere reCAPTCHA-v2 uno-a-uno; SISCALIDAD ` +
      `es interno con login. Ver header del fichero para reactivación.`,
  );
  return [];
}

export const sicSsMedicinaEnabled = (): boolean =>
  process.env.PROLIO_RUN_SIC_SS_MEDICINA === "true";

export const sicSsMedicinaSource: ScraperSource = {
  name: "sic-ss-medicina" as ScrapeSource,
  enabled: sicSsMedicinaEnabled,
  async fetch() {
    return [];
  },
};

export async function runSicSsMedicina(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!sicSsMedicinaEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("sic-ss-medicina" as ScrapeSource, async () => {
    const rawLimit = Number(
      process.env.PROLIO_SIC_SS_MEDICINA_LIMIT ?? DEFAULT_LIMIT,
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
