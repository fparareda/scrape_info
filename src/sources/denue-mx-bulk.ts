import { inflateRawSync } from "node:zlib";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getCities } from "../cities.js";
import { getSink } from "../sink.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * DENUE MX BULK — INEGI's full Directorio Estadístico Nacional de
 * Unidades Económicas as per-state ZIP downloads. The other source
 * (`denue-mx.ts`) downloads the per-SCIAN-sector archives and lands
 * ~38k after dedup; this source downloads ONE ZIP PER ESTADO (32
 * archives) and ingests ~5M rows nationwide — then filters to SCIAN
 * codes mapped to Prolio categories. Practical yield is ~400-700k MX
 * rows: every barbershop, taquería, tienda etc. is in DENUE, but we
 * only emit the professional services subset.
 *
 * Distribution discovered 2026-05-18 (URLs verified live with HEAD
 * requests, no auth required, no UA gating beyond the default headers):
 *
 *   https://www.inegi.org.mx/contenidos/masiva/denue/denue_<NN>_csv.zip
 *
 * Where <NN> is the 2-digit INEGI clave de entidad federativa (01
 * Aguascalientes … 32 Zacatecas). State 15 (México) is split because
 * the archive exceeds the 50 MB single-file budget and ships as
 * `denue_15_1_csv.zip` + `denue_15_2_csv.zip`. The unified
 * `denue_00_csv.zip` returns a 2.2 KB HTML placeholder — DO NOT use
 * it; it's been a stub for years.
 *
 * Files are Latin-1 CSV ("," sep) inside each ZIP, named
 * `conjunto_de_datos/denue_inegi_<NN>_.csv`. Columns include:
 *   id, clee, nom_estab, raz_social, codigo_act (SCIAN 6-digit),
 *   nombre_act, per_ocu, tipo_vial, nom_vial, num_ext, cod_postal,
 *   municipio, entidad, telefono, correoelec, www, latitud, longitud, …
 *
 * `clee` is INEGI's stable national identifier (Clave Única del
 * Establecimiento), 14 chars: SCIAN + entidad + serie. Used as
 * sourceId for stability across DENUE refreshes.
 *
 * The CSV is huge for big states (BC, Edomex, CDMX, Jalisco, Nuevo
 * León) — 200+ MB inflated each. We process them one state at a time
 * and never keep more than one state's CSV in memory.
 *
 * Off by default. `PROLIO_RUN_DENUE_MX_BULK=true` enables. Cap with
 * `PROLIO_DENUE_MX_BULK_LIMIT` (default 800000 rows global cap). Override
 * the state list with `PROLIO_DENUE_MX_BULK_STATES="09,15,14"` etc.
 *
 * License: INEGI open data — free reuse with attribution.
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const DEFAULT_LIMIT = 800_000;
const BASE_URL = "https://www.inegi.org.mx/contenidos/masiva/denue";

/**
 * INEGI publishes Estado 15 (México) split into two parts because the
 * archive exceeds the 50 MB-ish single-file budget. Every other state
 * is a single file at `denue_<NN>_csv.zip`.
 */
const SPLIT_STATES: Record<string, number[]> = {
  "15": [1, 2],
};

function urlsForState(cve: string): string[] {
  const parts = SPLIT_STATES[cve];
  if (!parts) return [`${BASE_URL}/denue_${cve}_csv.zip`];
  return parts.map((n) => `${BASE_URL}/denue_${cve}_${n}_csv.zip`);
}

/**
 * SCIAN 2018 → Prolio category. Strategy:
 *   1. EXACT-MATCH map first (high-precision codes).
 *   2. PREFIX rules cascade after (e.g. 621* → medicina, 5419* →
 *      consultoría profesional).
 *
 * The exact map mirrors `denue-mx.ts` + `denue-mx-trades.ts` so this
 * source is independently runnable, plus the extensions specified for
 * the bulk run (621* family, 461160 farmacias, 5413xx etc.).
 */
const SCIAN_EXACT: Record<string, CategoryKey> = {
  // Sector 23 — Construcción
  "238210": "electricidad",
  "238221": "fontaneria",
  "238222": "hvac",
  "238223": "fontaneria",
  "238350": "carpinteria",
  "238110": "carpinteria",
  "238121": "electricidad",
  "238122": "electricidad",
  "238130": "carpinteria",
  "238190": "carpinteria",
  "238290": "fontaneria",
  "238310": "carpinteria",
  "238320": "carpinteria",
  "238330": "carpinteria",
  "238340": "carpinteria",
  "238390": "carpinteria",

  // Sector 33 — fabricación muebles
  "337110": "carpinteria",
  "337120": "carpinteria",
  "337210": "carpinteria",
  "337910": "carpinteria",
  "337920": "carpinteria",

  // Sector 46 — Comercio retail (farmacias)
  "464111": "farmacia",
  "464112": "farmacia",
  "461160": "farmacia", // alt code in some SCIAN revisions

  // Sector 54 — Servicios profesionales
  "541110": "abogado",   // Bufetes jurídicos / notarios (CDMX usa 541120 para notaría pública)
  "541120": "notario",
  "541190": "abogado",
  "541211": "fiscal",
  "541212": "fiscal",
  "541219": "fiscal",
  "541310": "arquitecto",
  "541320": "arquitecto",
  "541330": "ingenieria",
  "541340": "ingenieria",
  "541350": "ingenieria",
  "541360": "ingenieria",
  "541370": "ingenieria",
  "541380": "ingenieria",
  "541410": "arquitecto", // diseño de interiores
  "541420": "arquitecto", // diseño industrial
  "541430": "arquitecto", // diseño gráfico → arquitecto bucket (visual)
  "541510": "ingenieria", // servicios de cómputo
  "541620": "ingenieria", // consultoría ambiental
  "541690": "ingenieria", // otros consultores científicos/técnicos
  "541910": "fiscal",     // investigación de mercados
  "541920": "fiscal",
  "541930": "fiscal",
  "541940": "veterinario",
  "541990": "fiscal",     // otros servicios profesionales

  // Sector 56 — Servicios administrativos
  "561621": "cerrajero",

  // Sector 62 — Servicios de salud (covered by 621* prefix below but
  // we keep explicit entries for unmistakable codes).
  "621211": "dentista",
  "621212": "dentista",
  "621331": "psicologia",
  "621311": "psicologia", // alt code en algunas revisiones
  "621398": "fisioterapia",
  "621399": "fisioterapia",
  "621511": "medicina", // laboratorios clínicos
  "621512": "medicina", // diagnóstico por imagen
  "621610": "enfermeria", // servicios de atención domiciliaria
  "621991": "enfermeria",
  "621992": "enfermeria",

  // Sector 81 — talleres mecánicos + reparación
  "811111": "mecanica",
  "811112": "mecanica",
  "811113": "mecanica",
  "811114": "mecanica",
  "811115": "mecanica",
  "811116": "mecanica",
  "811119": "mecanica",
  "811121": "mecanica",
  "811122": "mecanica",
  "811211": "electricidad",
  "811219": "electricidad",
  "811311": "mecanica",
  "811312": "mecanica",
  "811412": "fontaneria",
  "811420": "carpinteria",
  "811430": "cerrajero",
  "811490": "mecanica",

  // Sector 48-49 — verificación vehicular
  "488410": "itv",
};

/**
 * Prefix-based fallback. Order matters — first match wins.
 */
const SCIAN_PREFIXES: Array<[string, CategoryKey]> = [
  // Consultorios de medicina general + especialidades (62111x..62119x)
  ["62111", "medicina"],
  ["62112", "medicina"],
  ["62113", "medicina"],
  ["62114", "medicina"],
  ["62115", "medicina"],
  ["62116", "medicina"],
  ["62117", "medicina"],
  ["62118", "medicina"],
  ["62119", "medicina"],
  // Hospitales + asilos (sub-rama 622-623)
  ["622", "medicina"],
  ["623", "medicina"],
  // Otros servicios profesionales 5419x
  ["5419", "fiscal"],
];

function categoryForScian(scian: string): CategoryKey | null {
  if (!scian) return null;
  const exact = SCIAN_EXACT[scian];
  if (exact) return exact;
  for (const [prefix, category] of SCIAN_PREFIXES) {
    if (scian.startsWith(prefix)) return category;
  }
  return null;
}

/**
 * DENUE municipio labels in CSVs are uppercase Spanish ("GUADALAJARA",
 * "SAN PEDRO TLAQUEPAQUE"). Slugify, then alias, then validate against
 * the seeded MX cities. Anything unresolved falls back to the state's
 * largest seeded metro via _mx-states.ts.
 */
const DENUE_LABEL_TO_SLUG: Record<string, string> = {
  "ciudad-de-mexico": "cdmx",
  "distrito-federal": "cdmx",
  merida: "merida-mx",
  leon: "leon-mx",
  veracruz: "veracruz-mx",
  cordoba: "cordoba-mx",
  salamanca: "salamanca-mx",
  zamora: "zamora-mx",
  tonala: "tonala-jal",
  guadalupe: "guadalupe-nl",
  "santa-catarina": "santa-catarina-nl",
  juarez: "juarez-nl",
  garcia: "garcia-nl",
  cuautla: "cuautla-mor",
  "la-paz": "la-paz-mx",
  victoria: "victoria-tam",
  altamira: "altamira-tam",
  "ciudad-madero": "madero-tam",
  "san-pedro-tlaquepaque": "tlaquepaque",
  "tlajomulco-de-zuniga": "tlajomulco",
  "tepatitlan-de-morelos": "tepatitlan",
  "ecatepec-de-morelos": "ecatepec",
  "atizapan-de-zaragoza": "atizapan",
  "coacalco-de-berriozabal": "coacalco",
  "tlalnepantla-de-baz": "tlalnepantla",
  "valle-de-chalco-solidaridad": "valle-de-chalco",
  "naucalpan-de-juarez": "naucalpan",
  "cuautitlan-izcalli": "cuautitlan-izcalli",
  cajeme: "ciudad-obregon",
  ahome: "los-mochis",
  "hidalgo-del-parral": "parral",
  "general-escobedo": "escobedo",
  "san-nicolas-de-los-garza": "san-nicolas",
  "cuajimalpa-de-morelos": "cuajimalpa",
  "la-magdalena-contreras": "magdalena-contreras",
  "oaxaca-de-juarez": "oaxaca",
  "tuxtla-gutierrez": "tuxtla-gutierrez",
};

/**
 * State CVE → estado short name (for state-capital fallback via
 * mxStateToCity). DENUE encodes `cve_ent` as the leading 2 digits of
 * `clee`, plus an `entidad` column with the readable label.
 */
const STATE_CVE_TO_NAME: Record<string, string> = {
  "01": "aguascalientes",
  "02": "baja-california",
  "03": "baja-california-sur",
  "04": "campeche",
  "05": "coahuila",
  "06": "colima",
  "07": "chiapas",
  "08": "chihuahua",
  "09": "ciudad-de-mexico",
  "10": "durango",
  "11": "guanajuato",
  "12": "guerrero",
  "13": "hidalgo",
  "14": "jalisco",
  "15": "estado-de-mexico",
  "16": "michoacan",
  "17": "morelos",
  "18": "nayarit",
  "19": "nuevo-leon",
  "20": "oaxaca",
  "21": "puebla",
  "22": "queretaro",
  "23": "quintana-roo",
  "24": "san-luis-potosi",
  "25": "sinaloa",
  "26": "sonora",
  "27": "tabasco",
  "28": "tamaulipas",
  "29": "tlaxcala",
  "30": "veracruz",
  "31": "yucatan",
  "32": "zacatecas",
};

let MX_CITY_SLUGS_CACHE: Set<string> | undefined;

async function ensureMxCitySlugs(): Promise<Set<string>> {
  if (MX_CITY_SLUGS_CACHE) return MX_CITY_SLUGS_CACHE;
  const cities = await getCities({ country: "MX" });
  MX_CITY_SLUGS_CACHE = new Set(cities.map((c) => c.slug));
  return MX_CITY_SLUGS_CACHE;
}

function resolveCitySlug(
  municipio: string,
  cveEnt: string,
  valid: Set<string>,
): string | null {
  const slug = slugify(municipio);
  if (slug) {
    const aliased = DENUE_LABEL_TO_SLUG[slug];
    if (aliased && valid.has(aliased)) return aliased;
    if (valid.has(slug)) return slug;
  }
  // Fallback to state capital.
  const stateName = STATE_CVE_TO_NAME[cveEnt];
  if (!stateName) return null;
  const stateCity = mxStateToCity(stateName);
  if (stateCity && valid.has(stateCity)) return stateCity;
  return null;
}

// --- Minimal ZIP central-dir parser (local copy — keeps source self-contained) ---

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
}

function findEndOfCentralDir(buf: Buffer): number {
  const SIG = 0x06054b50;
  const startSearch = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= startSearch; i -= 1) {
    if (buf.readUInt32LE(i) === SIG) return i;
  }
  return -1;
}

function parseCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDir(buf);
  if (eocd < 0) return [];
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let off = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const fnLen = buf.readUInt16LE(off + 28);
    const exLen = buf.readUInt16LE(off + 30);
    const ccLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + fnLen).toString("utf8");
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      method,
      localHeaderOffset,
    });
    off += 46 + fnLen + exLen + ccLen;
  }
  return entries;
}

function readZipEntryData(buf: Buffer, entry: ZipEntry): Buffer | null {
  let lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
  const fnLen = buf.readUInt16LE(lh + 26);
  const exLen = buf.readUInt16LE(lh + 28);
  lh += 30 + fnLen + exLen;
  const slice = buf.slice(lh, lh + entry.compressedSize);
  if (entry.method === 0) return slice;
  if (entry.method === 8) {
    try {
      return inflateRawSync(slice, { maxOutputLength: 512 * 1024 * 1024 });
    } catch (e) {
      console.warn(
        `[denue-mx-bulk] inflate failed for ${entry.name}: ${(e as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

// DENUE CSVs are Latin-1.
const LATIN1 = new TextDecoder("latin1");

async function fetchZip(url: string): Promise<Buffer | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      signal: AbortSignal.timeout(600_000),
      redirect: "follow",
    });
  } catch (error) {
    console.error(
      `[denue-mx-bulk] network error on ${url}: ${(error as Error).message}`,
    );
    return null;
  }
  if (!response.ok) {
    console.warn(`[denue-mx-bulk] ${response.status} on ${url}`);
    return null;
  }
  const ab = await response.arrayBuffer();
  if (ab.byteLength < 4096) {
    console.warn(
      `[denue-mx-bulk] suspiciously small response (${ab.byteLength}B) on ${url} — likely HTML stub`,
    );
    return null;
  }
  const buf = Buffer.from(ab);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    console.warn(`[denue-mx-bulk] not a ZIP magic on ${url}`);
    return null;
  }
  return buf;
}

/**
 * Streaming-ish CSV iterator. We DON'T load the whole CSV string then
 * split — instead we walk the Buffer byte-by-byte tracking quote state
 * and line breaks, decoding each row Latin-1 → UTF-8 as it's emitted.
 * This keeps peak heap to ~1 row's worth of strings after the inflated
 * Buffer is allocated.
 *
 * `handleRow(cells)` returns false to stop early.
 */
function iterateCsvRows(
  bytes: Buffer,
  handleRow: (cells: string[]) => boolean,
): { rows: number } {
  // INEGI DENUE CSVs are "," separated, quoted fields, \r\n line endings.
  // Some rows contain embedded \n inside quoted fields (rare but real).
  let cur = ""; // current field as Latin-1-decoded string
  let inQuotes = false;
  let row: string[] = [];
  let header: string[] | null = null;
  let rowCount = 0;
  let stop = false;

  // Strip UTF-8 BOM if accidentally present (DENUE usually Latin-1 but be safe).
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  }

  // We decode one byte at a time as Latin-1 (each byte is one codepoint
  // in iso-8859-1, so this is safe). The full TextDecoder("latin1") above
  // is only used for header sanity-checks.
  const finishRow = (): boolean => {
    row.push(cur);
    cur = "";
    if (!header) {
      header = row.map((c) =>
        c
          .replace(/^﻿/, "")
          .trim()
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, ""),
      );
      row = [];
      return true;
    }
    // Pad/trim to header width.
    while (row.length < header.length) row.push("");
    rowCount += 1;
    const keep = handleRow(row);
    row = [];
    if (!keep) return false;
    return true;
  };

  for (let i = start; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (inQuotes) {
      if (b === 0x22) {
        // could be "" escape
        if (i + 1 < bytes.length && bytes[i + 1] === 0x22) {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += String.fromCharCode(b);
      }
    } else {
      if (b === 0x22) {
        inQuotes = true;
      } else if (b === 0x2c) {
        row.push(cur);
        cur = "";
      } else if (b === 0x0a || b === 0x0d) {
        // CR, LF, or CRLF — only emit on the first line-terminator byte
        if (cur.length > 0 || row.length > 0) {
          if (!finishRow()) {
            stop = true;
            break;
          }
        }
        // skip the paired LF if this was CR
        if (b === 0x0d && i + 1 < bytes.length && bytes[i + 1] === 0x0a) i += 1;
      } else {
        cur += String.fromCharCode(b);
      }
    }
  }
  // Final row if no trailing newline.
  if (!stop && (cur.length > 0 || row.length > 0)) finishRow();

  return { rows: rowCount };
}

function findHeaderIndex(header: string[], candidates: string[]): number {
  for (const c of candidates) {
    const idx = header.indexOf(c);
    if (idx >= 0) return idx;
  }
  // Substring fallback.
  for (const c of candidates) {
    const idx = header.findIndex((h) => h.includes(c));
    if (idx >= 0) return idx;
  }
  return -1;
}

interface ColMap {
  id: number;
  clee: number;
  nom_estab: number;
  raz_social: number;
  codigo_act: number;
  nombre_act: number;
  per_ocu: number;
  tipo_vial: number;
  nom_vial: number;
  num_ext: number;
  cod_postal: number;
  municipio: number;
  entidad: number;
  telefono: number;
  correoelec: number;
  www: number;
  latitud: number;
  longitud: number;
}

function buildColMap(header: string[]): ColMap {
  return {
    id: findHeaderIndex(header, ["id"]),
    clee: findHeaderIndex(header, ["clee"]),
    nom_estab: findHeaderIndex(header, ["nom_estab", "nombre"]),
    raz_social: findHeaderIndex(header, ["raz_social", "razon_social"]),
    codigo_act: findHeaderIndex(header, ["codigo_act", "codigo_actividad"]),
    nombre_act: findHeaderIndex(header, ["nombre_act", "actividad"]),
    per_ocu: findHeaderIndex(header, ["per_ocu", "per_ocupado"]),
    tipo_vial: findHeaderIndex(header, ["tipo_vial"]),
    nom_vial: findHeaderIndex(header, ["nom_vial", "nom_v_e"]),
    num_ext: findHeaderIndex(header, ["numero_ext", "num_ext"]),
    cod_postal: findHeaderIndex(header, ["cod_postal", "cp"]),
    municipio: findHeaderIndex(header, ["municipio", "nom_mun"]),
    entidad: findHeaderIndex(header, ["entidad", "nom_entidad"]),
    telefono: findHeaderIndex(header, ["telefono", "tel"]),
    correoelec: findHeaderIndex(header, ["correoelec", "correo_elec"]),
    www: findHeaderIndex(header, ["www", "sitio_internet"]),
    latitud: findHeaderIndex(header, ["latitud"]),
    longitud: findHeaderIndex(header, ["longitud"]),
  };
}

function pickCell(row: string[], idx: number): string {
  if (idx < 0 || idx >= row.length) return "";
  return row[idx]?.trim() ?? "";
}

function parseLatLng(raw: string): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(",", ".").trim();
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

async function processState(
  cve: string,
  remaining: number,
  validSlugs: Set<string>,
  seen: Set<string>,
  emit: (rec: ScrapedProfessional) => void,
): Promise<{ inspected: number; kept: number }> {
  let inspected = 0;
  let kept = 0;
  for (const url of urlsForState(cve)) {
    if (remaining - kept <= 0) break;
    const zipBuf = await fetchZip(url);
    if (!zipBuf) continue;
    const entries = parseCentralDirectory(zipBuf);
    const dataEntry = entries
      .filter(
        (e) =>
          e.name.toLowerCase().endsWith(".csv") &&
          !/diccionario/i.test(e.name),
      )
      .sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0];
    if (!dataEntry) {
      console.warn(
        `[denue-mx-bulk] state ${cve}: no data CSV in ${url} — entries=${entries.map((e) => e.name).join(", ")}`,
      );
      continue;
    }
    const csvBytes = readZipEntryData(zipBuf, dataEntry);
    if (!csvBytes) continue;
    console.log(
      `[denue-mx-bulk] state ${cve}: csv=${dataEntry.name} ${(csvBytes.length / 1024 / 1024).toFixed(1)} MB`,
    );

    let header: string[] | null = null;
    let cols: ColMap | null = null;
    let stopped = false;

    iterateCsvRows(csvBytes, (row) => {
      if (!header) {
        header = row.map((c) =>
          c
            .replace(/^﻿/, "")
            .trim()
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, ""),
        );
        cols = buildColMap(header);
        return true;
      }
      inspected += 1;
      if (kept >= remaining) {
        stopped = true;
        return false;
      }
      if (!cols) return false;
      const scian = pickCell(row, cols.codigo_act);
      const category = categoryForScian(scian);
      if (!category) return true;

      const clee = pickCell(row, cols.clee) || pickCell(row, cols.id);
      if (!clee) return true;
      const sourceKey = `denue-bulk:${clee}`;
      if (seen.has(sourceKey)) return true;

      const municipio = pickCell(row, cols.municipio);
      const citySlug = resolveCitySlug(municipio, cve, validSlugs);
      if (!citySlug) return true;

      const name =
        pickCell(row, cols.nom_estab) || pickCell(row, cols.raz_social);
      if (!name) return true;

      seen.add(sourceKey);

      const street = [
        pickCell(row, cols.tipo_vial),
        pickCell(row, cols.nom_vial),
        pickCell(row, cols.num_ext),
      ]
        .filter(Boolean)
        .join(" ");
      const cp = pickCell(row, cols.cod_postal);
      const entidad = pickCell(row, cols.entidad);
      const address = [street, cp, municipio, entidad]
        .filter(Boolean)
        .join(", ");

      const lat = parseLatLng(pickCell(row, cols.latitud));
      const lng = parseLatLng(pickCell(row, cols.longitud));

      emit(
        normalise({
          source: "denue-mx-bulk",
          sourceId: sourceKey,
          name,
          categoryKey: category,
          citySlug,
          phone: pickCell(row, cols.telefono) || undefined,
          email: pickCell(row, cols.correoelec) || undefined,
          website: pickCell(row, cols.www) || undefined,
          address: address || undefined,
          lat: lat && Math.abs(lat) <= 90 ? lat : undefined,
          lng: lng && Math.abs(lng) <= 180 ? lng : undefined,
          metadata: {
            country: "MX",
            authority: "INEGI / DENUE (bulk)",
            scian,
            actividad: pickCell(row, cols.nombre_act) || undefined,
            tamano: pickCell(row, cols.per_ocu) || undefined,
            entidad: entidad || undefined,
            municipio: municipio || undefined,
            cve_ent: cve,
            clee,
          },
        }),
      );
      kept += 1;
      return true;
    });

    console.log(
      `[denue-mx-bulk] state ${cve}: inspected=${inspected} kept_so_far=${kept} stopped=${stopped}`,
    );
    if (stopped) break;
  }
  return { inspected, kept };
}

async function extract(limit: number): Promise<ScrapedProfessional[]> {
  const validSlugs = await ensureMxCitySlugs();
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  const overrideStates = process.env.PROLIO_DENUE_MX_BULK_STATES?.trim();
  const stateList = overrideStates
    ? overrideStates
        .split(/[,\s]+/)
        .map((s) => s.padStart(2, "0"))
        .filter((s) => STATE_CVE_TO_NAME[s])
    : Object.keys(STATE_CVE_TO_NAME);

  let inspectedTotal = 0;
  for (const cve of stateList) {
    if (out.length >= limit) break;
    const remaining = limit - out.length;
    const { inspected } = await processState(
      cve,
      remaining,
      validSlugs,
      seen,
      (rec) => out.push(rec),
    );
    inspectedTotal += inspected;
  }

  console.log(
    `[denue-mx-bulk] all states done — inspected=${inspectedTotal} kept=${out.length} unique_ids=${seen.size}`,
  );
  return out;
}

export const denueMxBulkSource: ScraperSource = {
  name: "denue-mx-bulk",
  enabled() {
    return process.env.PROLIO_RUN_DENUE_MX_BULK === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runDenueMxBulk(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!denueMxBulkSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_DENUE_MX_BULK_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await extract(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  // Chunked upsert — 800k rows in a single sink.upsert() would blow
  // memory for the conflict-resolution maps; flush every 25k.
  const sink = getSink();
  const CHUNK = 25_000;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const slice = records.slice(i, i + CHUNK);
    const res = await sink.upsert(slice);
    inserted += res.inserted;
    updated += res.updated;
    skipped += res.skipped;
    console.log(
      `[denue-mx-bulk] flushed ${i + slice.length}/${records.length} — inserted+=${res.inserted} updated+=${res.updated} skipped+=${res.skipped}`,
    );
  }

  console.log(
    `[denue-mx-bulk] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
