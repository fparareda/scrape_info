import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv } from "./_bulk-utils.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * CNSF — Comisión Nacional de Seguros y Fianzas.
 * Registro de agentes intermediarios (seguros + fianzas).
 *
 *   https://www.datos.gob.mx/dataset/agentes_intermediarios  (bulk CSV)
 *   Fallback web: https://agentesajustadores.cnsf.gob.mx/
 *
 * ~50k agentes vigentes. CSV columnas (típico):
 *   clave,nombre,rfc,tipo,entidad,vigencia_fin
 *
 * Mapeo de categoría: "fiscal" (es la más afín en nuestra taxonomía
 * actual — no existe `seguros`).
 *
 * Off by default. `PROLIO_RUN_CNSF_AGENTES=true`.
 * Cap with `PROLIO_CNSF_AGENTES_LIMIT` (default 10000).
 */

const DEFAULT_URL =
  process.env.PROLIO_CNSF_AGENTES_CSV ||
  "https://www.datos.gob.mx/dataset/agentes_intermediarios/resource/latest.csv";
const DEFAULT_LIMIT = 10_000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "fiscal";

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  let response: Response;
  try {
    response = await fetch(DEFAULT_URL, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    console.error(`[cnsf-agentes] network error: ${(error as Error).message}`);
    return out;
  }
  if (!response.ok) {
    console.error(`[cnsf-agentes] ${response.status} on ${DEFAULT_URL}`);
    return out;
  }
  const text = await response.text();
  const rows = parseCsv(text);
  const today = new Date();

  for (const row of rows) {
    if (out.length >= limit) break;
    const clave = row["clave"] || row["folio"] || row["cedula"];
    const nombre = row["nombre"] || row["nombre_completo"] || row["razon_social"];
    if (!clave || !nombre) continue;

    // Drop expired
    const fin = row["vigencia_fin"] || row["vigencia"];
    if (fin) {
      const d = new Date(fin);
      if (Number.isFinite(d.getTime()) && d < today) continue;
    }

    const entidad = row["entidad"] || row["estado"] || row["entidad_federativa"];
    const citySlug = mxStateToCity(entidad) ?? "cdmx";

    out.push(
      normalise({
        source: "cnsf-agentes" as ScrapeSource,
        sourceId: `cnsf-agentes:${String(clave).trim()}`,
        name: String(nombre).trim(),
        categoryKey: CATEGORY,
        citySlug,
        licenseNumber: String(clave).trim(),
        cif: row["rfc"] || undefined,
        phone: row["telefono"] || undefined,
        email: row["correo"] || row["email"] || undefined,
        metadata: {
          country: "MX",
          authority: "CNSF",
          verified_by_authority: true,
          tipo: row["tipo"],
          entidad,
          vigencia_fin: fin,
        },
      }),
    );
  }
  console.log(`[cnsf-agentes] parsed=${out.length}`);
  return out;
}

export const cnsfAgentesEnabled = (): boolean =>
  process.env.PROLIO_RUN_CNSF_AGENTES === "true";

export const cnsfAgentesSource: ScraperSource = {
  name: "cnsf-agentes" as ScrapeSource,
  enabled: cnsfAgentesEnabled,
  async fetch() {
    return [];
  },
};

export async function runCnsfAgentes(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cnsfAgentesEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("cnsf-agentes", async () => {
    const rawLimit = Number(process.env.PROLIO_CNSF_AGENTES_LIMIT ?? DEFAULT_LIMIT);
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
