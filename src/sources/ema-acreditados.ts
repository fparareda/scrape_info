import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * EMA — Entidad Mexicana de Acreditación, A.C.
 *
 *   https://www.ema.org.mx/portal_v3/
 *
 * EMA acredita laboratorios de ensayo y calibración, laboratorios
 * clínicos, organismos de certificación, organismos de inspección y
 * **unidades de verificación** (UV) usadas por las dependencias
 * federales (NOM, etiquetado, instalaciones eléctricas, gas LP,
 * eficiencia energética, metrología legal, etc.). El universo
 * estimado es ~3-5k entidades acreditadas activas a nivel nacional.
 *
 * ---------------------------------------------------------------------
 * BLOQUEO — el catálogo público actual no es scrapable masivamente
 * ---------------------------------------------------------------------
 *
 * Auditoría 2026-05-15:
 *
 *   GET  https://www.ema.org.mx/portal_v3/                    HTTP 200
 *   GET  https://ema.mx/saema/credencialesconsultapublica     HTTP 200
 *        → formulario "Consulta de credenciales emitidas por la ema"
 *          con un único campo `Número de credencial:` (lookup uno-a-uno).
 *          NO hay listado ni filtro por estado/tipo.
 *   GET  https://ema.mx/portal_v3/index.php/acreditados/      HTTP 404
 *   GET  https://ema.mx/portal_v3/index.php/directorios/      HTTP 404
 *   GET  /portal_v3/index.php/consulta-de-certificados-iaf    redirige al
 *          buscador genérico IAF (acreditaciones internacionales, no MX).
 *
 * La UI principal sí incluye un menú "Catálogo de Acreditados" pero
 * sus enlaces apuntan a `javascript:void(0);` y abren un buscador
 * autenticado contra SAEMA (`https://ema.mx/saema/UsuarioSession/Login`),
 * que NO ofrece listado público. La descarga histórica en formato
 * Excel que circulaba en años previos ya no se publica.
 *
 * Vías exploradas y descartadas:
 *   - `saema/credencialesconsultapublica` — sólo lookup por número.
 *   - `saema/AcreditadosController/*` — todos requieren sesión.
 *   - datos.gob.mx — no expone padrón EMA en RDF/CSV (audit 2026-05-15:
 *     query "ema acreditados" → 403 desde Cloudflare datacenter IPs).
 *   - PDFs en `portal_v3/wp-content/uploads/` — son boletines, no
 *     listados de acreditados.
 *
 * Esta fuente queda como STUB honesto, con la flag y el wiring listos
 * para reactivar sin tocar runner cuando: a) EMA libere el directorio,
 * b) consigamos credenciales SAEMA vía convenio, o c) un adaptador
 * Playwright resuelva el flujo autenticado.
 *
 * Categoría por tipo (cuando se active):
 *   - Unidad de Verificación              → "itv"
 *   - Laboratorio de ensayo / calibración → "mecanica"
 *   - Organismo de certificación / OI     → "ingenieria"
 *
 * Off by default. `PROLIO_RUN_EMA_ACREDITADOS=true`.
 * Cap con `PROLIO_EMA_ACREDITADOS_LIMIT` (default 5000).
 */

const BASE_URL =
  process.env.PROLIO_EMA_ACREDITADOS_URL ||
  "https://www.ema.org.mx/portal_v3/";
const DEFAULT_LIMIT = 5_000;
const CATEGORY_FALLBACK: CategoryKey = "itv";
void CATEGORY_FALLBACK;
void BASE_URL;

async function fetchAll(_limit: number): Promise<ScrapedProfessional[]> {
  console.warn(
    `[ema-acreditados] BLOCKED — EMA no publica un directorio bulk: el ` +
      `buscador público (saema/credencialesconsultapublica) sólo soporta ` +
      `lookup por número de credencial. Ver header del fichero. Salimos ` +
      `sin tocar la red.`,
  );
  return [];
}

export const emaAcreditadosEnabled = (): boolean =>
  process.env.PROLIO_RUN_EMA_ACREDITADOS === "true";

export const emaAcreditadosSource: ScraperSource = {
  name: "ema-acreditados" as ScrapeSource,
  enabled: emaAcreditadosEnabled,
  async fetch() {
    return [];
  },
};

export async function runEmaAcreditados(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!emaAcreditadosEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("ema-acreditados", async () => {
    const rawLimit = Number(
      process.env.PROLIO_EMA_ACREDITADOS_LIMIT ?? DEFAULT_LIMIT,
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
