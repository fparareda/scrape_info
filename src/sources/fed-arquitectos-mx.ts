import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * Fed-Arquitectos-MX — Federación colegio-por-colegio FCARM bulk
 * expansion (sister source to `fcarm-arquitectos.ts`).
 *
 *   https://fcarm.org.mx/colegios/
 *
 * Universo teórico: ~30,000 arquitectos colegiados a nivel nacional
 * en los ~75 colegios estatales y regionales que componen FCARM.
 * Esta fuente complementa la cobertura de `fcarm-arquitectos.ts`
 * (~156 filas activas — Hermosillo + Reynosa son los únicos colegios
 * con padrón A-class según la auditoría 2026-05-13 de fcarm-arquitectos.ts).
 *
 * ---------------------------------------------------------------------
 * BLOQUEO — mismo patrón que `fcarm-arquitectos.ts` (2026-05-18)
 * ---------------------------------------------------------------------
 *
 * Auditoría 2026-05-18 — re-verificación de los ~73 colegios B/C/D/E
 * que `fcarm-arquitectos.ts` ya documenta como no scrapables:
 *
 *   - 4 grandes (CAM-SAM CDMX, CAEM Edomex, CAJ Jalisco, CANL Nuevo León):
 *     todos siguen en clase D/E (sitios en construcción o con WAF). Cero
 *     cambios respecto a la auditoría 2026-05-13.
 *   - 12 colegios con menú "Directorio" auditados: requieren login o
 *     devuelven anchor #. Ninguno expone padrón.
 *   - 8 colegios sin web oficial vigente.
 *
 * El verdadero camino de expansión NO es vía FCARM sino vía:
 *   a) DENUE-MX SCIAN 541310 (servicios de arquitectura) — ya cubierto
 *      por `denue-mx.ts`, suma ~12k establecimientos de arquitectura
 *      individual y firmas.
 *   b) DRO-CDMX y registros estatales de Directores Responsables de Obra
 *      — `dro-cdmx.ts` ya cubre el caso de la capital (~3k DROs).
 *      Equivalentes estatales pendientes (DRO-NL, DRO-Jalisco) — son
 *      el "low-hanging" real de la categoría `arquitecto`.
 *
 * Este stub queda como placeholder explícito: la federación FCARM en
 * sí misma no es scrapable a nivel padrón, y `fcarm-arquitectos.ts` ya
 * implementa los 2 colegios clase A (Hermosillo + Reynosa). Reactivar
 * únicamente si:
 *   - FCARM publica una base nacional consolidada (en planes según
 *     comunicación interna 2025 sin fecha firme), O
 *   - migramos la expansión a DRO estatales (en cuyo caso esta fuente
 *     queda obsoleta y se sustituye por `dro-mx-estados.ts`).
 *
 * Categoría: `arquitecto`.
 *
 * Off by default. `PROLIO_RUN_FED_ARQUITECTOS_MX=true`.
 * Cap con `PROLIO_FED_ARQUITECTOS_MX_LIMIT` (default 30000).
 */

const BASE_URL =
  process.env.PROLIO_FED_ARQUITECTOS_MX_URL ||
  "https://fcarm.org.mx/colegios/";
const DEFAULT_LIMIT = 30_000;
const CATEGORY: CategoryKey = "arquitecto";
void CATEGORY;
void BASE_URL;

async function fetchAll(_limit: number): Promise<ScrapedProfessional[]> {
  console.warn(
    `[fed-arquitectos-mx] BLOCKED — los ~73 colegios FCARM no scrapables ` +
      `por padrón siguen en mismo estado que la auditoría de ` +
      `fcarm-arquitectos.ts (2026-05-13). Path real: DRO estatales. ` +
      `Ver header del fichero.`,
  );
  return [];
}

export const fedArquitectosMxEnabled = (): boolean =>
  process.env.PROLIO_RUN_FED_ARQUITECTOS_MX === "true";

export const fedArquitectosMxSource: ScraperSource = {
  name: "fed-arquitectos-mx" as ScrapeSource,
  enabled: fedArquitectosMxEnabled,
  async fetch() {
    return [];
  },
};

export async function runFedArquitectosMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!fedArquitectosMxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("fed-arquitectos-mx" as ScrapeSource, async () => {
    const rawLimit = Number(
      process.env.PROLIO_FED_ARQUITECTOS_MX_LIMIT ?? DEFAULT_LIMIT,
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
