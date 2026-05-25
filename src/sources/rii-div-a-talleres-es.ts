import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv } from "./_bulk-utils.js";

/**
 * RII División A — Talleres de Reparación de Vehículos Automóviles.
 *
 * Spain's Ministry of Industry publishes the Registro Integrado Industrial
 * (RII) as open data under Real Decreto 559/2010. División A covers all
 * physical industrial establishments (talleres mecánicos, carrocería,
 * electricidad del automóvil, etc.).
 *
 *   Dataset catalogue:
 *   https://datos.gob.es/en/catalogo/e05024301-consulta-registro-integrado-industrial-division-a
 *
 *   CSV endpoint (refreshed daily):
 *   https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20A.csv
 *
 * The full CSV has ~212k rows across all CNAE codes. We filter on
 * `Info. Actividad` containing "taller" + "reparaci" to isolate
 * "Talleres de reparación de vehículos automóviles" (~19,304 rows).
 * Each record carries the official RII registration number
 * (`Número Identificación`) as the verifiable identifier.
 *
 * robots.txt: serviciosmin.gob.es returns 404 → no restrictions.
 * Open government data under Spanish open-data reuse license
 * (Real Decreto 1495/2011 / ODBL equivalent).
 *
 * Note: PR #76 covers RII División B (electricidad + HVAC installers).
 * División A and División B are separate registers with separate CNAE
 * codes, separate registration number series, and non-overlapping
 * categories.
 *
 * Off by default. `PROLIO_RUN_RII_DIV_A_TALLERES_ES=true` to enable.
 * Cap with `PROLIO_RII_DIV_A_TALLERES_ES_LIMIT` (default 25000).
 */

const DEFAULT_URL =
  process.env.PROLIO_RII_DIV_A_TALLERES_ES_URL ??
  "https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20A.csv";
const DEFAULT_LIMIT = 25_000;
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const CATEGORY: CategoryKey = "mecanica";
const SOURCE_NAME = "rii-div-a-talleres-es" as ScrapeSource;

// parseCsv normalises header names via normaliseHeaderKey:
//   NFD, lowercase, strip accents, replace non-alphanumeric runs with "_".
// Resulting keys for this CSV:
//   Denominación          → denominacion
//   Empresa               → empresa
//   Número Identificación → numero_identificacion
//   Comunidad Autónoma    → comunidad_autonoma
//   CNAE                  → cnae
//   Info. Actividad       → info_actividad
//   Identificación        → identificacion
//   Municipio - Localidad → municipio_localidad
//   Provincia             → provincia

function isTaller(row: Record<string, string>): boolean {
  const act = (row["info_actividad"] ?? "").toLowerCase();
  return act.includes("taller") && act.includes("reparaci");
}

async function fetchCsv(): Promise<string> {
  const response = await fetch(DEFAULT_URL, {
    headers: {
      "User-Agent": POLITE_UA,
      Accept: "text/csv,text/plain,*/*",
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`RII División A HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  let csv: string;
  try {
    csv = await fetchCsv();
  } catch (error) {
    console.error(`[rii-div-a-talleres-es] fetch failed: ${(error as Error).message}`);
    return [];
  }

  const rows = parseCsv(csv);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoId = 0;
  let droppedNoName = 0;
  let filteredOut = 0;

  for (const row of rows) {
    if (out.length >= limit) break;

    if (!isTaller(row)) {
      filteredOut += 1;
      continue;
    }

    const regId = (row["numero_identificacion"] ?? "").trim();
    if (!regId) {
      droppedNoId += 1;
      continue;
    }

    const tradeName = (row["denominacion"] ?? "").trim();
    const empresa = (row["empresa"] ?? "").trim();
    const name = tradeName || empresa;
    if (!name) {
      droppedNoName += 1;
      continue;
    }

    const sourceId = `rii-a:${regId}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const municipio = (row["municipio_localidad"] ?? "").trim();
    const provincia = (row["provincia"] ?? "").trim();
    const ccaa = (row["comunidad_autonoma"] ?? "").trim();

    const citySlug = municipio
      ? slugify(municipio)
      : provincia
        ? slugify(provincia)
        : "espana";

    out.push(
      normalise({
        source: SOURCE_NAME,
        country: "ES",
        sourceId,
        name,
        categoryKey: CATEGORY,
        citySlug,
        licenseNumber: regId,
        cif: (row["identificacion"] ?? "").trim() || undefined,
        metadata: {
          country: "ES",
          authority: "Ministerio de Industria (RII División A)",
          verified_by_authority: true,
          comunidad_autonoma: ccaa || undefined,
          provincia: provincia || undefined,
          municipio: municipio || undefined,
          cnae: (row["cnae"] ?? "").trim() || undefined,
          legal_name: empresa || undefined,
          trade_name: tradeName || undefined,
        },
      }),
    );
  }

  console.log(
    `[rii-div-a-talleres-es] total_rows=${rows.length} filtered_out=${filteredOut} ` +
      `parsed=${out.length} dropped_no_id=${droppedNoId} dropped_no_name=${droppedNoName}`,
  );
  return out;
}

export const riiDivATalleresEsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_RII_DIV_A_TALLERES_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runRiiDivATalleresEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!riiDivATalleresEsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_RII_DIV_A_TALLERES_ES_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[rii-div-a-talleres-es] upserted=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
