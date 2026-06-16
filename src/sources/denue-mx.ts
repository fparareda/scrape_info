import { inflateRawSync } from "node:zlib";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getCities } from "../cities.js";
import { getSink } from "../sink.js";

/**
 * DENUE — Directorio Estadístico Nacional de Unidades Económicas
 * (INEGI). The single biggest open MX source: ~5M businesses with
 * name, address, phone, email (when registered), SCIAN code,
 * municipality, geolocation. License: free reuse per INEGI's open
 * data terms.
 *
 * Distribution: per-SCIAN-sector ZIP archives at
 * https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_<sector>_csv.zip
 * Each archive bundles a `diccionario_de_datos/...csv` (schema doc)
 * plus the actual data file `conjunto_de_datos/denue_inegi_<sector>.csv`.
 * Files use Latin-1; we decode and re-emit as UTF-8.
 *
 * SCIAN sector → Prolio category map:
 *   23 (Construcción)  → electricidad/fontaneria/carpinteria/hvac
 *   54 (Servicios profesionales) → fiscal/extranjeria/notario/arquitecto
 *   56 (Servicios administrativos) → cerrajero
 *   62 (Servicios de salud)        → medicina/dentista/psicologia/fisioterapia
 *
 * Sector 81 (mecánica + veterinarios) is intentionally OFF for v1 —
 * those archives are 80+ MB combined and SENASICA already covers
 * authorised vets. Add later if yield demands it.
 *
 * Off by default. `PROLIO_RUN_DENUE_MX=true` enables. Cap with
 * `PROLIO_DENUE_MX_LIMIT` (default 10000 across all sectors). On a
 * full run all seven archives total ~60 MB compressed / ~250 MB CSV.
 *
 * PERFORMANCE (fixed 2026-06-16): each sector ZIP inflates to a CSV of
 * millions of rows. The original implementation called `parseCsv()`
 * from `_bulk-utils`, which materialises the WHOLE CSV into an array of
 * `Record<string,string>` (every column for every row) BEFORE any
 * filtering — so a single run allocated hundreds of MB per sector and
 * spent all its time in GC, never finishing inside the 4h job budget.
 * We now stream each CSV row-by-row (local `iterateCsvRows`, mirroring
 * `denue-mx-bulk.ts`), stop the moment the per-run cap is hit, and
 * flush each sector's kept rows to the sink immediately so a cancelled
 * run still persists partial progress instead of redoing everything.
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const DEFAULT_LIMIT = 10_000;

interface DenueSector {
  url: string;
  /** Short label for logs. */
  label: string;
}

const DENUE_SECTORS: DenueSector[] = [
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_23_csv.zip",
    label: "23-construccion",
  },
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_54_csv.zip",
    label: "54-servicios-profesionales",
  },
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_56_csv.zip",
    label: "56-servicios-administrativos",
  },
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_62_csv.zip",
    label: "62-servicios-salud",
  },
  // Sector 81 (Otros servicios) split in two due to size — added 2026-05-07.
  // Carries 811111 (mecánica), 811211 (electrónica), 811219 (otros).
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_81_1_csv.zip",
    label: "81-1-otros-servicios-parte-1",
  },
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_81_2_csv.zip",
    label: "81-2-otros-servicios-parte-2",
  },
  // Sector 48-49 (Transporte) — carries 488410 (centros de verificación
  // vehicular = ITV equivalent en MX).
  {
    url: "https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_48-49_csv.zip",
    label: "48-49-transporte",
  },
];

/**
 * SCIAN 2018 (MX) 6-digit codes → Prolio category. The DENUE CSV
 * carries `codigo_act` as a 6-digit string. Matching is exact —
 * unmapped codes are dropped.
 */
const SCIAN_TO_CATEGORY: Record<string, CategoryKey> = {
  // Sector 23 — Construcción
  "238210": "electricidad",   // Instalaciones eléctricas en construcciones
  "238221": "fontaneria",      // Plomería en construcciones
  "238222": "fontaneria",      // Aire acondicionado y calefacción (lumped — closest to fontaneria/hvac)
  "238223": "fontaneria",      // Otras instalaciones especializadas para edificios
  "238350": "carpinteria",     // Trabajos de carpintería en construcciones

  // Sector 54 — Servicios profesionales, científicos y técnicos
  // Bufetes jurídicos and other legal services map to `abogado` — the
  // dedicated extranjería sub-specialty is rarely SCIAN-coded, so we
  // emit the parent category and let category-specific scrapers
  // (immigration bars, CGE) handle the niche.
  "541110": "abogado",         // Bufetes jurídicos
  "541120": "notario",         // Notarías públicas
  "541190": "abogado",         // Otros servicios legales
  "541211": "fiscal",          // Servicios de contabilidad y auditoría
  "541219": "fiscal",          // Otros servicios relacionados con contabilidad
  "541310": "arquitecto",      // Servicios de arquitectura
  "541320": "arquitecto",      // Servicios de arquitectura del paisaje y urbanismo
  "541940": "veterinario",     // Servicios veterinarios

  // Sector 56 — Servicios de apoyo a los negocios
  "561621": "cerrajero",       // Servicios de cerrajería

  // Sector 62 — Servicios de salud
  "621111": "medicina",        // Consultorios de medicina general
  "621112": "medicina",        // Consultorios de especialistas en medicina interna
  "621113": "medicina",        // Consultorios de especialistas en pediatría
  "621114": "medicina",        // Consultorios de especialistas en gineco-obstetricia
  "621115": "medicina",        // Consultorios de especialistas en cardiología
  "621116": "medicina",        // Consultorios de especialistas en oftalmología
  "621117": "medicina",        // Consultorios de especialistas en otorrinolaringología
  "621118": "medicina",        // Consultorios de especialistas en traumatología/ortopedia
  "621119": "medicina",        // Consultorios de otros especialistas
  "621211": "dentista",        // Consultorios dentales del sector privado
  "621212": "dentista",        // Consultorios dentales del sector público
  "621331": "psicologia",      // Consultorios de psicólogos
  "621398": "fisioterapia",    // Consultorios de otros profesionales de la salud (incl. fisio)
  "621399": "fisioterapia",    // (alt code in some SCIAN revisions)

  // Sector 81 — Otros servicios (added 2026-05-07)
  "811111": "mecanica",        // Reparación mecánica en general de automóviles y camiones
  "811112": "mecanica",        // Reparación del sistema eléctrico de automóviles y camiones
  "811113": "mecanica",        // Rectificación de partes de motor de automóviles y camiones
  "811114": "mecanica",        // Reparación de transmisiones de automóviles y camiones
  "811115": "mecanica",        // Reparación de suspensiones de automóviles y camiones
  "811116": "mecanica",        // Alineación y balanceo de automóviles y camiones
  "811119": "mecanica",        // Otras reparaciones mecánicas y eléctricas de automóviles
  "811121": "mecanica",        // Hojalatería y pintura de automóviles y camiones
  "811122": "mecanica",        // Tapicería de automóviles y camiones

  // Sector 48-49 — Transporte (added 2026-05-07). 488410 covers
  // Mexican vehicle inspection centres (equivalent to Spanish ITV).
  "488410": "itv",             // Servicios de centros de verificación vehicular

  // Sector 46 — Comercio retail (added 2026-05-18). DENUE doesn't list
  // independent farmacéuticos as a separate SCIAN, but every farmacia
  // retail unit is here — ~22k in MX. Classify the establishment as
  // `farmacia`; the owner's name + address comes from the row.
  "464111": "farmacia",        // Farmacias sin minisúper
  "464112": "farmacia",        // Farmacias con minisúper
};

/**
 * DENUE encodes the federal entity (estado) + municipio combined
 * into the field `municipio` as a label like "GUADALAJARA". The MX
 * cities seed uses ASCII slug, so slugify() does the rest. Some
 * common DENUE labels need explicit aliases.
 *
 * After migration 0074, the cities table holds the top-300 MX
 * municipios (~95% population coverage). Aliases below now mostly
 * redirect alternative spellings (e.g. "leon" → "leon-mx" because
 * the bare "leon" slug doesn't exist) and intra-MX same-name
 * disambiguations (e.g. "tonala-jal" vs "tonala-chis").
 */
const DENUE_LABEL_TO_SLUG: Record<string, string> = {
  // CDMX alcaldías now seeded individually as their own slugs
  // (iztapalapa, coyoacan, ...). Keep the legacy alias for the
  // generic "Ciudad de México" label.
  "ciudad-de-mexico": "cdmx",
  "distrito-federal": "cdmx",
  // Slugs that needed -mx suffix to avoid ES collisions
  "merida": "merida-mx",
  "leon": "leon-mx",
  "veracruz": "veracruz-mx",
  "cordoba": "cordoba-mx",
  "salamanca": "salamanca-mx",
  "zamora": "zamora-mx",
  // Intra-MX same-name disambiguations — DENUE label is bare,
  // but the seeded slug uses an estado suffix.
  "tonala": "tonala-jal",
  "guadalupe": "guadalupe-nl",
  "santa-catarina": "santa-catarina-nl",
  "juarez": "juarez-nl",
  "garcia": "garcia-nl",
  "cuautla": "cuautla-mor",
  "la-paz": "la-paz-mx",
  "guadalupe-victoria": "guadalupe-victoria-dgo",
  "lerdo": "lerdo-dgo",
  "victoria": "victoria-tam",
  "altamira": "altamira-tam",
  "ciudad-madero": "madero-tam",
  "rio-bravo": "rio-bravo-tam",
  "san-fernando": "san-fernando-tam",
  "matamoros-coahuila": "matamoros-coa",
  "frontera": "frontera-coa",
  "san-pedro": "san-pedro-coa",
  "sabinas": "sabinas-coa",
  "fortin": "cordoba-region",
  "cardenas": "cardenas-tab",
  "paraiso": "paraiso-tab",
  "alvarado": "alvarado-ver",
  "tuxpan": "tuxpan-ver",
  "compostela": "compostela-nay",
  "ayala": "ayala-mor",
  "emiliano-zapata": "emiliano-zapata-mor",
  "valladolid": "valladolid-yuc",
  "rosario": "rosario-sin",
  "el-salto": "el-salto", // Jalisco kept as bare; Durango variant is el-salto-dgo
  "nogales": "nogales-son",
  "san-luis-potosi": "san-luis-potosi",
  // Long-form variants → seeded canonical slug
  "san-pedro-tlaquepaque": "tlaquepaque",
  "tlajomulco-de-zuniga": "tlajomulco",
  "tepatitlan-de-morelos": "tepatitlan",
  "ecatepec-de-morelos": "ecatepec",
  "atizapan-de-zaragoza": "atizapan",
  "coacalco-de-berriozabal": "coacalco",
  "tlalnepantla-de-baz": "tlalnepantla",
  "valle-de-chalco-solidaridad": "valle-de-chalco",
  "naucalpan-de-juarez": "naucalpan",
  "san-andres-cholula": "san-andres-cholula",
  "san-pedro-cholula": "cholula",
  "cuautitlan-izcalli": "cuautitlan-izcalli",
  "huixquilucan-de-degollado": "huixquilucan",
  "tepotzotlan": "tepotzotlan",
  "cajeme": "ciudad-obregon",
  "ahome": "los-mochis",
  "hidalgo-del-parral": "parral",
  "general-escobedo": "escobedo",
  "san-nicolas-de-los-garza": "san-nicolas",
  "playas-de-rosarito": "rosarito",
  "cadereyta-jimenez": "cadereyta-nl",
  "cadereyta-de-montes": "cadereyta-qro",
  "ciudad-victoria": "victoria-tam",
  "cuajimalpa-de-morelos": "cuajimalpa",
  "la-magdalena-contreras": "magdalena-contreras",
  "lazaro-cardenas": "lazaro-cardenas",
  "oaxaca-de-juarez": "oaxaca",
  "juchitan-de-zaragoza": "juchitan",
  "huajuapan-de-leon": "huajuapan",
  "tlapa-de-comonfort": "tlapa",
  "chilapa-de-alvarez": "chilapa",
  "san-cristobal-de-las-casas": "san-cristobal-de-las-casas",
  "tuxtla-gutierrez": "tuxtla-gutierrez",
};

let MX_CITY_SLUGS_CACHE: Set<string> | undefined;

async function ensureMxCitySlugs(): Promise<Set<string>> {
  if (MX_CITY_SLUGS_CACHE) return MX_CITY_SLUGS_CACHE;
  const cities = await getCities({ country: "MX" });
  MX_CITY_SLUGS_CACHE = new Set(cities.map((c) => c.slug));
  return MX_CITY_SLUGS_CACHE;
}

function denueLabelToCitySlug(
  rawLabel: string,
  validSlugs: Set<string>,
): string | null {
  const slug = slugify(rawLabel);
  if (!slug) return null;
  const aliased = DENUE_LABEL_TO_SLUG[slug];
  if (aliased && validSlugs.has(aliased)) return aliased;
  return validSlugs.has(slug) ? slug : null;
}

// --- Minimal ZIP central-dir parser ------------------------------------
//
// We avoid pulling a third-party zip lib (project rule: minimise deps).
// DENUE archives are flat ZIPs (deflate, no encryption, ASCII names),
// so walking the End-of-Central-Directory record is enough.

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
}

function findEndOfCentralDir(buf: Buffer): number {
  // EOCD signature 0x06054b50, scan from end (max 64 KB comment).
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
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  void cdSize;
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
    entries.push({ name, compressedSize, uncompressedSize, method, localHeaderOffset });
    off += 46 + fnLen + exLen + ccLen;
  }
  return entries;
}

function readZipEntryData(buf: Buffer, entry: ZipEntry): Buffer | null {
  // Skip the local file header (variable length: 30 bytes + filename + extra)
  let lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
  const fnLen = buf.readUInt16LE(lh + 26);
  const exLen = buf.readUInt16LE(lh + 28);
  lh += 30 + fnLen + exLen;
  const slice = buf.slice(lh, lh + entry.compressedSize);
  if (entry.method === 0) return slice;
  if (entry.method === 8) {
    try {
      return inflateRawSync(slice);
    } catch (e) {
      console.warn(`[denue-mx] inflate failed for ${entry.name}: ${(e as Error).message}`);
      return null;
    }
  }
  console.warn(`[denue-mx] unsupported zip method ${entry.method} for ${entry.name}`);
  return null;
}

// DENUE CSVs are Latin-1; we decode byte-by-byte while streaming so we
// never hold the whole decoded string in memory.

async function fetchSectorCsvBytes(url: string): Promise<Buffer | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    console.error(`[denue-mx] download ${url}: ${(error as Error).message}`);
    return null;
  }
  if (!response.ok) {
    console.error(`[denue-mx] ${response.status} on ${url}`);
    return null;
  }
  const ab = await response.arrayBuffer();
  const buf = Buffer.from(ab);
  const entries = parseCentralDirectory(buf);
  // Pick the largest CSV that is NOT the "diccionario_de_datos" schema.
  const dataEntry = entries
    .filter(
      (e) =>
        e.name.toLowerCase().endsWith(".csv") &&
        !/diccionario/i.test(e.name),
    )
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0];
  if (!dataEntry) {
    console.error(`[denue-mx] no data CSV in archive — entries=${entries.map((e) => e.name).join(", ")}`);
    return null;
  }
  return readZipEntryData(buf, dataEntry);
}

// --- Streaming CSV row iterator (local copy — mirrors denue-mx-bulk.ts) ---
//
// Walks the inflated Buffer byte-by-byte, tracking quote state and line
// breaks, decoding each byte as Latin-1 (each byte is one iso-8859-1
// codepoint). Emits one row at a time via `handleRow`, which returns
// false to stop early. Peak heap stays at ~one row of strings on top of
// the inflated Buffer — instead of an array holding every parsed row.

function iterateCsvRows(
  bytes: Buffer,
  handleRow: (cells: string[]) => boolean,
): void {
  let cur = "";
  let inQuotes = false;
  let row: string[] = [];
  let stop = false;

  let start = 0;
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    start = 3;
  }

  const finishRow = (): boolean => {
    row.push(cur);
    cur = "";
    const keep = handleRow(row);
    row = [];
    return keep;
  };

  for (let i = start; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (inQuotes) {
      if (b === 0x22) {
        if (i + 1 < bytes.length && bytes[i + 1] === 0x22) {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += String.fromCharCode(b);
      }
    } else if (b === 0x22) {
      inQuotes = true;
    } else if (b === 0x2c) {
      row.push(cur);
      cur = "";
    } else if (b === 0x0a || b === 0x0d) {
      if (cur.length > 0 || row.length > 0) {
        if (!finishRow()) {
          stop = true;
          break;
        }
      }
      if (b === 0x0d && i + 1 < bytes.length && bytes[i + 1] === 0x0a) i += 1;
    } else {
      cur += String.fromCharCode(b);
    }
  }
  if (!stop && (cur.length > 0 || row.length > 0)) finishRow();
}

function normaliseHeaderCell(raw: string): string {
  return raw
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function findHeaderIndex(header: string[], candidates: string[]): number {
  for (const c of candidates) {
    const idx = header.indexOf(c);
    if (idx >= 0) return idx;
  }
  for (const c of candidates) {
    const idx = header.findIndex((h) => h.includes(c));
    if (idx >= 0) return idx;
  }
  return -1;
}

function cell(row: string[], idx: number): string {
  if (idx < 0 || idx >= row.length) return "";
  return row[idx]?.trim() ?? "";
}

interface SectorColMap {
  codigo_act: number;
  ident: number;
  ident_alt: number[];
  nom_estab: number;
  municipio: number;
  tipo_vial: number;
  nom_vial: number;
  num_ext: number;
  cod_postal: number;
  ciudad: number;
  telefono: number;
  correoelec: number;
  www: number;
  nombre_act: number;
  per_ocu: number;
  entidad: number;
}

function buildSectorColMap(header: string[]): SectorColMap {
  return {
    codigo_act: findHeaderIndex(header, ["codigo_act", "codigo_actividad"]),
    ident: findHeaderIndex(header, ["id"]),
    ident_alt: [
      findHeaderIndex(header, ["id_unidad"]),
      findHeaderIndex(header, ["clee"]),
    ].filter((i) => i >= 0),
    nom_estab: findHeaderIndex(header, [
      "nom_estab",
      "razon_social",
      "nombre",
      "nom_v_e",
    ]),
    municipio: findHeaderIndex(header, ["municipio", "nom_mun"]),
    tipo_vial: findHeaderIndex(header, ["tipo_vial"]),
    nom_vial: findHeaderIndex(header, ["nom_vial", "nom_v_e"]),
    num_ext: findHeaderIndex(header, ["numero_ext", "num_ext"]),
    cod_postal: findHeaderIndex(header, ["cod_postal", "cp"]),
    ciudad: findHeaderIndex(header, ["ciudad", "nom_ciudad"]),
    telefono: findHeaderIndex(header, ["telefono", "tel"]),
    correoelec: findHeaderIndex(header, ["correoelec", "correo_elec", "email"]),
    www: findHeaderIndex(header, ["www", "sitio_internet"]),
    nombre_act: findHeaderIndex(header, ["nombre_act", "actividad"]),
    per_ocu: findHeaderIndex(header, ["per_ocu", "per_ocupado"]),
    entidad: findHeaderIndex(header, ["entidad", "nom_entidad"]),
  };
}

/**
 * Stream-parse one sector ZIP and emit kept rows via `emit`. Stops as
 * soon as `remaining` rows have been kept. `seen` is shared across all
 * sectors so cross-sector duplicate DENUE ids are dropped. Returns the
 * number of rows kept from this sector.
 */
async function fetchSector(
  sector: DenueSector,
  remaining: number,
  validSlugs: Set<string>,
  seen: Set<string>,
  emit: (rec: ScrapedProfessional) => void,
): Promise<number> {
  if (remaining <= 0) return 0;
  const bytes = await fetchSectorCsvBytes(sector.url);
  if (!bytes) return 0;

  let cols: SectorColMap | null = null;
  let kept = 0;
  let inspected = 0;

  iterateCsvRows(bytes, (row) => {
    if (!cols) {
      cols = buildSectorColMap(row.map(normaliseHeaderCell));
      return true;
    }
    if (kept >= remaining) return false;
    inspected += 1;

    const scian = cell(row, cols.codigo_act);
    const category = SCIAN_TO_CATEGORY[scian];
    if (!category) return true;

    let ident = cell(row, cols.ident);
    if (!ident) {
      for (const alt of cols.ident_alt) {
        ident = cell(row, alt);
        if (ident) break;
      }
    }
    if (!ident) return true;

    const municipio = cell(row, cols.municipio);
    const citySlug = denueLabelToCitySlug(municipio, validSlugs);
    if (!citySlug) return true;

    if (seen.has(ident)) return true;

    const name = cell(row, cols.nom_estab);
    if (!name) return true;

    seen.add(ident);

    const street = [
      cell(row, cols.tipo_vial),
      cell(row, cols.nom_vial),
      cell(row, cols.num_ext),
    ]
      .filter(Boolean)
      .join(" ");
    const cp = cell(row, cols.cod_postal);
    const ciudad = cell(row, cols.ciudad) || municipio;
    const address = [street, cp, ciudad].filter(Boolean).join(", ");

    emit(
      normalise({
        source: "denue-mx",
        country: "MX",
        sourceId: `denue-mx:${ident}`,
        name,
        categoryKey: category,
        citySlug,
        phone: cell(row, cols.telefono) || undefined,
        email: cell(row, cols.correoelec) || undefined,
        website: cell(row, cols.www) || undefined,
        address: address || undefined,
        metadata: {
          country: "MX",
          authority: "INEGI / DENUE",
          scian,
          actividad: cell(row, cols.nombre_act) || undefined,
          tamano: cell(row, cols.per_ocu) || undefined,
          entidad: cell(row, cols.entidad) || undefined,
          municipio,
          ciudad,
        },
      }),
    );
    kept += 1;
    return true;
  });

  console.log(
    `[denue-mx] sector=${sector.label}: inspected=${inspected} kept=${kept}`,
  );
  return kept;
}

export const denueMxSource: ScraperSource = {
  name: "denue-mx",
  enabled() {
    return process.env.PROLIO_RUN_DENUE_MX === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runDenueMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!denueMxSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(process.env.PROLIO_DENUE_MX_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  // Stream-and-flush per sector: a sector's kept rows are upserted
  // immediately, so a timeout/cancellation still persists everything
  // processed up to that point instead of losing the whole run.
  const sink = getSink();
  const CHUNK = 25_000;
  const validSlugs = await ensureMxCitySlugs();
  const seen = new Set<string>();

  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const sector of DENUE_SECTORS) {
    if (fetched >= limit) break;
    const remaining = limit - fetched;
    const buffer: ScrapedProfessional[] = [];
    await fetchSector(sector, remaining, validSlugs, seen, (rec) =>
      buffer.push(rec),
    );
    if (buffer.length === 0) continue;
    for (let i = 0; i < buffer.length; i += CHUNK) {
      const res = await sink.upsert(buffer.slice(i, i + CHUNK));
      inserted += res.inserted;
      updated += res.updated;
      skipped += res.skipped;
    }
    fetched += buffer.length;
    console.log(
      `[denue-mx] sector=${sector.label} flushed — buffer=${buffer.length} total_inserted=${inserted} total_updated=${updated} total_skipped=${skipped}`,
    );
  }

  console.log(
    `[denue-mx] done — fetched=${fetched} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched, inserted, updated, skipped };
}
