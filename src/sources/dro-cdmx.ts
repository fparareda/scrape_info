import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv } from "./_bulk-utils.js";

/**
 * DRO CDMX — Directores Responsables de Obra y Corresponsables.
 *
 *   https://datos.cdmx.gob.mx/dataset/padron-de-directores-responsables-de-obra-y-corresponsables
 *
 * ~700 DROs registrados ante SEDUVI/INVI con teléfono, email y domicilio.
 * DROs son arquitectos/ingenieros responsables de proyecto u obra; los
 * mapeamos a `arquitecto` como proxy (la categoría más cercana al rol).
 *
 * **Estado actual (verificado 2026-05-14)**: el portal CKAN
 * `datos.cdmx.gob.mx` está intermitente desde redes fuera de México
 * (conexión TCP cae antes del handshake). Cuando responde, el endpoint
 * canónico es:
 *
 *   GET /api/3/action/package_show?id=padron-de-directores-responsables-de-obra-y-corresponsables
 *
 * que devuelve `result.resources[]` con un CSV/JSON descargable. Por
 * resiliencia, este source acepta `PROLIO_DRO_CDMX_CSV` como override
 * directo a la URL del recurso CSV. Si no se setea, intenta el CKAN
 * package_show y elige el primer recurso CSV.
 *
 * Off by default. `PROLIO_RUN_DRO_CDMX=true`.
 * Cap con `PROLIO_DRO_CDMX_LIMIT` (default 800).
 */

const CKAN_PACKAGE_URL =
  "https://datos.cdmx.gob.mx/api/3/action/package_show?id=padron-de-directores-responsables-de-obra-y-corresponsables";
const CSV_OVERRIDE = process.env.PROLIO_DRO_CDMX_CSV || "";
const DEFAULT_LIMIT = 800;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "arquitecto";

interface CkanResource {
  url?: string;
  format?: string;
  name?: string;
  mimetype?: string;
}
interface CkanPackageResponse {
  success?: boolean;
  result?: {
    resources?: CkanResource[];
  };
}

async function resolveCsvUrl(): Promise<string | null> {
  if (CSV_OVERRIDE) return CSV_OVERRIDE;
  try {
    const r = await fetch(CKAN_PACKAGE_URL, {
      headers: { "User-Agent": POLITE_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) {
      console.error(`[dro-cdmx] CKAN package_show ${r.status}`);
      return null;
    }
    const json = (await r.json()) as CkanPackageResponse;
    const resources = json.result?.resources ?? [];
    // Prefer CSV, fall back to anything tabular.
    const csv =
      resources.find((res) => (res.format || "").toUpperCase() === "CSV") ||
      resources.find((res) => /csv/i.test(res.mimetype || "")) ||
      resources.find((res) => /\.csv($|\?)/i.test(res.url || ""));
    if (!csv?.url) {
      console.warn("[dro-cdmx] CKAN package has no CSV resource");
      return null;
    }
    return csv.url;
  } catch (error) {
    console.error(`[dro-cdmx] CKAN error: ${(error as Error).message}`);
    return null;
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const url = await resolveCsvUrl();
  if (!url) {
    console.warn(
      "[dro-cdmx] no CSV URL resolved — set PROLIO_DRO_CDMX_CSV to the resource URL; skipping",
    );
    return out;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    console.error(`[dro-cdmx] CSV network error: ${(error as Error).message}`);
    return out;
  }
  if (!response.ok) {
    console.error(`[dro-cdmx] ${response.status} on ${url}`);
    return out;
  }
  const text = await response.text();
  const rows = parseCsv(text);

  for (const row of rows) {
    if (out.length >= limit) break;
    // Field names in datos.cdmx CKAN are lower_snake_case with accents stripped.
    const num =
      row["registro"] ||
      row["numero_registro"] ||
      row["clave"] ||
      row["folio"] ||
      row["id"];
    const nombre =
      row["nombre_completo"] ||
      row["nombre"] ||
      [row["nombres"], row["primer_apellido"], row["segundo_apellido"]]
        .filter(Boolean)
        .join(" ")
        .trim();
    if (!num || !nombre) continue;
    const tipo =
      row["tipo"] ||
      row["modalidad"] ||
      row["tipo_de_registro"] ||
      row["rol"]; // DRO vs corresponsable
    const address = [
      row["calle"],
      row["numero_exterior"] || row["num_ext"],
      row["colonia"],
      row["alcaldia"] || row["delegacion"],
    ]
      .filter(Boolean)
      .join(", ");
    out.push(
      normalise({
        source: "dro-cdmx" as ScrapeSource,
        country: "MX",
        sourceId: `dro-cdmx:${String(num).trim()}`,
        name: String(nombre).trim(),
        categoryKey: CATEGORY,
        citySlug: "cdmx",
        address: address || undefined,
        phone: row["telefono"] || row["tel"] || row["celular"] || undefined,
        email: row["correo"] || row["email"] || row["correo_electronico"] || undefined,
        licenseNumber: String(num).trim(),
        metadata: {
          country: "MX",
          authority: "SEDUVI-CDMX",
          verified_by_authority: true,
          tipo: tipo || undefined,
          alcaldia: row["alcaldia"] || row["delegacion"] || undefined,
          especialidad: row["especialidad"] || row["corresponsabilidad"] || undefined,
        },
      }),
    );
  }
  console.log(`[dro-cdmx] parsed=${out.length}`);
  return out;
}

export const droCdmxEnabled = (): boolean =>
  process.env.PROLIO_RUN_DRO_CDMX === "true";

export const droCdmxSource: ScraperSource = {
  name: "dro-cdmx" as ScrapeSource,
  enabled: droCdmxEnabled,
  async fetch() {
    return [];
  },
};

export async function runDroCdmx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!droCdmxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("dro-cdmx", async () => {
    const rawLimit = Number(process.env.PROLIO_DRO_CDMX_LIMIT ?? DEFAULT_LIMIT);
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
