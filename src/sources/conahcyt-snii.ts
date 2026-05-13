import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv } from "./_bulk-utils.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * CONAHCYT — SNII (Sistema Nacional de Investigadores e
 * Investigadoras). Padrón abierto de ~40k investigadores con
 * institución, área, estado.
 *
 *   https://sisnai.conahcyt.mx/acceso-abierto/bases-de-datos-abiertos/
 *
 * Distribución: CSV/XLSX descargables. Configurable via
 * PROLIO_CONAHCYT_SNII_CSV.
 *
 * Mapeo de categoría: el padrón cubre todas las áreas científicas.
 * Sólo emitimos las filas en áreas mapeables a nuestras categorías:
 *   - área "Medicina y ciencias de la salud" → medicina
 *   - área "Psicología" / "Humanidades y ciencias de la conducta"
 *     subdisciplina psicología → psicologia
 * El resto se descarta.
 *
 * Off by default. `PROLIO_RUN_CONAHCYT_SNII=true`.
 * Cap with `PROLIO_CONAHCYT_SNII_LIMIT` (default 10000).
 */

/**
 * Real CSV URL discovered 2026-05-13 via datos.gob.mx CKAN search.
 * Dataset id: `sistema_nacional_investigadoras_investigadores_snii_s191`.
 * Two semesters are published each year; we default to the latest
 * (s2). Override with PROLIO_CONAHCYT_SNII_CSV.
 *
 * Note: the legacy sisnai.conahcyt.mx host no longer resolves
 * (CONAHCYT was renamed SECIHTI in 2025); the active distribution
 * lives at repodatos.atdt.gob.mx.
 */
const DEFAULT_URL =
  process.env.PROLIO_CONAHCYT_SNII_CSV ||
  "https://repodatos.atdt.gob.mx/api_update/secretaria_ciencia_tecnologia/sistema_nacional_investigadoras_investigadores_snii_s191/s191_snii_2s_2025.csv";
const DEFAULT_LIMIT = 10_000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";

function mapAreaToCategory(
  area: string | undefined,
  disciplina: string | undefined,
): CategoryKey | undefined {
  const join = `${area ?? ""} ${disciplina ?? ""}`.toLowerCase();
  if (!join.trim()) return undefined;
  if (join.includes("medicina") || join.includes("salud")) return "medicina";
  if (join.includes("psicolog")) return "psicologia";
  // "Humanidades y ciencias de la conducta" can include psicología
  if (join.includes("conducta")) return "psicologia";
  return undefined;
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
    console.error(`[conahcyt-snii] network error: ${(error as Error).message}`);
    return out;
  }
  if (!response.ok) {
    console.error(`[conahcyt-snii] ${response.status} on ${DEFAULT_URL}`);
    return out;
  }
  const text = await response.text();
  const rows = parseCsv(text);

  // Schema (2026-05-13 snapshot of s191_snii_2s_2025.csv):
  //   cvu, nombre, apellido1, apellido2, nivel, categoria,
  //   inicio_vigencia, fin_vigencia, area_conocimiento, disciplina,
  //   subdisciplina, especialidad, institucion_acreditacion_comision,
  //   dependencia_acreditacion_comision, entidad_acreditacion_comision,
  //   posdoc_iixm, rec_apoyo_recibido, apoyo_umas, comentario
  for (const row of rows) {
    if (out.length >= limit) break;
    const cvu =
      row["cvu"] || row["clave"] || row["id"] || row["folio"];
    const parts = [
      row["nombre"] || row["nombres"],
      row["apellido1"] || row["apellido_paterno"],
      row["apellido2"] || row["apellido_materno"],
    ]
      .filter(Boolean)
      .map((v) => String(v).trim());
    const nombre = (row["nombre_completo"] || parts.join(" ")).trim();
    if (!cvu || !nombre) continue;

    const area = row["area_conocimiento"] || row["area"];
    const disciplina = row["disciplina"] || row["subdisciplina"];
    const category = mapAreaToCategory(area, disciplina);
    if (!category) continue;

    const entidad =
      row["entidad_acreditacion_comision"] ||
      row["entidad"] ||
      row["estado"] ||
      row["entidad_federativa"] ||
      row["entidad_inst"];
    const citySlug = mxStateToCity(entidad) ?? "cdmx";

    out.push(
      normalise({
        source: "conahcyt-snii" as ScrapeSource,
        sourceId: `conahcyt-snii:${String(cvu).trim()}`,
        name: String(nombre).trim().replace(/\s+/g, " "),
        categoryKey: category,
        citySlug,
        licenseNumber: String(cvu).trim(),
        metadata: {
          country: "MX",
          authority: "SECIHTI",
          verified_by_authority: true,
          area,
          disciplina,
          institucion:
            row["institucion_acreditacion_comision"] || row["institucion"],
          nivel: row["nivel"] || row["nivel_snii"],
          categoria: row["categoria"],
          entidad,
        },
      }),
    );
  }
  console.log(
    `[conahcyt-snii] parsed=${out.length} of ${rows.length} csv rows`,
  );
  return out;
}

export const conahcytSniiEnabled = (): boolean =>
  process.env.PROLIO_RUN_CONAHCYT_SNII === "true";

export const conahcytSniiSource: ScraperSource = {
  name: "conahcyt-snii" as ScrapeSource,
  enabled: conahcytSniiEnabled,
  async fetch() {
    return [];
  },
};

export async function runConahcytSnii(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!conahcytSniiEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("conahcyt-snii", async () => {
    const rawLimit = Number(process.env.PROLIO_CONAHCYT_SNII_LIMIT ?? DEFAULT_LIMIT);
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
