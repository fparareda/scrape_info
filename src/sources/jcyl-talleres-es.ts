import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { parseCsv } from "./_bulk-utils.js";

/**
 * Junta de Castilla y León — Registro de Talleres de Reparación de Vehículos
 *
 * Open-data CSV published under Creative Commons Attribution 4.0 by the
 * Dirección General de Industria (Junta de Castilla y León). Covers all
 * registered motor-vehicle repair and maintenance workshops in the autonomous
 * community of Castilla y León (CNAE 4520 — "Mantenimiento y reparación de
 * vehículos de motor"), updated annually.
 *
 * Canonical dataset page:
 *   https://datosabiertos.jcyl.es/web/jcyl/set/es/industria/talleres-reparacion-vehiculos/1284993284985
 *
 * Direct CSV download (302-redirect from the above):
 *   https://transparencia.jcyl.es/economia/industria/talleres-reparacion-vehiculos.csv
 *
 * robots.txt at transparencia.jcyl.es only blocks /Presidencia/IPUB/ and
 * /sioc/ — the CSV endpoint is fully open.
 *
 * Columns (raw header names):
 *   PROVINCIA, MUNICIPIO, LOCALIDAD, TIPO, CALLE, Nº, C. POSTAL,
 *   TITULAR, CNAE PRINCIPAL, DESCRIPCIÓN CNAE
 *
 * Off by default. Set PROLIO_RUN_JCYL_TALLERES_ES=true to enable.
 * Cap with PROLIO_JCYL_TALLERES_ES_LIMIT (default 5000).
 */

const DEFAULT_CSV_URL =
  process.env.PROLIO_JCYL_TALLERES_ES_URL ||
  "https://transparencia.jcyl.es/economia/industria/talleres-reparacion-vehiculos.csv";
const DEFAULT_LIMIT = 5000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "mecanica";
const SOURCE_NAME = "jcyl-talleres-es" as ScrapeSource;

async function fetchCsv(): Promise<string> {
  const response = await fetch(DEFAULT_CSV_URL, {
    headers: {
      "User-Agent": POLITE_UA,
      Accept: "text/csv,text/plain,*/*",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(
      `[jcyl-talleres-es] HTTP ${response.status} on ${DEFAULT_CSV_URL}`,
    );
  }
  return response.text();
}

function buildAddress(row: Record<string, string>): string | undefined {
  const tipo = (row["TIPO"] ?? "").trim();
  const calle = (row["CALLE"] ?? "").trim();
  const numero = (row["Nº"] ?? "").trim();
  const cp = (row["C. POSTAL"] ?? row["C.POSTAL"] ?? "").trim();
  const localidad = (row["LOCALIDAD"] ?? row["MUNICIPIO"] ?? "").trim();
  const parts: string[] = [];
  if (tipo && calle) {
    parts.push(`${tipo} ${calle}${numero ? " " + numero : ""}`);
  } else if (calle) {
    parts.push(calle + (numero ? " " + numero : ""));
  }
  if (cp) parts.push(cp);
  if (localidad) parts.push(localidad);
  const provincia = (row["PROVINCIA"] ?? "").trim();
  if (provincia && provincia.toLowerCase() !== localidad.toLowerCase()) {
    parts.push(provincia);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  let csv: string;
  try {
    csv = await fetchCsv();
  } catch (error) {
    console.error(
      `[jcyl-talleres-es] fetch failed: ${(error as Error).message}`,
    );
    return [];
  }

  const rows = parseCsv(csv);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;

    const titular = (row["TITULAR"] ?? "").trim();
    const municipio = (row["MUNICIPIO"] ?? "").trim();
    const provincia = (row["PROVINCIA"] ?? "").trim();

    if (!titular) continue;

    // Build a stable source ID from name + municipality + province
    const sourceId = `jcyl:${titular.toLowerCase().replace(/\s+/g, "_")}:${municipio.toLowerCase()}:${provincia.toLowerCase()}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const citySlug = municipio
      ? slugify(municipio)
      : provincia
        ? slugify(provincia)
        : "castilla-y-leon";

    out.push(
      normalise({
        source: SOURCE_NAME,
        country: "ES",
        sourceId,
        name: titular,
        categoryKey: CATEGORY,
        citySlug,
        address: buildAddress(row),
        metadata: {
          country: "ES",
          authority: "Junta de Castilla y León — Dirección General de Industria",
          verified_by_authority: true,
          comunidad: "Castilla y León",
          provincia,
          municipio,
          localidad: (row["LOCALIDAD"] ?? "").trim() || undefined,
          codigo_postal: (row["C. POSTAL"] ?? row["C.POSTAL"] ?? "").trim() || undefined,
          cnae: (row["CNAE PRINCIPAL"] ?? "").trim() || undefined,
          cnae_desc: (row["DESCRIPCIÓN CNAE"] ?? row["DESCRIPCION CNAE"] ?? "").trim() || undefined,
        },
      }),
    );
  }

  console.log(`[jcyl-talleres-es] parsed=${out.length} (limit=${limit})`);
  return out;
}

export const jcylTalleresEsEnabled = (): boolean =>
  process.env.PROLIO_RUN_JCYL_TALLERES_ES === "true";

export const jcylTalleresEsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled: jcylTalleresEsEnabled,
  async fetch() {
    return [];
  },
};

export async function runJcylTalleresEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!jcylTalleresEsEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("jcyl-talleres-es", async () => {
    const rawLimit = Number(
      process.env.PROLIO_JCYL_TALLERES_ES_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
    const records = await fetchAll(limit);
    if (records.length === 0) {
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    }
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
