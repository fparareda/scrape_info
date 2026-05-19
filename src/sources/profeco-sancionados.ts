import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv } from "./_bulk-utils.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * PROFECO — Procuraduría Federal del Consumidor.
 * Buró Comercial: registro público de empresas con reclamaciones /
 * sanciones procesadas por la autoridad. Cada fila es un expediente
 * (queja/sanción) abierto contra un proveedor.
 *
 *   Portal:  https://datos.profeco.gob.mx/datos_abiertos/buro.php
 *   CSV:     https://datos.profeco.gob.mx/datos_abiertos/file.php?t=9d4de5bbbc61b4eee42ca7bedece22b2
 *   Filename: buro_comercial_2019_2026.csv (~137 MB, ~hundreds of miles
 *             de expedientes; ~5–10k razones sociales únicas).
 *
 * Columnas (snapshot 2026-05-13):
 *   expediente, fecha_ingreso, anio_creacion, estado_procesal,
 *   razon_social, nombre_comercial, giro, sector, area_responsable,
 *   estado, motivo_reclamacion
 *
 * Cada `expediente` es único → se usa como sourceId. La misma razón
 * social puede aparecer varias veces (varias quejas) — el sink lo
 * mantiene como expedientes separados; el cruce con `professionals`
 * se hace por `razon_social`/`nombre_comercial` aguas abajo y se
 * marca con `metadata.risk_flag = "PROFECO_SANCION"`.
 *
 * Off by default. `PROLIO_RUN_PROFECO_SANCIONADOS=true`.
 * Cap con `PROLIO_PROFECO_SANCIONADOS_LIMIT` (default 10000).
 */

const DEFAULT_URL =
  process.env.PROLIO_PROFECO_SANCIONADOS_CSV ||
  "https://datos.profeco.gob.mx/datos_abiertos/file.php?t=9d4de5bbbc61b4eee42ca7bedece22b2";
const DEFAULT_LIMIT = 10_000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const DEFAULT_CATEGORY: CategoryKey = "fiscal";

/**
 * Map PROFECO `giro` / `sector` strings to our taxonomy. Conservative
 * — only map when the giro is unambiguously one of our categories.
 * Everything else falls back to `fiscal` (neutral).
 */
function mapGiro(giro: string | undefined, sector: string | undefined): CategoryKey {
  const haystack = `${giro ?? ""} ${sector ?? ""}`.toLowerCase();
  if (!haystack.trim()) return DEFAULT_CATEGORY;
  if (/(mec[áa]nic|taller|automotriz|autom[óo]vil|refaccion|llantera)/.test(haystack))
    return "mecanica";
  if (/(dentist|dental|odontol)/.test(haystack)) return "dentista";
  if (/(veterinari)/.test(haystack)) return "veterinario";
  if (/(notari)/.test(haystack)) return "notario";
  if (/(arquitect)/.test(haystack)) return "arquitecto";
  if (/(electric)/.test(haystack)) return "electricidad";
  if (/(plomer|fontaner|tuberi)/.test(haystack)) return "fontaneria";
  if (/(hvac|aire acondicionado|refrigeraci[óo]n|clima)/.test(haystack)) return "hvac";
  if (/(cerrajer)/.test(haystack)) return "cerrajero";
  if (/(carpinter|mueble)/.test(haystack)) return "carpinteria";
  if (/(fisiotera|rehabilitaci)/.test(haystack)) return "fisioterapia";
  if (/(psic[óo]log)/.test(haystack)) return "psicologia";
  if (/(m[ée]dic|hospital|cl[íi]nic|salud)/.test(haystack)) return "medicina";
  if (/(verificentro|verificaci[óo]n vehicular|itv)/.test(haystack)) return "itv";
  if (/(ingenier)/.test(haystack)) return "ingenieria";
  if (/(fiscal|contab|despacho contable)/.test(haystack)) return "fiscal";
  return DEFAULT_CATEGORY;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  let response: Response;
  try {
    response = await fetch(DEFAULT_URL, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    console.error(
      `[profeco-sancionados] network error: ${(error as Error).message}`,
    );
    return out;
  }
  if (!response.ok) {
    console.error(
      `[profeco-sancionados] ${response.status} on ${DEFAULT_URL}`,
    );
    return out;
  }
  const text = await response.text();
  const rows = parseCsv(text);

  for (const row of rows) {
    if (out.length >= limit) break;
    const expediente = (row["expediente"] || "").trim();
    const razonSocial = (row["razon_social"] || row["razón_social"] || "").trim();
    const nombreComercial = (row["nombre_comercial"] || "").trim();
    const name = nombreComercial || razonSocial;
    if (!expediente || !name) continue;

    const estado = row["estado"];
    const citySlug = mxStateToCity(estado) ?? "cdmx";
    const giro = row["giro"];
    const sector = row["sector"];
    const motivo = row["motivo_reclamacion"];
    const estadoProcesal = row["estado_procesal"];
    const fechaIngreso = row["fecha_ingreso"];
    const anio = row["anio_creacion"];
    const area = row["area_responsable"];

    out.push(
      normalise({
        source: "profeco-sancionados" as ScrapeSource,
        country: "MX",
        sourceId: `profeco:${expediente}`,
        name,
        categoryKey: mapGiro(giro, sector),
        citySlug,
        description: razonSocial && nombreComercial && razonSocial !== nombreComercial
          ? `${razonSocial} — ${motivo || ""}`.trim()
          : motivo || undefined,
        metadata: {
          country: "MX",
          authority: "PROFECO",
          risk_flag: "PROFECO_SANCION",
          expediente,
          razon_social: razonSocial || undefined,
          nombre_comercial: nombreComercial || undefined,
          giro: giro || undefined,
          sector: sector || undefined,
          area_responsable: area || undefined,
          sancion_tipo: estadoProcesal || undefined,
          motivo_reclamacion: motivo || undefined,
          fecha_sancion: fechaIngreso || undefined,
          anio_creacion: anio || undefined,
          estado,
        },
      }),
    );
  }
  console.log(
    `[profeco-sancionados] parsed=${out.length} of ${rows.length} csv rows`,
  );
  return out;
}

export const profecoSancionadosEnabled = (): boolean =>
  process.env.PROLIO_RUN_PROFECO_SANCIONADOS === "true";

export const profecoSancionadosSource: ScraperSource = {
  name: "profeco-sancionados" as ScrapeSource,
  enabled: profecoSancionadosEnabled,
  async fetch() {
    return [];
  },
};

export async function runProfecoSancionados(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!profecoSancionadosEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("profeco-sancionados", async () => {
    const rawLimit = Number(
      process.env.PROLIO_PROFECO_SANCIONADOS_LIMIT ?? DEFAULT_LIMIT,
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
