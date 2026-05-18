import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * CECM-Dentistas — Consejo Nacional de Educación Continua para
 * Cirujanos Dentistas (CONAEDO) + registro federal de dentistas con
 * cédula vigente (SS-COFEPRIS / SEP RNP).
 *
 * Universo teórico: ~96,000 cirujanos dentistas con cédula vigente en MX.
 * Lever principal de cobertura `dentista`.
 *
 * ---------------------------------------------------------------------
 * BLOQUEO — el padrón de dentistas no es scrapable hoy (2026-05-18)
 * ---------------------------------------------------------------------
 *
 * Probe 2026-05-18:
 *
 *   GET  https://www.conaedo.com.mx/                       → 200 (CMS WP)
 *        Solo "Acerca de" + cursos. No directorio público de dentistas.
 *   GET  https://www.adm.org.mx/   (ADM - Asociación Dental Mexicana)
 *                                                          → 200 (Wix)
 *        Solo socios institucionales (colegios federados), sin lista.
 *   GET  https://www.cedulaprofesional.sep.gob.mx/cedula/  → 200 + reCAPTCHA
 *        Buscador uno-a-uno; mismo bloqueo descrito en `sic-ss-medicina.ts`.
 *   GET  https://www.cofepris.gob.mx/AS/Paginas/Avisos%20de%20Funcionamiento/
 *        Avisos-de-Funcionamiento.aspx                     → 200 (formulario)
 *        Los avisos de funcionamiento cubren consultorios dentales como
 *        ESTABLECIMIENTOS (no individuos) y se descargan vía solicitud
 *        INAI; no hay dump público.
 *
 * Federaciones estatales (FMCD/FUMOC/etc.) auditadas por muestra:
 *   - Federación Mexicana de Colegios de Odontólogos (FMCO):
 *     `fmco.org.mx` → solo junta directiva visible.
 *   - Colegio Nacional de Cirujanos Dentistas (CNCD):
 *     `cncd.org.mx` → padrón requiere login de socio.
 *   - Colegio Dental Mexicano (CDM, CDMX):
 *     `colegiodental.org` → directorio bloqueado por reCAPTCHA + Cloudflare.
 *
 * Cobertura efectiva por otras fuentes del repo:
 *   - `denue-mx` cubre 621211/621212 consultorios dentales (~28k unidades).
 *   - `competitor-mx-doctoralia` cubre dentistas con perfil público.
 *
 * Reactivación cuando:
 *   a) algún colegio estatal libere padrón JSON/CSV (improbable),
 *   b) convenio CONAEDO/ADM ⇄ Prolio,
 *   c) acceso INAI a base COFEPRIS con desglose por giro 8033 (consultorio
 *      dental) — vía solicitud formal de transparencia.
 *
 * Categoría: `dentista`.
 *
 * Off by default. `PROLIO_RUN_CECM_DENTISTAS=true`.
 * Cap con `PROLIO_CECM_DENTISTAS_LIMIT` (default 96000).
 */

const BASE_URL =
  process.env.PROLIO_CECM_DENTISTAS_URL || "https://www.conaedo.com.mx/";
const DEFAULT_LIMIT = 96_000;
const CATEGORY: CategoryKey = "dentista";
void CATEGORY;
void BASE_URL;

async function fetchAll(_limit: number): Promise<ScrapedProfessional[]> {
  console.warn(
    `[cecm-dentistas] BLOCKED — CONAEDO/ADM no publican padrón; colegios ` +
      `federados requieren login o Cloudflare/reCAPTCHA. SEP cédula es ` +
      `uno-a-uno. Ver header para reactivación.`,
  );
  return [];
}

export const cecmDentistasEnabled = (): boolean =>
  process.env.PROLIO_RUN_CECM_DENTISTAS === "true";

export const cecmDentistasSource: ScraperSource = {
  name: "cecm-dentistas" as ScrapeSource,
  enabled: cecmDentistasEnabled,
  async fetch() {
    return [];
  },
};

export async function runCecmDentistas(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cecmDentistasEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("cecm-dentistas" as ScrapeSource, async () => {
    const rawLimit = Number(
      process.env.PROLIO_CECM_DENTISTAS_LIMIT ?? DEFAULT_LIMIT,
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
