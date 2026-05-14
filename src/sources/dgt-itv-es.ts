import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * DGT — Centros de Inspección Técnica de Vehículos (ITV) de España.
 *
 *   https://datos.gob.es/en/catalogo/e00130502-centros-de-inspeccion-tecnica-de-vehiculos-itv
 *
 * El portal de datos.gob.es solo publica una distribución HTML que
 * apunta a https://www.dgt.es/conoce-la-dgt/con-quien-trabajamos/itv/.
 * Esa página embebe un iframe a https://gis.dgt.es/mapa que carga
 * los puntos desde un FeatureServer ArcGIS público:
 *
 *   https://services3.arcgis.com/TXNiwnLDifb5lMaR/arcgis/rest/services/ITV_pre/FeatureServer/0
 *
 * ~400 estaciones ITV nacionales con campos `codigo_centro`, `nombre`,
 * `direccion`, `telefono`, `comunidad`, `provincia`, `municipio`,
 * `codigo_postal`, `latitud`, `longitud`, `web`, `email`.
 *
 * Off by default. `PROLIO_RUN_DGT_ITV_ES=true` to enable.
 * Cap with `PROLIO_DGT_ITV_ES_LIMIT` (default 1000).
 */

const FEATURE_URL =
  process.env.PROLIO_DGT_ITV_ES_FEATURE_URL ||
  "https://services3.arcgis.com/TXNiwnLDifb5lMaR/arcgis/rest/services/ITV_pre/FeatureServer/0/query";
const DEFAULT_LIMIT = 1000;
const PAGE_SIZE = 2000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "itv";
const SOURCE_NAME = "dgt-itv-es" as ScrapeSource;

interface ItvFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ItvResponse {
  features?: ItvFeature[];
  exceededTransferLimit?: boolean;
}

async function fetchPage(offset: number): Promise<ItvResponse> {
  const url = new URL(FEATURE_URL);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "*");
  url.searchParams.set("f", "json");
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("orderByFields", "OBJECTID ASC");
  const response = await fetch(url, {
    headers: { "User-Agent": POLITE_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`DGT ITV ${response.status} on ${url.pathname}`);
  }
  return (await response.json()) as ItvResponse;
}

function asString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s.length > 0 ? s : undefined;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < 50; page += 1) {
    let payload: ItvResponse;
    try {
      payload = await fetchPage(offset);
    } catch (error) {
      console.error(`[dgt-itv-es] page offset=${offset} failed: ${(error as Error).message}`);
      break;
    }
    const features = payload.features ?? [];
    if (features.length === 0) break;
    for (const feature of features) {
      if (out.length >= limit) break;
      const attrs = feature.attributes ?? {};
      const codigo = asString(attrs["codigo_centro"]) ?? asString(attrs["id"]);
      const nombre = asString(attrs["nombre"]);
      if (!codigo || !nombre) continue;
      const sourceId = `dgt-itv:${codigo}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      const municipio = asString(attrs["municipio"]);
      const provincia = asString(attrs["provincia"]);
      const direccion = asString(attrs["direccion"]);
      const cp = asString(attrs["codigo_postal"]);
      const address = [direccion, cp, municipio, provincia]
        .filter(Boolean)
        .join(", ") || undefined;

      const citySlug = municipio
        ? slugify(municipio)
        : provincia
          ? slugify(provincia)
          : "es";

      const lat = typeof attrs["latitud"] === "number" ? (attrs["latitud"] as number) : undefined;
      const lon = typeof attrs["longitud"] === "number" ? (attrs["longitud"] as number) : undefined;

      out.push(
        normalise({
          source: SOURCE_NAME,
          sourceId,
          name: nombre,
          categoryKey: CATEGORY,
          citySlug,
          address,
          phone: asString(attrs["telefono"]) ?? asString(attrs["movil"]),
          email: asString(attrs["email"]),
          website: asString(attrs["web"]),
          licenseNumber: codigo,
          lat,
          lng: lon,
          metadata: {
            country: "ES",
            authority: "DGT",
            verified_by_authority: true,
            comunidad: asString(attrs["comunidad"]),
            provincia,
            municipio,
            codigo_postal: cp,
            tipo: asString(attrs["tipo_elemento"]) ?? "ITV",
          },
        }),
      );
    }
    if (out.length >= limit) break;
    if (!payload.exceededTransferLimit && features.length < PAGE_SIZE) break;
    offset += features.length;
  }
  console.log(`[dgt-itv-es] parsed=${out.length}`);
  return out;
}

export const dgtItvEsEnabled = (): boolean =>
  process.env.PROLIO_RUN_DGT_ITV_ES === "true";

export const dgtItvEsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled: dgtItvEsEnabled,
  async fetch() {
    return [];
  },
};

export async function runDgtItvEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!dgtItvEsEnabled()) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("dgt-itv-es", async () => {
    const rawLimit = Number(process.env.PROLIO_DGT_ITV_ES_LIMIT ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
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
