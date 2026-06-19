import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { ensureCity } from "../lib/city-upsert.js";
import { getSupabaseClient } from "../lib/supabase-client.js";
import { parseCsv } from "./_bulk-utils.js";

/**
 * RII División A — Carpinterías (ES carpinteria).
 *
 * Spain's Ministry of Industry publishes the Registro Integrado Industrial
 * (RII) as open data under Real Decreto 559/2010. División A covers all
 * physical industrial establishments. This scraper filters the full División A
 * CSV for carpintería establishments (wooden and metallic joinery, furniture
 * manufacturers, window/door installers) identified by the word "carpint" in
 * the Denominación field.
 *
 *   Dataset catalogue:
 *   https://datos.gob.es/en/catalogo/e05024301-consulta-registro-integrado-industrial-division-a
 *
 *   CSV endpoint (refreshed daily):
 *   https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20A.csv
 *
 * The full CSV has ~213k rows across all CNAE codes. Filtering on
 * Denominación containing "carpint" (case-insensitive, after accent-stripping)
 * and Estado == "ACTIVO" yields an estimated ~780 carpintería workshops.
 *
 * robots.txt: serviciosmin.gob.es returns 404 → no restrictions.
 * Open government data under Spanish open-data reuse license
 * (Real Decreto 1495/2011 / ODBL equivalent).
 *
 * Note: PR #92 covers RII División A for talleres mecánicos (mecanica).
 * This scraper uses the same CSV but a different Denominación filter
 * targeting carpintería businesses — a distinct, non-overlapping category.
 *
 * Pre-flight (verified 2026-06-02):
 *   - robots.txt 404 on www6.serviciosmin.gob.es → no restrictions
 *   - CSV accessible at ~490 KB/s; full download ~75 s
 *   - Sample grep "carpint" on 3 MB slice → 63 ACTIVO matches
 *     → estimated ~780 total active carpinterías in full file
 *   - No captcha / no auth / open government data license
 *
 * Off by default. `PROLIO_RUN_RII_DIV_A_CARPINTERIA_ES=true` to enable.
 * Cap with `PROLIO_RII_DIV_A_CARPINTERIA_ES_LIMIT` (default 5000).
 */

const DEFAULT_URL =
  process.env.PROLIO_RII_DIV_A_CARPINTERIA_ES_URL ??
  "https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20division%20A.csv";
const DEFAULT_LIMIT = 5_000;
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const CATEGORY: CategoryKey = "carpinteria";
const SOURCE_NAME = "rii-div-a-carpinteria-es" as ScrapeSource;

// parseCsv normalises header names via normaliseHeaderKey:
//   NFD, lowercase, strip accents, replace non-alphanumeric runs with "_".
// Resulting keys for this CSV:
//   Fecha Registro        → fecha_registro
//   Estado                → estado
//   Denominación          → denominacion
//   Empresa               → empresa
//   Número Identificación → numero_identificacion
//   Comunidad Autónoma    → comunidad_autonoma
//   CNAE_ZZZ              → cnae_zzz
//   Info. Actividad       → info_actividad
//   Identificación        → identificacion
//   Municipio - Localidad → municipio_localidad
//   Provincia             → provincia

/** Strip accents and lower-case for robust matching. */
function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function isCarpinteria(row: Record<string, string>): boolean {
  // Only active establishments.
  const estado = (row["estado"] ?? "").trim().toUpperCase();
  if (estado !== "ACTIVO") return false;

  const denom = normalizeForMatch(row["denominacion"] ?? "");
  const empresa = normalizeForMatch(row["empresa"] ?? "");
  const activity = normalizeForMatch(row["info_actividad"] ?? "");

  // Match any record whose name or activity description contains "carpint"
  // (covers carpintería, carpintero, carpintería metálica, etc.).
  return (
    denom.includes("carpint") ||
    empresa.includes("carpint") ||
    activity.includes("carpint")
  );
}

async function fetchCsv(): Promise<string> {
  const response = await fetch(DEFAULT_URL, {
    headers: {
      "User-Agent": POLITE_UA,
      Accept: "text/csv,text/plain,*/*",
    },
    signal: AbortSignal.timeout(180_000),
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
    console.error(
      `[rii-div-a-carpinteria-es] fetch failed: ${(error as Error).message}`,
    );
    return [];
  }

  const client = getSupabaseClient();
  const rows = parseCsv(csv);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoId = 0;
  let droppedNoName = 0;
  let filteredOut = 0;

  for (const row of rows) {
    if (out.length >= limit) break;

    if (!isCarpinteria(row)) {
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

    const sourceId = `rii-a-carp:${regId}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const municipio = (row["municipio_localidad"] ?? "").trim();
    const provincia = (row["provincia"] ?? "").trim();
    const ccaa = (row["comunidad_autonoma"] ?? "").trim();

    // Auto-seed the city by NAME so the row survives the sink. When no
    // municipio, emit citySlug="" (sink writes city_slug=NULL, keeps the
    // row). Do NOT fabricate slugify(provincia)/"espana" — not seeded.
    let citySlug = "";
    if (municipio) {
      const cityResult = await ensureCity(client, {
        name: municipio,
        state: provincia || ccaa || "España",
        country: "ES",
      });
      if (cityResult) citySlug = cityResult.slug;
    }

    out.push(
      normalise({
        source: SOURCE_NAME,
        country: "ES",
        sourceId,
        name,
        categoryKey: CATEGORY,
        citySlug,
        licenseNumber: regId,
        metadata: {
          country: "ES",
          authority: "Ministerio de Industria (RII División A)",
          verified_by_authority: true,
          comunidad_autonoma: ccaa || undefined,
          provincia: provincia || undefined,
          municipio: municipio || undefined,
          cnae: (row["cnae_zzz"] ?? "").trim() || undefined,
          legal_name: empresa || undefined,
          trade_name: tradeName || undefined,
          nif: (row["identificacion"] ?? "").trim() || undefined,
        },
      }),
    );
  }

  console.log(
    `[rii-div-a-carpinteria-es] total_rows=${rows.length} filtered_out=${filteredOut} ` +
      `parsed=${out.length} dropped_no_id=${droppedNoId} dropped_no_name=${droppedNoName}`,
  );
  return out;
}

export const riiDivACarpinteriaEsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_RII_DIV_A_CARPINTERIA_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runRiiDivACarpinteriaEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!riiDivACarpinteriaEsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_RII_DIV_A_CARPINTERIA_ES_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const sink = getSink({ trustCitySlugs: true });
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[rii-div-a-carpinteria-es] upserted=${records.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
