import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * guiadentistas.es — Consejo General de Dentistas de España (CGCD).
 *
 * Public buscador for the national colegiados directory (~44,360 dentists
 * across 52 Spanish provinces, including Ceuta and Melilla). The site is a
 * thin PHP frontend over a server-side DataTables endpoint:
 *
 *   POST https://guiadentistas.es/colegios/serverFO.php
 *
 * Parameters follow the DataTables 1.10 server-side protocol. The
 * `Provincia` query-string param scopes results to one province (id 1-52),
 * which matches the public form. Rows come back as a tuple:
 *
 *   [numColegiado, nombre, primerApellido, segundoApellido, rowIndex]
 *
 * Strategy: iterate provinces, request `length=PAGE_SIZE` rows per page,
 * page until DataTables returns fewer than PAGE_SIZE rows. We do NOT visit
 * `detail.php?numcol=…` here — the row tuple already gives us name +
 * colegiado number + colegio provincial, which is the core dataset Prolio
 * needs. Detail enrichment (address, phone, status) is handled later via
 * the email-extractor / crossmatch agents that already process raw HTML.
 *
 * Routed to `dentista` category. Off by default; enable with
 * `PROLIO_RUN_GUIADENTISTAS_ES=true`. Cap with `PROLIO_GUIADENTISTAS_ES_LIMIT`
 * (default 50,000 — covers the full census plus headroom).
 */

const BASE =
  process.env.PROLIO_GUIADENTISTAS_ES_BASE || "https://guiadentistas.es";
const ENDPOINT = `${BASE}/colegios/serverFO.php`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_DELAY_MS = 1500;
const PAGE_SIZE = 1000;
const MAX_PAGES_PER_PROVINCE = 100; // 100 * 1000 = 100k safety cap
const DEFAULT_LIMIT = 50_000;

interface Province {
  id: number;
  name: string;
  citySlug: string;
}

/**
 * Provincia id → name + citySlug. Values match the `<select name="Provincia">`
 * options on https://guiadentistas.es/results.php?Provincia=0. citySlug is
 * the capital (or canonical metro) for the province — chosen to align with
 * the existing Prolio city seed (lowercased, ASCII, hyphenated).
 */
const PROVINCES: Province[] = [
  { id: 1, name: "Álava", citySlug: "vitoria" },
  { id: 2, name: "Albacete", citySlug: "albacete" },
  { id: 3, name: "Alicante", citySlug: "alicante" },
  { id: 4, name: "Almería", citySlug: "almeria" },
  { id: 5, name: "Ávila", citySlug: "avila" },
  { id: 6, name: "Badajoz", citySlug: "badajoz" },
  { id: 7, name: "Baleares", citySlug: "palma" },
  { id: 8, name: "Barcelona", citySlug: "barcelona" },
  { id: 9, name: "Burgos", citySlug: "burgos" },
  { id: 10, name: "Cáceres", citySlug: "caceres" },
  { id: 11, name: "Cádiz", citySlug: "cadiz" },
  { id: 12, name: "Castellón", citySlug: "castellon" },
  { id: 13, name: "Ciudad Real", citySlug: "ciudad-real" },
  { id: 14, name: "Córdoba", citySlug: "cordoba" },
  { id: 15, name: "A Coruña", citySlug: "a-coruna" },
  { id: 16, name: "Cuenca", citySlug: "cuenca" },
  { id: 17, name: "Girona", citySlug: "girona" },
  { id: 18, name: "Granada", citySlug: "granada" },
  { id: 19, name: "Guadalajara", citySlug: "guadalajara" },
  { id: 20, name: "Guipúzcoa", citySlug: "san-sebastian" },
  { id: 21, name: "Huelva", citySlug: "huelva" },
  { id: 22, name: "Huesca", citySlug: "huesca" },
  { id: 23, name: "Jaén", citySlug: "jaen" },
  { id: 24, name: "León", citySlug: "leon" },
  { id: 25, name: "Lleida", citySlug: "lleida" },
  { id: 26, name: "La Rioja", citySlug: "logrono" },
  { id: 27, name: "Lugo", citySlug: "lugo" },
  { id: 28, name: "Madrid", citySlug: "madrid" },
  { id: 29, name: "Málaga", citySlug: "malaga" },
  { id: 30, name: "Murcia", citySlug: "murcia" },
  { id: 31, name: "Navarra", citySlug: "pamplona" },
  { id: 32, name: "Ourense", citySlug: "ourense" },
  { id: 33, name: "Asturias", citySlug: "oviedo" },
  { id: 34, name: "Palencia", citySlug: "palencia" },
  { id: 35, name: "Las Palmas", citySlug: "las-palmas" },
  { id: 36, name: "Pontevedra", citySlug: "pontevedra" },
  { id: 37, name: "Salamanca", citySlug: "salamanca" },
  { id: 38, name: "S.C. de Tenerife", citySlug: "santa-cruz-de-tenerife" },
  { id: 39, name: "Cantabria", citySlug: "santander" },
  { id: 40, name: "Segovia", citySlug: "segovia" },
  { id: 41, name: "Sevilla", citySlug: "sevilla" },
  { id: 42, name: "Soria", citySlug: "soria" },
  { id: 43, name: "Tarragona", citySlug: "tarragona" },
  { id: 44, name: "Teruel", citySlug: "teruel" },
  { id: 45, name: "Toledo", citySlug: "toledo" },
  { id: 46, name: "Valencia", citySlug: "valencia" },
  { id: 47, name: "Valladolid", citySlug: "valladolid" },
  { id: 48, name: "Vizcaya", citySlug: "bilbao" },
  { id: 49, name: "Zamora", citySlug: "zamora" },
  { id: 50, name: "Zaragoza", citySlug: "zaragoza" },
  { id: 51, name: "Ceuta", citySlug: "ceuta" },
  { id: 52, name: "Melilla", citySlug: "melilla" },
];

interface DataTablesResponse {
  draw?: number;
  recordsTotal?: number;
  recordsFiltered?: number;
  data?: Array<Array<string>>;
  error?: string;
}

function buildBody(provinciaId: number, start: number, length: number): string {
  // DataTables 1.10 server-side payload. Five columns: numcol, nombre,
  // apellido1, apellido2, action (column 4 not searchable / orderable).
  const params: Array<[string, string]> = [
    ["draw", String(Math.floor(start / length) + 1)],
    ["start", String(start)],
    ["length", String(length)],
    ["search[value]", ""],
    ["search[regex]", "false"],
    ["order[0][column]", "2"],
    ["order[0][dir]", "asc"],
    ["order[1][column]", "3"],
    ["order[1][dir]", "asc"],
    ["Provincia", String(provinciaId)],
  ];
  const columns = ["0", "1", "2", "3", "4"];
  for (const c of columns) {
    const searchable = c === "4" ? "false" : "true";
    const orderable = c === "4" ? "false" : "true";
    params.push([`columns[${c}][data]`, c]);
    params.push([`columns[${c}][name]`, ""]);
    params.push([`columns[${c}][searchable]`, searchable]);
    params.push([`columns[${c}][orderable]`, orderable]);
    params.push([`columns[${c}][search][value]`, ""]);
    params.push([`columns[${c}][search][regex]`, "false"]);
  }
  return new URLSearchParams(params).toString();
}

async function fetchPage(
  province: Province,
  start: number,
): Promise<DataTablesResponse> {
  const body = buildBody(province.id, start, PAGE_SIZE);
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${BASE}/results.php?Provincia=${province.id}`,
    },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(
      `guiadentistas-es Provincia=${province.id} → HTTP ${response.status}`,
    );
  }
  const text = await response.text();
  // The endpoint occasionally prefixes a PHP `<br /><b>Warning</b>...` block
  // before the JSON. Strip everything before the first `{`.
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    throw new Error(`guiadentistas-es Provincia=${province.id} → no JSON`);
  }
  try {
    return JSON.parse(text.slice(jsonStart)) as DataTablesResponse;
  } catch (error) {
    throw new Error(
      `guiadentistas-es Provincia=${province.id} JSON parse failed: ${(error as Error).message}`,
    );
  }
}

function buildFullName(
  primero: string,
  apellido1: string,
  apellido2: string,
): string {
  const parts = [primero, apellido1, apellido2]
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return toTitleCase(parts.join(" "));
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  outer: for (const province of PROVINCES) {
    let collected = 0;
    let totalReported: number | undefined;
    try {
      for (let page = 0; page < MAX_PAGES_PER_PROVINCE; page += 1) {
        if (out.length >= limit) break outer;
        const start = page * PAGE_SIZE;
        const json = await fetchPage(province, start);
        if (json.error) {
          console.error(
            `[guiadentistas-es] ${province.name} (id=${province.id}) error: ${json.error}`,
          );
          break;
        }
        if (typeof json.recordsFiltered === "number" && page === 0) {
          totalReported = json.recordsFiltered;
        }
        const rows = json.data ?? [];
        if (rows.length === 0) break;
        for (const row of rows) {
          if (!Array.isArray(row) || row.length < 4) continue;
          const numcol = (row[0] ?? "").trim();
          const nombre = (row[1] ?? "").trim();
          const apellido1 = (row[2] ?? "").trim();
          const apellido2 = (row[3] ?? "").trim();
          if (!numcol) continue;
          // Guard: same numcol can in theory show under multiple provinces
          // (re-colegiación) — first wins.
          const dedupeKey = `${province.id}:${numcol}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          const name = buildFullName(nombre, apellido1, apellido2);
          if (!name) continue;
          out.push(
            normalise({
              source: "guiadentistas-es" as ScrapeSource,
              country: "ES",
              sourceId: `guiadentistas-es:${numcol}`,
              name,
              categoryKey: "dentista",
              citySlug: province.citySlug,
              licenseNumber: numcol,
              website: `${BASE}/detail.php?numcol=${encodeURIComponent(numcol)}`,
              metadata: {
                country: "ES",
                authority: "CGCD",
                colegio: "CGCD",
                colegio_provincial: province.name,
                numero_colegiado: numcol,
                provincia_id: province.id,
                verified_by_authority: true,
                detail_url: `${BASE}/detail.php?numcol=${encodeURIComponent(numcol)}`,
              },
            }),
          );
          collected += 1;
          if (out.length >= limit) break outer;
        }
        if (rows.length < PAGE_SIZE) break;
        await delay(REQUEST_DELAY_MS);
      }
    } catch (error) {
      console.error(
        `[guiadentistas-es] ${province.name} fetch failed: ${(error as Error).message}`,
      );
    }
    console.log(
      `[guiadentistas-es] ${province.name} → ${collected} rows${
        totalReported !== undefined ? ` (reported ${totalReported})` : ""
      }`,
    );
    await delay(REQUEST_DELAY_MS);
  }
  return out;
}

export const guiadentistasEsSource: ScraperSource = {
  name: "guiadentistas-es" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_GUIADENTISTAS_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runGuiadentistasEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!guiadentistasEsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_GUIADENTISTAS_ES_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    console.log("[guiadentistas-es] no records fetched");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[guiadentistas-es] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
