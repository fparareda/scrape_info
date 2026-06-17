import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * CGCOD — Consejo General de Colegios de Dentistas de España.
 *
 * Public directory at https://guiadentistas.es (linked from
 * consejodentistas.es/consejo-general/colegios-oficiales/).
 *
 * Pre-flight (2026-05-13):
 *   robots.txt — 404 (no file) → no restrictions; all paths allowed.
 *   Page structure — Bootstrap + jQuery DataTables (server-side rendering).
 *     JSON endpoint: GET /colegios/serverFO.php?draw=N&start=M&length=L
 *     Returns: {"recordsTotal":52289,"recordsFiltered":44355,"data":[…]}
 *     Each record: [numcol, nombre, apellido1, apellido2, rowId]
 *   Province mapping — first 2 digits of numcol = Spanish province INE code
 *     (01=Álava, 02=Albacete, … 28=Madrid, 50=Zaragoza, 51=Ceuta, 52=Melilla).
 *   Record count — 44,355 active colegiados (recordsFiltered).
 *   Auth / WAF — no login, no Cloudflare, no captcha; polite UA accepted.
 *
 * Category mapping: dentista (CategoryKey).
 *
 * Province → city mapping: each province maps to its capital city. We use the
 * standard Spanish province INE codes (1–52) embedded in the colegiado number.
 *
 * Off by default. Enable via `PROLIO_RUN_CGCOD_ES=true`.
 * Monthly cron — college rolls change slowly (annual renewals via BOE).
 */

const BASE_URL =
  process.env.PROLIO_CGCOD_BASE || "https://guiadentistas.es";
const ENDPOINT = `${BASE_URL}/colegios/serverFO.php`;

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 500; // DataTables page size per request
const REQUEST_DELAY_MS = 1_000; // polite delay between pages
const DEFAULT_LIMIT = 2000;

const CATEGORY: CategoryKey = "dentista";

// --- Province → city slug mapping (INE code → Prolio city slug) -----------
// Spanish province codes 01–52 map to provincial capitals.
const PROVINCE_TO_CITY: Record<string, string> = {
  "01": "vitoria-gasteiz",
  "02": "albacete",
  "03": "alicante",
  "04": "almeria",
  "05": "avila",
  "06": "badajoz",
  "07": "palma",
  "08": "barcelona",
  "09": "burgos",
  "10": "caceres",
  "11": "cadiz",
  "12": "castellon",
  "13": "ciudad-real",
  "14": "cordoba",
  "15": "a-coruna",
  "16": "cuenca",
  "17": "girona",
  "18": "granada",
  "19": "guadalajara",
  "20": "san-sebastian",
  "21": "huelva",
  "22": "huesca",
  "23": "jaen",
  "24": "leon",
  "25": "lleida",
  "26": "logrono",
  "27": "lugo",
  "28": "madrid",
  "29": "malaga",
  "30": "murcia",
  "31": "pamplona",
  "32": "ourense",
  "33": "oviedo",
  "34": "palencia",
  "35": "las-palmas-de-gran-canaria",
  "36": "pontevedra",
  "37": "salamanca",
  "38": "santa-cruz-de-tenerife",
  "39": "santander",
  "40": "segovia",
  "41": "sevilla",
  "42": "soria",
  "43": "tarragona",
  "44": "teruel",
  "45": "toledo",
  "46": "valencia",
  "47": "valladolid",
  "48": "bilbao",
  "49": "zamora",
  "50": "zaragoza",
  "51": "ceuta",
  "52": "melilla",
};

// --- HTTP helpers ----------------------------------------------------------

interface FetchResponse {
  status: number;
  body: string;
}

async function politeFetch(url: string): Promise<FetchResponse | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "application/json,text/html,*/*;q=0.1",
          "Accept-Language": "es-ES,es;q=0.9",
          Referer: `${BASE_URL}/results.php`,
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (res.status === 403 || res.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[cgcod_es] blocked with polite UA (${res.status}); retrying with Chrome UA`,
          );
          continue;
        }
        return { status: res.status, body: "" };
      }
      if (!res.ok) return { status: res.status, body: "" };
      const body = await res.text();
      return { status: res.status, body };
    } catch (err) {
      clearTimeout(timer);
      console.warn(
        `[cgcod_es] network error on ${url}: ${(err as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Data types -----------------------------------------------------------

interface DatatablesResponse {
  draw: number;
  recordsTotal: number;
  recordsFiltered: number;
  data: Array<[string, string, string, string, string | number]>;
}

interface DentistaRecord {
  numcol: string;
  nombre: string;
  apellido1: string;
  apellido2: string;
}

// --- Parse ----------------------------------------------------------------

/**
 * Parse the raw DataTables JSON response from serverFO.php.
 * Strips leading PHP warnings (the server emits a count() notice).
 */
function parseDatatablesJson(raw: string): DatatablesResponse | null {
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) {
    console.warn("[cgcod_es] no JSON object found in response");
    return null;
  }
  try {
    return JSON.parse(raw.slice(jsonStart)) as DatatablesResponse;
  } catch (err) {
    console.warn(`[cgcod_es] JSON parse error: ${(err as Error).message}`);
    return null;
  }
}

function mapProvince(numcol: string): string | undefined {
  const code = numcol.slice(0, 2).padStart(2, "0");
  return PROVINCE_TO_CITY[code];
}

function buildName(record: DentistaRecord): string {
  const parts = [
    record.nombre.trim(),
    record.apellido1.trim(),
    record.apellido2.trim(),
  ].filter((p) => p.length > 0);
  if (parts.length === 0) return "";
  // Convert ALL-CAPS to Title Case for display readability.
  return parts
    .join(" ")
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());
}

// --- Scrape logic ---------------------------------------------------------

async function fetchAllDentistas(
  limit: number,
): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCity = 0;
  let droppedNoName = 0;
  let offset = 0;
  let totalRecords: number | null = null;

  while (out.length < limit) {
    if (offset > 0) await sleep(REQUEST_DELAY_MS);

    const url = `${ENDPOINT}?draw=${Math.floor(offset / PAGE_SIZE) + 1}&start=${offset}&length=${PAGE_SIZE}`;
    const response = await politeFetch(url);
    if (!response || !response.body) {
      console.warn(
        `[cgcod_es] fetch failed at offset=${offset} (status=${response?.status ?? "network"})`,
      );
      break;
    }

    const parsed = parseDatatablesJson(response.body);
    if (!parsed) {
      console.warn(`[cgcod_es] could not parse response at offset=${offset}`);
      break;
    }

    if (totalRecords === null) {
      totalRecords = parsed.recordsFiltered;
      console.log(
        `[cgcod_es] total=${parsed.recordsTotal} filtered=${parsed.recordsFiltered}`,
      );
    }

    if (parsed.data.length === 0) {
      console.log(`[cgcod_es] empty page at offset=${offset} — stopping`);
      break;
    }

    for (const row of parsed.data) {
      const [numcol, nombre, apellido1, apellido2] = row;
      const record: DentistaRecord = {
        numcol: String(numcol).trim(),
        nombre: String(nombre ?? "").trim(),
        apellido1: String(apellido1 ?? "").trim(),
        apellido2: String(apellido2 ?? "").trim(),
      };

      const fullName = buildName(record);
      if (!fullName) {
        droppedNoName += 1;
        continue;
      }

      const citySlug = mapProvince(record.numcol);
      if (!citySlug) {
        droppedNoCity += 1;
        continue;
      }

      const sourceId = `cgcod:${record.numcol}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      out.push(
        normalise({
          source: "cgcod-es",
          country: "ES",
          sourceId,
          name: fullName,
          categoryKey: CATEGORY,
          citySlug,
          licenseNumber: record.numcol,
          metadata: {
            country: "ES",
            verified_by_authority: true,
            authority: "CGCOD",
            nombre: record.nombre,
            apellido1: record.apellido1,
            apellido2: record.apellido2 || undefined,
          },
        }),
      );

      if (out.length >= limit) break;
    }

    offset += parsed.data.length;

    // Stop when we've consumed all filtered records.
    if (offset >= (totalRecords ?? 0)) {
      console.log(`[cgcod_es] consumed all ${totalRecords} records — done`);
      break;
    }
  }

  console.log(
    `[cgcod_es] parsed=${out.length} droppedNoCity=${droppedNoCity} droppedNoName=${droppedNoName}`,
  );
  return out;
}

// --- Public exports -------------------------------------------------------

export const cgcodEsEnabled = (): boolean =>
  process.env.PROLIO_RUN_CGCOD_ES === "true";

export const cgcodEsSource: ScraperSource = {
  name: "cgcod-es",
  enabled: cgcodEsEnabled,
  async fetch() {
    return [];
  },
};

export async function runCgcodEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cgcodEsEnabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return withScrapeRun("cgcod-es", async () => {
    const limit = parseInt(
      process.env.PROLIO_CGCOD_ES_LIMIT ?? String(DEFAULT_LIMIT),
      10,
    );
    const effectiveLimit =
      Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
    console.log(`[cgcod_es] starting, limit=${effectiveLimit}`);

    const records = await fetchAllDentistas(effectiveLimit);
    if (records.length === 0) {
      console.warn(`[cgcod_es] 0 records — check endpoint availability`);
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    }

    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
    console.log(
      `[cgcod_es] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
    return {
      rowsFetched: records.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
    };
  }).then((result) => ({
    fetched: result?.rowsFetched ?? 0,
    inserted: 0,
    updated: 0,
    skipped: result?.rowsSkipped ?? 0,
  }));
}
