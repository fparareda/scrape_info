import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv, pick } from "./_bulk-utils.js";

/**
 * SAT — Listado completo del Artículo 69-B del CFF (EFOS y EDOS).
 *
 * El SAT publica la lista de contribuyentes que han realizado
 * "operaciones presuntamente inexistentes" (EFOS) y aquellos
 * declarados definitivamente bajo el artículo 69-B del Código
 * Fiscal de la Federación. Una empresa puede aparecer en cualquiera
 * de cuatro situaciones:
 *   - Presunto         (publicación inicial, pendiente de respuesta)
 *   - Definitivo       (no desvirtuó la presunción → bandera roja firme)
 *   - Desvirtuado      (logró desvirtuar la presunción → "limpio")
 *   - Sentencia Favorable (tribunal le dio la razón → "limpio")
 *
 * ~12k empresas en total (incluye históricos definitivos desde 2014).
 * Útil como bandera fiscal al cruzar con `professionals` vía CIF/RFC.
 *
 * Fuentes (descubiertas 2026-05-13 vía probe directo al CDN del SAT;
 * el portal HTML hace un meta-refresh inservible y bloquea WebFetch).
 *
 *   Listado completo:   http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv
 *   Solo definitivos:   http://omawww.sat.gob.mx/cifras_sat/Documents/Definitivos.csv
 *   Solo presuntos:     http://omawww.sat.gob.mx/cifras_sat/Documents/Presuntos.csv
 *   Solo desvirtuados:  http://omawww.sat.gob.mx/cifras_sat/Documents/Desvirtuados.csv
 *
 * El CSV "Listado_Completo_69-B.csv" cubre los cuatro estados, así
 * que es suficiente con descargar ese único archivo (~4.5 MB en
 * Latin-1). Las columnas:
 *
 *   No, RFC, Nombre del Contribuyente, Situación del contribuyente,
 *   Número y fecha de oficio global de presunción SAT,
 *   Publicación página SAT presuntos, ... (20 cols en total)
 *
 * Categoría Prolio: `fiscal` (no es perfecta — los EFOS suelen ser
 * empresas fachada, no contadores — pero es la más cercana en la
 * taxonomía actual). `metadata.risk_flag` distingue 69-B-EFOS de
 * 69-B-EDOS cuando el SAT publique la lista bis (hoy solo EFOS).
 *
 * Off por defecto. `PROLIO_RUN_SAT_EFOS_EDOS=true` activa.
 * Cap con `PROLIO_SAT_EFOS_EDOS_LIMIT` (default 15000 = lista completa).
 */

const DEFAULT_URL =
  process.env.PROLIO_SAT_EFOS_EDOS_CSV ||
  "http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv";
const DEFAULT_LIMIT = 15_000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "fiscal";

// El SAT publica el CSV en Latin-1 (ISO-8859-1).
const LATIN1 = new TextDecoder("latin1");

interface SatRow {
  rfc: string;
  nombre: string;
  situacion: string;
  oficioPresuntoSat: string;
  fechaPresunto: string;
  oficioDefinitivoSat: string;
  fechaDefinitivo: string;
  oficioDesvirtuadoSat: string;
  fechaDesvirtuado: string;
  oficioSentenciaSat: string;
  fechaSentencia: string;
}

function normaliseSituacion(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v.startsWith("defin")) return "Definitivo";
  if (v.startsWith("presu")) return "Presunto";
  if (v.startsWith("desvir")) return "Desvirtuado";
  if (v.startsWith("senten")) return "Sentencia Favorable";
  return raw.trim() || "Desconocido";
}

/** Best-effort fecha de publicación según la situación. */
function pickFechaPublicacion(row: SatRow): string | undefined {
  switch (row.situacion) {
    case "Definitivo":
      return row.fechaDefinitivo || row.fechaPresunto || undefined;
    case "Presunto":
      return row.fechaPresunto || undefined;
    case "Desvirtuado":
      return row.fechaDesvirtuado || row.fechaPresunto || undefined;
    case "Sentencia Favorable":
      return row.fechaSentencia || row.fechaDefinitivo || undefined;
    default:
      return row.fechaPresunto || undefined;
  }
}

async function downloadCsv(url: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    console.error(`[sat-efos-edos] network error: ${(error as Error).message}`);
    return null;
  }
  if (!response.ok) {
    console.error(`[sat-efos-edos] ${response.status} on ${url}`);
    return null;
  }
  const ab = await response.arrayBuffer();
  return LATIN1.decode(Buffer.from(ab));
}

/**
 * El CSV del SAT tiene dos líneas de preámbulo + 1 línea en blanco
 * antes del encabezado. parseCsv() trabaja con `lines[0]` como
 * header, así que recortamos las líneas que no son la tabla.
 */
function stripPreamble(csv: string): string {
  const lines = csv.split(/\r?\n/);
  // El encabezado real empieza con "No," o "No.,"
  const headerIdx = lines.findIndex((l) => /^"?no\.?"?\s*,\s*"?rfc/i.test(l));
  if (headerIdx <= 0) return csv;
  return lines.slice(headerIdx).join("\n");
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const raw = await downloadCsv(DEFAULT_URL);
  if (!raw) return [];
  const csv = stripPreamble(raw);
  const rows = parseCsv(csv);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;

    const rfc = pick(row, ["rfc"]).trim().toUpperCase();
    if (!rfc || rfc.length < 9 || rfc.length > 13) continue;
    if (seen.has(rfc)) continue;
    seen.add(rfc);

    const nombre = pick(row, [
      "nombre_del_contribuyente",
      "nombre",
      "razon_social",
    ]).trim();
    if (!nombre) continue;

    const sat: SatRow = {
      rfc,
      nombre,
      situacion: normaliseSituacion(
        pick(row, ["situacion_del_contribuyente", "situacion"]),
      ),
      oficioPresuntoSat: pick(row, [
        "numero_y_fecha_de_oficio_global_de_presuncion_sat",
        "oficio_presuncion_sat",
      ]),
      fechaPresunto: pick(row, [
        "publicacion_pagina_sat_presuntos",
        "publicacion_dof_presuntos",
      ]),
      oficioDefinitivoSat: pick(row, [
        "numero_y_fecha_de_oficio_global_de_definitivos_sat",
      ]),
      fechaDefinitivo: pick(row, [
        "publicacion_pagina_sat_definitivos",
        "publicacion_dof_definitivos",
      ]),
      oficioDesvirtuadoSat: pick(row, [
        "numero_y_fecha_de_oficio_global_de_contribuyentes_que_desvirtuaron_sat",
      ]),
      fechaDesvirtuado: pick(row, [
        "publicacion_pagina_sat_desvirtuados",
        "publicacion_dof_desvirtuados",
      ]),
      oficioSentenciaSat: pick(row, [
        "numero_y_fecha_de_oficio_global_de_sentencia_favorable_sat",
      ]),
      fechaSentencia: pick(row, [
        "publicacion_pagina_sat_sentencia_favorable",
        "publicacion_dof_sentencia_favorable",
      ]),
    };

    // El SAT publica EFOS (emisores) en la lista 69-B; la lista bis
    // de EDOS (deductores) sigue siendo entregada solo bajo solicitud
    // de transparencia (no hay CSV público estable). Marcamos todos
    // como 69-B-EFOS hasta que aparezca un endpoint para la bis.
    const riskFlag = "69-B-EFOS";

    // No hay información de localización en el listado del SAT, así
    // que todos los registros van a "cdmx" como placeholder federal.
    // El consumidor cruzará por RFC/CIF, no por ciudad.
    const citySlug = "cdmx";

    out.push(
      normalise({
        source: "sat-efos-edos" as ScrapeSource,
        country: "MX",
        sourceId: `sat-efos:${rfc}`,
        name: sat.nombre,
        categoryKey: CATEGORY,
        citySlug,
        cif: rfc,
        metadata: {
          country: "MX",
          authority: "SAT",
          verified_by_authority: true,
          cif: rfc,
          rfc,
          risk_flag: riskFlag,
          situacion: sat.situacion,
          fecha_publicacion: pickFechaPublicacion(sat),
          oficio_presuncion_sat: sat.oficioPresuntoSat || undefined,
          oficio_definitivo_sat: sat.oficioDefinitivoSat || undefined,
          oficio_desvirtuado_sat: sat.oficioDesvirtuadoSat || undefined,
          oficio_sentencia_sat: sat.oficioSentenciaSat || undefined,
          fundamento: "Artículo 69-B del CFF",
          fuente_url: DEFAULT_URL,
        },
      }),
    );
  }
  console.log(
    `[sat-efos-edos] parsed=${out.length} of ${rows.length} csv rows`,
  );
  return out;
}

export const satEfosEdosEnabled = (): boolean =>
  process.env.PROLIO_RUN_SAT_EFOS_EDOS === "true";

export const satEfosEdosSource: ScraperSource = {
  name: "sat-efos-edos" as ScrapeSource,
  enabled: satEfosEdosEnabled,
  async fetch() {
    return [];
  },
};

export async function runSatEfosEdos(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!satEfosEdosEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("sat-efos-edos", async () => {
    const rawLimit = Number(
      process.env.PROLIO_SAT_EFOS_EDOS_LIMIT ?? DEFAULT_LIMIT,
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
