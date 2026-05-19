import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv, pick } from "./_bulk-utils.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * Padrón de Notarios del Patrimonio Inmobiliario Federal — INDAABIN.
 * Lista oficial de ~800 notarios autorizados para escriturar
 * inmuebles federales en México. Padrón distinto al de notarios
 * estatales (colegio-notarios-cdmx, notariado-mx).
 *
 * Dataset: https://datos.gob.mx/dataset/padron_notarios_patrimonio_inmobiliario_federal
 * Distribución: CSV anual hospedado en repodatos.atdt.gob.mx.
 * Override con `PROLIO_PADRON_NOTARIOS_FED_MX_CSV`.
 *
 * Categoría: `notario`.
 *
 * Off by default. `PROLIO_RUN_PADRON_NOTARIOS_FED_MX=true`.
 * Cap con `PROLIO_PADRON_NOTARIOS_FED_MX_LIMIT` (default 5000).
 *
 * Schema (probe 2026-05-14 sobre INDAABIN_2_padron_notarios_patrimonio_2024.csv):
 *   no_notpif, nombre, primer_apellido, segundo_apellido,
 *   correduria_o_notaria, clave_entidad, entidad, oficio_nombramiento,
 *   fecha_comenzo_ejercer, oficio_actualizacion, fecha_actualizacion,
 *   clave_municipio, municipio, localidad, tipo_vialidad, vialidad,
 *   numero_exterior, numero_interior, tipo_asentamiento, asentamiento,
 *   codigo_postal, status
 */

const DEFAULT_URL =
  process.env.PROLIO_PADRON_NOTARIOS_FED_MX_CSV ||
  "https://repodatos.atdt.gob.mx/api_update/indaabin/padron_notarios_patrimonio_inmobiliario_federal/INDAABIN_2_padron_notarios_patrimonio_2024.csv";
const DEFAULT_LIMIT = 5_000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";

function buildAddress(row: Record<string, string>): string | undefined {
  const parts = [
    pick(row, ["tipo_vialidad"]),
    pick(row, ["vialidad"]),
    pick(row, ["numero_exterior"]),
    pick(row, ["numero_interior"]),
    pick(row, ["tipo_asentamiento"]),
    pick(row, ["asentamiento"]),
    pick(row, ["municipio"]),
    pick(row, ["entidad"]),
    pick(row, ["codigo_postal"]),
  ]
    .map((v) => (v || "").trim())
    .filter((v) => v && v.toLowerCase() !== "sin dato" && v !== "0");
  return parts.length ? parts.join(", ") : undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  let response: Response;
  try {
    response = await fetch(DEFAULT_URL, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    console.error(
      `[padron-notarios-fed-mx] network error: ${(error as Error).message}`,
    );
    return out;
  }
  if (!response.ok) {
    console.error(
      `[padron-notarios-fed-mx] ${response.status} on ${DEFAULT_URL}`,
    );
    return out;
  }
  const text = await response.text();
  const rows = parseCsv(text);

  for (const row of rows) {
    if (out.length >= limit) break;
    const id = pick(row, ["no_notpif", "notpif", "id"]);
    const nombres = pick(row, ["nombre", "nombres"]);
    const ap1 = pick(row, ["primer_apellido", "apellido_paterno"]);
    const ap2 = pick(row, ["segundo_apellido", "apellido_materno"]);
    const fullName = [nombres, ap1, ap2]
      .filter((v) => v && v.toLowerCase() !== "sin dato")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!id || !fullName) continue;

    const entidad = pick(row, ["entidad"]);
    const citySlug = mxStateToCity(entidad) ?? "cdmx";

    const status = pick(row, ["status", "estatus"]);
    // Only emit notarios "en funciones" — historical/inactive rows
    // pollute matching. Adjust later if needed.
    if (status && !status.toLowerCase().includes("funciones")) continue;

    out.push(
      normalise({
        source: "padron-notarios-fed-mx" as ScrapeSource,
        country: "MX",
        sourceId: `padron-notarios-fed-mx:${id}`,
        name: fullName,
        categoryKey: "notario",
        citySlug,
        licenseNumber: id,
        address: buildAddress(row),
        metadata: {
          country: "MX",
          authority: "INDAABIN",
          verified_by_authority: true,
          correduria_o_notaria: pick(row, ["correduria_o_notaria"]),
          entidad,
          municipio: pick(row, ["municipio"]),
          oficio_nombramiento: pick(row, ["oficio_nombramiento"]),
          fecha_comenzo_ejercer: pick(row, ["fecha_comenzo_ejercer"]),
          codigo_postal: pick(row, ["codigo_postal"]),
          status,
        },
      }),
    );
  }
  console.log(
    `[padron-notarios-fed-mx] parsed=${out.length} of ${rows.length} csv rows`,
  );
  return out;
}

export const padronNotariosFedMxEnabled = (): boolean =>
  process.env.PROLIO_RUN_PADRON_NOTARIOS_FED_MX === "true";

export const padronNotariosFedMxSource: ScraperSource = {
  name: "padron-notarios-fed-mx" as ScrapeSource,
  enabled: padronNotariosFedMxEnabled,
  async fetch() {
    return [];
  },
};

export async function runPadronNotariosFedMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!padronNotariosFedMxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("padron-notarios-fed-mx" as ScrapeSource, async () => {
    const rawLimit = Number(
      process.env.PROLIO_PADRON_NOTARIOS_FED_MX_LIMIT ?? DEFAULT_LIMIT,
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
