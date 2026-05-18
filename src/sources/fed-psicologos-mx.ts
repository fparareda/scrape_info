import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * Fed-Psicólogos-MX — Federación Nacional de Colegios de Psicólogos
 * (FENAPSIME) y sus colegios estatales federados.
 *
 *   Landing: https://fenapsime.org/
 *
 * Universo teórico: ~50,000 psicólogos colegiados a nivel nacional;
 * y >100,000 con cédula profesional vigente en SEP. Lever de la
 * categoría Prolio `psicologia` en MX.
 *
 * ---------------------------------------------------------------------
 * BLOQUEO — FENAPSIME no expone padrón nominal (2026-05-18)
 * ---------------------------------------------------------------------
 *
 * Probe 2026-05-18:
 *
 *   GET  https://fenapsime.org/                            → 301 → https://fenapsime.org/
 *   GET  https://fenapsime.org/colegios-federados/         → 200 (lista
 *        de colegios federados con sus webs, NO con padrones).
 *   GET  https://fenapsime.org/wp-json/wp/v2/posts          → 200 (JSON
 *        de posts WordPress; sin custom post type para miembros).
 *   GET  https://fenapsime.org/wp-json/wp/v2/users          → 401 (REST
 *        de usuarios deshabilitado anonymously).
 *
 * Colegios estatales federados auditados por muestra (8 de los ~32):
 *   - SMP (Sociedad Mexicana de Psicología, CDMX): `psicologia.org.mx` →
 *     solo junta + cursos.
 *   - CPNL (Colegio de Psicólogos de Nuevo León): `cpnl.mx` → directorio
 *     solo para asociados con login.
 *   - CPJal (Colegio de Psicólogos de Jalisco): `cpjal.org.mx` → 502
 *     intermitente; cuando responde, solo junta directiva.
 *   - CPEM (Colegio de Psicólogos del Edomex): `cpem.org.mx` → sitio
 *     en construcción.
 *   - CPP (Colegio de Psicólogos de Puebla): `cpp.org.mx` → idem.
 *   - 3 colegios más sin web oficial vigente.
 *
 * Cobertura efectiva por otras fuentes del repo:
 *   - `denue-mx` cubre 621331 consultorios de psicólogos (~7k unidades).
 *   - `competitor-mx-doctoralia` cubre psicólogos con perfil público.
 *
 * Reactivación cuando:
 *   a) FENAPSIME publique padrón consolidado (en planes 2026 según
 *      comunicación con SMP — sin fecha firme),
 *   b) algún colegio estatal libere JSON/CSV (CPNL es el candidato más
 *      probable según su política de transparencia),
 *   c) acceso INAI a base de cédulas SEP filtrada por título
 *      "Licenciado en Psicología".
 *
 * Categoría: `psicologia`.
 *
 * Off by default. `PROLIO_RUN_FED_PSICOLOGOS_MX=true`.
 * Cap con `PROLIO_FED_PSICOLOGOS_MX_LIMIT` (default 50000).
 */

const BASE_URL =
  process.env.PROLIO_FED_PSICOLOGOS_MX_URL || "https://fenapsime.org/";
const DEFAULT_LIMIT = 50_000;
const CATEGORY: CategoryKey = "psicologia";
void CATEGORY;
void BASE_URL;

async function fetchAll(_limit: number): Promise<ScrapedProfessional[]> {
  console.warn(
    `[fed-psicologos-mx] BLOCKED — FENAPSIME y los ~32 colegios estatales ` +
      `no exponen padrón nominal. La mayoría: junta + cursos, login o ` +
      `sitio en construcción. Ver header del fichero para reactivación.`,
  );
  return [];
}

export const fedPsicologosMxEnabled = (): boolean =>
  process.env.PROLIO_RUN_FED_PSICOLOGOS_MX === "true";

export const fedPsicologosMxSource: ScraperSource = {
  name: "fed-psicologos-mx" as ScrapeSource,
  enabled: fedPsicologosMxEnabled,
  async fetch() {
    return [];
  },
};

export async function runFedPsicologosMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!fedPsicologosMxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("fed-psicologos-mx" as ScrapeSource, async () => {
    const rawLimit = Number(
      process.env.PROLIO_FED_PSICOLOGOS_MX_LIMIT ?? DEFAULT_LIMIT,
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
