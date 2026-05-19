import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapeSource,
  ScrapedProfessional,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { parseCsv, pick } from "./_bulk-utils.js";
import { SPANISH_CITIES } from "../cities.js";

/**
 * datos.gob.es — generic CKAN/DCAT-AP scraper for the Spanish national
 * open-data catalogue. One implementation iterates ~50 disparate
 * municipal/autonomic datasets (talleres mecánicos, farmacias, ITV,
 * autoescuelas, instaladores, notarios, colegios profesionales) and
 * normalises every row into a prolio professional.
 *
 *   Catalogue API: https://datos.gob.es/apidata/catalog/dataset
 *   Per-title search: /catalog/dataset/title/<query>
 *   License: CC-BY 4.0 (most resources). Commercial reuse OK.
 *
 * Discovery model:
 *   - We hold a curated list of (query, category) pairs that map a
 *     dataset.gob.es full-text search to a prolio CategoryKey.
 *   - For each query we page the dataset endpoint, walk every dataset's
 *     `distribution` (DCAT resources), and download every CSV/JSON
 *     resource we can parse.
 *   - Robust column picking via _bulk-utils.pick(): tries common header
 *     variants ("nombre", "razon_social", "denominacion", …).
 *
 * Off by default. `PROLIO_RUN_DATOS_GOB_ES=true` to enable.
 *
 * Env knobs:
 *   PROLIO_DATOS_GOB_ES_LIMIT      total row cap (default 100000)
 *   PROLIO_DATOS_GOB_ES_QUERY      single query slug to focus on
 *                                  (matches QUERY_MAP key, see below)
 *   PROLIO_DATOS_GOB_ES_PAGES      max dataset pages per query (default 5,
 *                                  each page is 50 datasets)
 *   PROLIO_DATOS_GOB_ES_RES_LIMIT  max resources per dataset (default 3)
 */

const API_BASE = "https://datos.gob.es/apidata/catalog/dataset";
const USER_AGENT =
  "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const DEFAULT_LIMIT = 100_000;
const DEFAULT_PAGES = 5;
const DEFAULT_RES_PER_DATASET = 3;
const PAGE_SIZE = 50;

// ─── Query → category mapping ──────────────────────────────────────────
//
// Each entry expresses one dataset.gob.es search. The slug is the env
// override key (`PROLIO_DATOS_GOB_ES_QUERY=talleres-mecanica`) and the
// cron-rotated key.
interface QuerySpec {
  slug: string;
  title: string; // title query string sent to /catalog/dataset/title/<q>
  category: CategoryKey;
}

const QUERY_MAP: QuerySpec[] = [
  { slug: "talleres-mecanica",          title: "talleres reparacion",     category: "mecanica" },
  { slug: "talleres",                   title: "talleres",                 category: "mecanica" },
  { slug: "itv",                        title: "itv",                      category: "itv" },
  { slug: "inspeccion-tecnica",         title: "inspeccion tecnica vehiculos", category: "itv" },
  { slug: "autoescuelas",               title: "autoescuelas",             category: "mecanica" },
  { slug: "farmacias",                  title: "farmacias",                category: "medicina" },
  { slug: "centros-sanitarios",         title: "centros sanitarios",       category: "medicina" },
  { slug: "centros-salud",              title: "centros de salud",         category: "medicina" },
  { slug: "hospitales",                 title: "hospitales",               category: "medicina" },
  { slug: "clinicas-dentales",          title: "clinicas dentales",        category: "dentista" },
  { slug: "veterinarios",               title: "veterinarios",             category: "veterinario" },
  { slug: "clinicas-veterinarias",      title: "clinicas veterinarias",    category: "veterinario" },
  { slug: "psicologia",                 title: "psicologia",               category: "psicologia" },
  { slug: "fisioterapia",               title: "fisioterapia",             category: "fisioterapia" },
  { slug: "instaladores-electricidad",  title: "instaladores electricidad", category: "electricidad" },
  { slug: "instaladores-gas",           title: "instaladores gas",         category: "fontaneria" },
  { slug: "instaladores-fontaneria",    title: "instaladores fontaneria",  category: "fontaneria" },
  { slug: "instaladores-calefaccion",   title: "instaladores calefaccion", category: "hvac" },
  { slug: "instaladores-climatizacion", title: "instaladores climatizacion", category: "hvac" },
  { slug: "notarios",                   title: "notarios",                 category: "notario" },
  { slug: "colegio-arquitectos",        title: "colegio arquitectos",      category: "arquitecto" },
  { slug: "colegio-abogados",           title: "colegio abogados",         category: "fiscal" },
  { slug: "colegio-medicos",            title: "colegio medicos",          category: "medicina" },
  { slug: "ingenieria",                 title: "ingenieria",               category: "ingenieria" },
  { slug: "cerrajeria",                 title: "cerrajeria",               category: "cerrajero" },
  { slug: "carpinteria",                title: "carpinteria",              category: "carpinteria" },
];

// ─── DCAT-AP minimal types (linked-data-api JSON envelope) ──────────────

interface LangValue { _value?: string; _lang?: string }
type LangField = string | LangValue | LangValue[];

interface DatasetDistribution {
  accessURL?: string;
  format?: { value?: string } | string;
  title?: LangField;
}
interface DatasetItem {
  _about?: string;
  identifier?: string;
  title?: LangField;
  description?: LangField;
  publisher?: string;
  spatial?: string;
  distribution?: DatasetDistribution | DatasetDistribution[];
}
interface CatalogResponse {
  result?: {
    items?: DatasetItem[];
    next?: string;
  };
}

function langToString(field: LangField | undefined): string {
  if (!field) return "";
  if (typeof field === "string") return field;
  if (Array.isArray(field)) {
    const es = field.find((f) => f._lang === "es");
    return (es ?? field[0])._value ?? "";
  }
  return field._value ?? "";
}

function getFormat(dist: DatasetDistribution): string {
  if (!dist.format) return "";
  if (typeof dist.format === "string") return dist.format.toLowerCase();
  return (dist.format.value ?? "").toLowerCase();
}

// ─── City slug resolution ──────────────────────────────────────────────
//
// Spanish open-data records usually carry "municipio" / "localidad" /
// "poblacion". We slug those and try a direct hit against SPANISH_CITIES.
// Rows from a small municipality not in the top-50 fall back to the
// dataset's publisher municipality (parsed from the dataset title) or
// are skipped. The sink silently drops rows with an unknown citySlug.

const ES_CITY_SLUGS = new Set(SPANISH_CITIES.map((c) => c.slug));

const ES_CITY_ALIASES: Record<string, string> = {
  "la-coruna": "a-coruna",
  "coruna": "a-coruna",
  "palma-de-mallorca": "palma",
  "palma-mallorca": "palma",
  "san-sebastian-donostia": "san-sebastian",
  "donostia": "san-sebastian",
  "vitoria-gasteiz": "vitoria",
  "santa-cruz-de-tenerife": "santa-cruz-tenerife",
  "l-hospitalet-de-llobregat": "hospitalet",
  "hospitalet-de-llobregat": "hospitalet",
  "alcala-de-henares": "alcala-henares",
  "castellon-de-la-plana": "castellon",
  "jerez-de-la-frontera": "jerez",
};

function resolveCitySlug(...candidates: (string | undefined)[]): string | undefined {
  for (const raw of candidates) {
    if (!raw) continue;
    const s = slugify(raw);
    if (!s) continue;
    if (ES_CITY_SLUGS.has(s)) return s;
    const alias = ES_CITY_ALIASES[s];
    if (alias && ES_CITY_SLUGS.has(alias)) return alias;
    // try to peel off "alcala de henares" → "alcala-henares" (already
    // covered) and last-word fallback for "ayuntamiento de madrid".
    const tokens = s.split("-");
    for (let n = tokens.length; n > 0; n -= 1) {
      const tail = tokens.slice(-n).join("-");
      if (ES_CITY_SLUGS.has(tail)) return tail;
      if (ES_CITY_ALIASES[tail]) return ES_CITY_ALIASES[tail];
    }
  }
  return undefined;
}

// ─── Resource parsing ──────────────────────────────────────────────────

// Common column-name candidates per logical field. parseCsv normalises
// headers (strip accents, lowercase, snake_case) so we list the
// snake_case variants here.
const NAME_KEYS = [
  "nombre",
  "razon_social",
  "razonsocial",
  "denominacion",
  "denominacion_social",
  "titular",
  "establecimiento",
  "rotulo",
  "razon",
  "nombre_comercial",
];
const ADDRESS_KEYS = [
  "direccion",
  "domicilio",
  "calle",
  "ubicacion",
  "via",
  "tipo_via_direccion",
];
const PHONE_KEYS = ["telefono", "tel", "phone", "telefono_1"];
const EMAIL_KEYS = ["email", "correo", "correo_electronico", "e_mail", "mail"];
const CITY_KEYS = [
  "municipio",
  "localidad",
  "poblacion",
  "ciudad",
  "ayuntamiento",
];
const CP_KEYS = ["codigo_postal", "cp", "cod_postal", "codpostal"];
const WEBSITE_KEYS = ["web", "url", "sitio_web", "pagina_web"];
const LICENSE_KEYS = ["codigo", "numero", "registro", "id", "expediente"];
const LAT_KEYS = ["latitud", "lat", "y", "coord_y"];
const LNG_KEYS = ["longitud", "lng", "lon", "x", "coord_x"];

function rowsFromCsv(text: string): Array<Record<string, string>> {
  try {
    return parseCsv(text);
  } catch {
    return [];
  }
}

// Recursively walks an unknown JSON shape looking for arrays of objects
// (the typical open-data JSON resource). Returns the largest array found.
function findRecordArray(value: unknown): Record<string, unknown>[] {
  const queue: unknown[] = [value];
  let best: Record<string, unknown>[] = [];
  while (queue.length) {
    const v = queue.shift();
    if (Array.isArray(v)) {
      if (
        v.length > best.length &&
        v.every((x) => x && typeof x === "object" && !Array.isArray(x))
      ) {
        best = v as Record<string, unknown>[];
      }
      for (const x of v) queue.push(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) {
        if (x && typeof x === "object") queue.push(x);
      }
    }
  }
  return best;
}

function rowsFromJson(text: string): Array<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = findRecordArray(parsed);
  return arr.map((obj) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = slugify(k).replace(/-/g, "_");
      if (v == null) out[key] = "";
      else if (typeof v === "object") out[key] = JSON.stringify(v);
      else out[key] = String(v);
    }
    return out;
  });
}

async function downloadResource(
  url: string,
  fmt: string,
): Promise<Array<Record<string, string>>> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
      redirect: "follow",
    });
  } catch (error) {
    console.error(
      `[datos-gob-es] download failed ${url}: ${(error as Error).message}`,
    );
    return [];
  }
  if (!response.ok) return [];
  // Cap body size to ~50MB to avoid pathological files.
  const text = await response.text();
  if (text.length > 50 * 1024 * 1024) return [];
  if (fmt.includes("csv") || fmt === "text/csv") return rowsFromCsv(text);
  if (fmt.includes("json")) return rowsFromJson(text);
  // Heuristic on URL suffix when format missing.
  if (/\.csv(\?|$)/i.test(url)) return rowsFromCsv(text);
  if (/\.json(\?|$)/i.test(url)) return rowsFromJson(text);
  return [];
}

// ─── Catalog walk ──────────────────────────────────────────────────────

async function searchDatasets(
  q: QuerySpec,
  maxPages: number,
): Promise<DatasetItem[]> {
  const items: DatasetItem[] = [];
  const encoded = encodeURIComponent(q.title);
  for (let page = 0; page < maxPages; page += 1) {
    const url = `${API_BASE}/title/${encoded}?_pageSize=${PAGE_SIZE}&_page=${page}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      console.error(
        `[datos-gob-es] catalog fetch failed ${url}: ${(error as Error).message}`,
      );
      break;
    }
    if (!response.ok) break;
    let body: CatalogResponse;
    try {
      body = (await response.json()) as CatalogResponse;
    } catch {
      break;
    }
    const pageItems = body.result?.items ?? [];
    items.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) break;
  }
  return items;
}

function* datasetResources(ds: DatasetItem): Generator<DatasetDistribution> {
  const d = ds.distribution;
  if (!d) return;
  if (Array.isArray(d)) {
    for (const r of d) yield r;
  } else {
    yield d;
  }
}

// ─── Main extraction loop ──────────────────────────────────────────────

interface CrawlStats {
  datasets: number;
  resources: number;
  rows: number;
}

async function runQuery(
  q: QuerySpec,
  remaining: () => number,
  out: ScrapedProfessional[],
  seen: Set<string>,
  maxPages: number,
  maxResources: number,
  stats: CrawlStats,
): Promise<void> {
  const datasets = await searchDatasets(q, maxPages);
  console.log(
    `[datos-gob-es] query=${q.slug} datasets=${datasets.length}`,
  );
  stats.datasets += datasets.length;
  for (const ds of datasets) {
    if (remaining() <= 0) return;
    const datasetId = ds.identifier || ds._about || "";
    const datasetTitle = langToString(ds.title);
    const publisher = ds.publisher ?? "";
    let resourcesTried = 0;
    for (const dist of datasetResources(ds)) {
      if (remaining() <= 0) return;
      if (resourcesTried >= maxResources) break;
      const fmt = getFormat(dist);
      // CSV first (most reliable), then JSON. XLSX/PDF skipped.
      if (
        !fmt.includes("csv") &&
        !fmt.includes("json") &&
        !/\.(csv|json)(\?|$)/i.test(dist.accessURL ?? "")
      ) {
        continue;
      }
      const url = dist.accessURL;
      if (!url) continue;
      resourcesTried += 1;
      stats.resources += 1;
      const rows = await downloadResource(url, fmt);
      if (rows.length === 0) continue;
      stats.rows += rows.length;
      for (const row of rows) {
        if (remaining() <= 0) return;
        const name = pick(row, NAME_KEYS);
        if (!name) continue;
        const cityRaw = pick(row, CITY_KEYS);
        const slug = resolveCitySlug(cityRaw, datasetTitle);
        if (!slug) continue;
        const phone = pick(row, PHONE_KEYS) || undefined;
        const email = pick(row, EMAIL_KEYS) || undefined;
        const website = pick(row, WEBSITE_KEYS) || undefined;
        const address = pick(row, ADDRESS_KEYS) || undefined;
        const cp = pick(row, CP_KEYS) || undefined;
        const license = pick(row, LICENSE_KEYS) || undefined;
        const latRaw = pick(row, LAT_KEYS);
        const lngRaw = pick(row, LNG_KEYS);
        const lat = latRaw ? Number(latRaw.replace(",", ".")) : undefined;
        const lng = lngRaw ? Number(lngRaw.replace(",", ".")) : undefined;
        const baseId = license || slugify(name) + "-" + (cp ?? slug);
        const sourceId = `datos-gob-es:${q.slug}:${slugify(datasetId).slice(0, 40)}:${slugify(baseId).slice(0, 60)}`;
        if (seen.has(sourceId)) continue;
        seen.add(sourceId);
        out.push(
          normalise({
            source: "datos-gob-es" as ScrapeSource,
            country: "ES",
            sourceId,
            name,
            categoryKey: q.category,
            citySlug: slug,
            phone,
            email,
            website,
            address: address
              ? [address, cp, cityRaw].filter(Boolean).join(", ")
              : undefined,
            licenseNumber: license,
            lat: Number.isFinite(lat) ? lat : undefined,
            lng: Number.isFinite(lng) ? lng : undefined,
            metadata: {
              country: "ES",
              dataset_id: datasetId,
              dataset_title: datasetTitle,
              publisher,
              region: ds.spatial,
              query: q.slug,
              resource_url: url,
              resource_format: fmt,
            },
          }),
        );
      }
    }
  }
}

async function fetchAll(limit: number): Promise<{
  records: ScrapedProfessional[];
  stats: CrawlStats;
}> {
  const focus = process.env.PROLIO_DATOS_GOB_ES_QUERY?.trim();
  const maxPages = Math.max(
    1,
    Number(process.env.PROLIO_DATOS_GOB_ES_PAGES ?? DEFAULT_PAGES),
  );
  const maxResources = Math.max(
    1,
    Number(
      process.env.PROLIO_DATOS_GOB_ES_RES_LIMIT ?? DEFAULT_RES_PER_DATASET,
    ),
  );

  let queries: QuerySpec[];
  if (focus) {
    const match = QUERY_MAP.find((q) => q.slug === focus);
    if (!match) {
      console.error(
        `[datos-gob-es] query "${focus}" not in QUERY_MAP — known slugs: ${QUERY_MAP.map((q) => q.slug).join(", ")}`,
      );
      return { records: [], stats: { datasets: 0, resources: 0, rows: 0 } };
    }
    queries = [match];
  } else {
    queries = QUERY_MAP;
  }

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  const stats: CrawlStats = { datasets: 0, resources: 0, rows: 0 };
  const remaining = () => limit - out.length;

  for (const q of queries) {
    if (remaining() <= 0) break;
    try {
      await runQuery(q, remaining, out, seen, maxPages, maxResources, stats);
    } catch (error) {
      console.error(
        `[datos-gob-es] query ${q.slug} crashed: ${(error as Error).message}`,
      );
    }
  }
  return { records: out, stats };
}

export const datosGobEsSource: ScraperSource = {
  name: "datos-gob-es" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_DATOS_GOB_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runDatosGobEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!datosGobEsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_DATOS_GOB_ES_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const { records, stats } = await fetchAll(limit);
  console.log(
    `[datos-gob-es] crawl-stats datasets=${stats.datasets} resources=${stats.resources} raw_rows=${stats.rows} accepted=${records.length}`,
  );
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[datos-gob-es] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}

/** Exposed for tests + the workflow's daily query rotation. */
export const DATOS_GOB_ES_QUERIES = QUERY_MAP.map((q) => q.slug);
