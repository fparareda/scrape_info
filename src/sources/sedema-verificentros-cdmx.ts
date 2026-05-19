import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv } from "./_bulk-utils.js";

/**
 * SEDEMA CDMX — Verificentros (centros de verificación vehicular).
 *
 *   http://www.data.sedema.cdmx.gob.mx/programa-de-verificacion-vehicular-bases-de-datos/
 *
 * ~70 verificentros oficiales con dirección, número, contacto.
 *
 * **Estado actual (verificado 2026-05)**: SEDEMA NO publica ya un CSV
 * estructurado del padrón de verificentros vigente. El portal
 * `data.sedema.cdmx.gob.mx` solo expone los archivos `.txt.gz` de
 * **transacciones de verificación** mensuales (PVVO_MM_YYYY.txt.gz)
 * que son logs de verificaciones, no un directorio. La búsqueda en
 * datos.cdmx.gob.mx (CKAN) tampoco devuelve un dataset de verificentros
 * vigente (solo datasets de verificación automotriz de 2018).
 *
 * Mientras no haya CSV oficial, el source solo opera si el operador
 * provee una URL vía PROLIO_SEDEMA_VERIFICENTROS_CSV. Sin esa env-var,
 * sale temprano con un warning honesto (sin error).
 *
 * Off by default. `PROLIO_RUN_SEDEMA_VERIFICENTROS_CDMX=true`.
 * Cap with `PROLIO_SEDEMA_VERIFICENTROS_CDMX_LIMIT` (default 200).
 */

const DEFAULT_URL = process.env.PROLIO_SEDEMA_VERIFICENTROS_CSV || "";
const DEFAULT_LIMIT = 200;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "itv";

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  if (!DEFAULT_URL) {
    console.warn(
      "[sedema-verificentros-cdmx] PROLIO_SEDEMA_VERIFICENTROS_CSV not set — SEDEMA no publica CSV vigente; skipping",
    );
    return out;
  }
  let response: Response;
  try {
    response = await fetch(DEFAULT_URL, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[sedema-verificentros-cdmx] network error: ${(error as Error).message}`);
    return out;
  }
  if (!response.ok) {
    console.error(`[sedema-verificentros-cdmx] ${response.status} on ${DEFAULT_URL}`);
    return out;
  }
  const text = await response.text();
  const rows = parseCsv(text);

  for (const row of rows) {
    if (out.length >= limit) break;
    const num =
      row["numero_verificentro"] ||
      row["numero"] ||
      row["clave"] ||
      row["id"];
    const nombre =
      row["nombre"] ||
      row["razon_social"] ||
      row["denominacion"] ||
      `Verificentro ${num ?? ""}`;
    if (!num || !nombre) continue;
    const address = [row["domicilio"], row["calle"], row["colonia"], row["alcaldia"]]
      .filter(Boolean)
      .join(", ");
    out.push(
      normalise({
        source: "sedema-verificentros-cdmx" as ScrapeSource,
        country: "MX",
        sourceId: `sedema-cdmx:${String(num).trim()}`,
        name: String(nombre).trim(),
        categoryKey: CATEGORY,
        citySlug: "cdmx",
        address: address || undefined,
        phone: row["telefono"] || row["tel"] || undefined,
        licenseNumber: String(num).trim(),
        metadata: {
          country: "MX",
          authority: "SEDEMA-CDMX",
          verified_by_authority: true,
          alcaldia: row["alcaldia"],
          tipo: row["tipo_servicio"] || row["tipo"],
        },
      }),
    );
  }
  console.log(`[sedema-verificentros-cdmx] parsed=${out.length}`);
  return out;
}

export const sedemaVerificentrosCdmxEnabled = (): boolean =>
  process.env.PROLIO_RUN_SEDEMA_VERIFICENTROS_CDMX === "true";

export const sedemaVerificentrosCdmxSource: ScraperSource = {
  name: "sedema-verificentros-cdmx" as ScrapeSource,
  enabled: sedemaVerificentrosCdmxEnabled,
  async fetch() {
    return [];
  },
};

export async function runSedemaVerificentrosCdmx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!sedemaVerificentrosCdmxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("sedema-verificentros-cdmx", async () => {
    const rawLimit = Number(
      process.env.PROLIO_SEDEMA_VERIFICENTROS_CDMX_LIMIT ?? DEFAULT_LIMIT,
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
