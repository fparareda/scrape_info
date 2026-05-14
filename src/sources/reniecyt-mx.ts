import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv, pick } from "./_bulk-utils.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * RENIECYT — Registro Nacional de Instituciones y Empresas
 * Científicas y Tecnológicas (CONAHCYT / SECIHTI). Padrón de
 * ~30k empresas, universidades, centros de investigación,
 * dependencias públicas y personas físicas inscritas en C&T.
 *
 * Dataset: https://www.datos.gob.mx/dataset/registro_instituciones_empresas_ciencia_tecnologia_reniecyt_vigentes
 * Distribución: CSV anual. Snapshot 2023 (último vigente al
 * 2026-05-14): `10-reniecyt-2023.csv`. Override con
 * `PROLIO_RENIECYT_MX_CSV`.
 *
 * Categoría: `ingenieria` como proxy — la mayoría son empresas y
 * centros C&T, sin desglose fino mapeable. Categoría correcta para
 * la query "empresa con I+D registrada". Filtros futuros por
 * `clase_scian_ocde` pueden afinar más adelante.
 *
 * Off by default. `PROLIO_RUN_RENIECYT_MX=true`.
 * Cap con `PROLIO_RENIECYT_MX_LIMIT` (default 10000).
 *
 * Schema (probe 2026-05-14 sobre 10-reniecyt-2023.csv):
 *   registro, nombre, sector_economico, clase_scian_ocde,
 *   fecha_de_registro, estatus, entidad_federativa,
 *   tipo_de_institucion, fn_registro
 */

const DEFAULT_URL =
  process.env.PROLIO_RENIECYT_MX_CSV ||
  "https://www.datos.gob.mx/dataset/de4a5203-f686-4541-93a4-4e9d2af5b0d2/resource/3327ef7b-95fa-42fe-bfae-e7ed613682d8/download/10-reniecyt-2023.csv";
const DEFAULT_LIMIT = 10_000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  let response: Response;
  try {
    response = await fetch(DEFAULT_URL, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(600_000),
    });
  } catch (error) {
    console.error(`[reniecyt-mx] network error: ${(error as Error).message}`);
    return out;
  }
  if (!response.ok) {
    console.error(`[reniecyt-mx] ${response.status} on ${DEFAULT_URL}`);
    return out;
  }
  const text = await response.text();
  const rows = parseCsv(text);

  let skippedNoId = 0;
  for (const row of rows) {
    if (out.length >= limit) break;
    const registro = pick(row, ["registro", "fn_registro", "clave"]);
    const nombre = pick(row, ["nombre", "razon_social", "nombre_institucion"]);
    if (!nombre) continue;
    // Many rows carry "Sin datos" in the registro column. Use the row
    // hash via fn_registro fallback then fall back to a synthetic id
    // anchored on nombre+fecha so we still emit them deduped.
    const fechaRegistro = pick(row, ["fecha_de_registro", "fecha_registro"]);
    let sourceId = registro && registro !== "Sin datos" ? registro : "";
    if (!sourceId) {
      sourceId = `${nombre}|${fechaRegistro}`.replace(/\s+/g, "_").slice(0, 120);
      skippedNoId += 1;
    }

    const entidad = pick(row, ["entidad_federativa", "entidad", "estado"]);
    const citySlug = mxStateToCity(entidad) ?? "cdmx";

    out.push(
      normalise({
        source: "reniecyt-mx" as ScrapeSource,
        sourceId: `reniecyt-mx:${sourceId}`,
        name: nombre.replace(/\s+/g, " ").trim(),
        categoryKey: "ingenieria",
        citySlug,
        licenseNumber: registro && registro !== "Sin datos" ? registro : undefined,
        metadata: {
          country: "MX",
          authority: "SECIHTI/CONAHCYT",
          verified_by_authority: true,
          sector_economico: pick(row, ["sector_economico"]),
          clase_scian_ocde: pick(row, ["clase_scian_ocde"]),
          fecha_de_registro: fechaRegistro,
          estatus: pick(row, ["estatus"]),
          tipo_de_institucion: pick(row, ["tipo_de_institucion"]),
          entidad,
        },
      }),
    );
  }
  console.log(
    `[reniecyt-mx] parsed=${out.length} of ${rows.length} csv rows (synthetic_id_used=${skippedNoId})`,
  );
  return out;
}

export const reniecytMxEnabled = (): boolean =>
  process.env.PROLIO_RUN_RENIECYT_MX === "true";

export const reniecytMxSource: ScraperSource = {
  name: "reniecyt-mx" as ScrapeSource,
  enabled: reniecytMxEnabled,
  async fetch() {
    return [];
  },
};

export async function runReniecytMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!reniecytMxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("reniecyt-mx" as ScrapeSource, async () => {
    const rawLimit = Number(process.env.PROLIO_RENIECYT_MX_LIMIT ?? DEFAULT_LIMIT);
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
