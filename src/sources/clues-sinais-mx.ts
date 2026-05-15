import { inflateRawSync } from "node:zlib";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getCities } from "../cities.js";
import { getSink } from "../sink.js";

/**
 * CLUES — Clave Única de Establecimientos de Salud. National master
 * registry of every healthcare establishment in Mexico (public +
 * private): hospitals, clinics, laboratories, mobile units, DIF
 * centres, IMSS/ISSSTE units, Cruz Roja, etc. Maintained by the
 * Dirección General de Información en Salud (DGIS) of the Secretaría
 * de Salud. Monthly cuts ≈63k rows; the canonical bulk distribution
 * is an XLSX at gobi.salud.gob.mx/historico_clues/.
 *
 * Why this source matters for Prolio: it's the single authoritative
 * Mexican source for category=medicina venue addresses (consultorios,
 * hospitales, laboratorios). Beats DENUE for verified status because
 * every CLUES row is sanctioned by a state CLUES manager. Includes
 * lat/lng for almost every row.
 *
 * Distribution discovered 2026-05-15:
 *   - Landing: http://www.dgis.salud.gob.mx/contenidos/sinais/s_clues.html
 *   - Bulk:    https://gobi.salud.gob.mx/historico_clues/ESTABLECIMIENTO_SALUD_<YYYYMM>.xlsx
 * The DGIS subdomain has an expired SSL cert; gobi.salud.gob.mx serves
 * the actual files cleanly. The `historico.datos.gob.mx` CKAN API only
 * exposes state-level CLUES mirrors (Colima, Jalisco, etc.) — the
 * national master only lives at gobi.salud.gob.mx.
 *
 * License: per Secretaría de Salud open data ToS — reuse allowed with
 * attribution to DGIS.
 *
 * XLSX structure: single workbook, 3 sheets. Sheet1 carries the
 * national padrón (~63k rows × 68 columns). All cell values are
 * shared-string indices, so we decode the sharedStrings table once
 * then walk sheet1 row-by-row with a tag-stream parser.
 *
 * Header columns (sheet1 row 1) — 0-indexed:
 *   0  CLUES                            ← stable national id
 *   1  CLAVE DE LA INSTITUCION
 *   2  NOMBRE DE LA INSTITUCION         (e.g. "CRUZ ROJA MEXICANA")
 *   4  ENTIDAD                          (estado label)
 *   6  MUNICIPIO
 *   11 CLAVE DEL TIPO ESTABLECIMIENTO
 *   12 NOMBRE TIPO ESTABLECIMIENTO      (DE CONSULTA EXTERNA, etc.)
 *   13 CLAVE DE TIPOLOGIA
 *   14 NOMBRE DE TIPOLOGIA              (CPA, CRO, HOSPITAL, …)
 *   17 NOMBRE DE LA UNIDAD              ← real establishment name
 *   18 NOMBRE COMERCIAL
 *   20 TIPO DE VIALIDAD                 (CALLE / AVENIDA / …)
 *   21 VIALIDAD                         (street name)
 *   22 NUMERO EXTERIOR
 *   25 TIPO DE ASENTAMIENTO
 *   26 ASENTAMIENTO                     (colonia)
 *   27 CODIGO POSTAL
 *   30 ESTATUS DE OPERACION             ("EN OPERACION" / "FUERA DE OPERACION")
 *   32 TELEFONO 1 DEL ESTABLECIMIENTO
 *   58 LATITUD
 *   59 LONGITUD
 *
 * We only emit rows with ESTATUS DE OPERACION = "EN OPERACION".
 *
 * Off by default. `PROLIO_RUN_CLUES_SINAIS_MX=true` enables. Cap with
 * `PROLIO_CLUES_SINAIS_MX_LIMIT` (default 50000 — large enough for the
 * full padrón). Override the source URL with `PROLIO_CLUES_SINAIS_URL`
 * (e.g. to pin a specific month).
 */

const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const DEFAULT_LIMIT = 50_000;
const FALLBACK_MONTHS = 6; // walk back up to 6 months looking for the latest available cut

// Column indices (see header doc above).
const COL_CLUES = 0;
const COL_NOMBRE_INSTITUCION = 2;
const COL_ENTIDAD = 4;
const COL_MUNICIPIO = 6;
const COL_NOMBRE_TIPO = 12;
const COL_TIPOLOGIA = 14;
const COL_NOMBRE_UNIDAD = 17;
const COL_NOMBRE_COMERCIAL = 18;
const COL_TIPO_VIALIDAD = 20;
const COL_VIALIDAD = 21;
const COL_NUM_EXT = 22;
const COL_ASENTAMIENTO = 26;
const COL_CP = 27;
const COL_ESTATUS = 30;
const COL_TELEFONO = 32;
const COL_LATITUD = 58;
const COL_LONGITUD = 59;

// --- Minimal ZIP central-dir parser (copy of denue-mx's, kept local
//     so this source stays self-contained for future extraction). ----

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
      return inflateRawSync(slice, { maxOutputLength: 256 * 1024 * 1024 });
    } catch (e) {
      console.warn(
        `[clues-sinais-mx] inflate failed for ${entry.name}: ${(e as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

// --- Minimal XLSX parser ----------------------------------------------
//
// Stripped down to exactly what CLUES needs:
//   * shared strings → flat array (text only, no rich-text runs)
//   * sheet rows → array of cell-text indexed by 0-based column number
//
// We parse the XML with regex-driven walks rather than a full DOM
// because sheet1 is ~150 MB uncompressed and the spreadsheetml schema
// CLUES uses is the simple flavour (only `t="s"` shared-string cells
// and the occasional inline number for lat/lng). This matches the
// style of the other in-repo parsers (denue-mx, ca-dca-open-data) that
// avoid third-party deps.

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  // <si>…<t>foo</t>…</si>   |   <si>…<t/></si>   (empty)
  // A few rows in the wild split a value across multiple <t> runs
  // (rich text); concatenate them.
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  const tRe = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1];
    let value = "";
    let t: RegExpExecArray | null;
    tRe.lastIndex = 0;
    while ((t = tRe.exec(inner)) !== null) {
      if (t[1]) value += decodeXmlEntities(t[1]);
    }
    out.push(value);
  }
  return out;
}

function decodeXmlEntities(raw: string): string {
  // Hot path — only the five XML entities, no full HTML decode.
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

/**
 * Convert "AB12" → 27 (zero-based column index).
 */
function cellRefToColumnIndex(ref: string): number {
  let col = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break; // letters only
    col = col * 26 + (c - 64);
  }
  return col - 1;
}

interface SheetIterator {
  (handleRow: (cells: string[]) => boolean): void;
}

/**
 * Walk sheet XML and yield rows. `handleRow` returns false to stop
 * early (e.g. cap reached).
 */
function iterateSheetRows(xml: string, strings: string[]): SheetIterator {
  return (handleRow) => {
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    const cellRe =
      /<c\b\s+r="([^"]+)"(?:\s+s="[^"]*")?(?:\s+t="([^"]+)")?[^>]*>([\s\S]*?)<\/c>|<c\b\s+r="([^"]+)"(?:\s+[^>]*)?\/>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(xml)) !== null) {
      const rowXml = rm[1];
      const cells: string[] = [];
      cellRe.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rowXml)) !== null) {
        const ref = cm[1] ?? cm[4];
        if (!ref) continue;
        const colIdx = cellRefToColumnIndex(ref);
        if (colIdx < 0) continue;
        const type = cm[2];
        const inner = cm[3] ?? "";
        let value = "";
        if (inner) {
          // Pull <v>…</v> or <t>…</t> (inline string)
          const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (vMatch) {
            const raw = decodeXmlEntities(vMatch[1]);
            if (type === "s") {
              const idx = Number(raw);
              value = Number.isFinite(idx) ? strings[idx] ?? "" : "";
            } else {
              value = raw;
            }
          } else {
            const tMatch = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
            if (tMatch) value = decodeXmlEntities(tMatch[1]);
          }
        }
        cells[colIdx] = value;
      }
      if (cells.length === 0) continue;
      const keep = handleRow(cells);
      if (!keep) return;
    }
  };
}

// --- HTTP --------------------------------------------------------------

async function fetchXlsx(url: string): Promise<Buffer | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      signal: AbortSignal.timeout(300_000),
      redirect: "follow",
    });
  } catch (error) {
    console.error(
      `[clues-sinais-mx] network error on ${url}: ${(error as Error).message}`,
    );
    return null;
  }
  if (!response.ok) {
    console.warn(`[clues-sinais-mx] ${response.status} on ${url}`);
    return null;
  }
  const ab = await response.arrayBuffer();
  // Sanity check — server sometimes returns a 0-byte stub or an HTML
  // error wrapped in 200; the real XLSX always starts with "PK".
  if (ab.byteLength < 1024) return null;
  const buf = Buffer.from(ab);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return null;
  return buf;
}

function buildHistoricoUrl(yyyymm: string): string {
  return `https://gobi.salud.gob.mx/historico_clues/ESTABLECIMIENTO_SALUD_${yyyymm}.xlsx`;
}

function lastNMonths(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  // Start with the prior month — gobi publishes "al siguiente día hábil
  // del mes inmediato posterior", so the current month is rarely live.
  now.setUTCDate(1);
  now.setUTCMonth(now.getUTCMonth() - 1);
  for (let i = 0; i < n; i += 1) {
    const y = now.getUTCFullYear();
    const m = `${now.getUTCMonth() + 1}`.padStart(2, "0");
    out.push(`${y}${m}`);
    now.setUTCMonth(now.getUTCMonth() - 1);
  }
  return out;
}

async function downloadLatestCut(): Promise<Buffer | null> {
  const override = process.env.PROLIO_CLUES_SINAIS_URL;
  if (override) {
    console.log(`[clues-sinais-mx] using override URL ${override}`);
    return fetchXlsx(override);
  }
  for (const yyyymm of lastNMonths(FALLBACK_MONTHS)) {
    const url = buildHistoricoUrl(yyyymm);
    const buf = await fetchXlsx(url);
    if (buf) {
      console.log(
        `[clues-sinais-mx] downloaded ${yyyymm} cut (${(buf.length / 1024 / 1024).toFixed(1)} MB)`,
      );
      return buf;
    }
  }
  console.error(
    `[clues-sinais-mx] no available cut in last ${FALLBACK_MONTHS} months`,
  );
  return null;
}

// --- Municipio → city slug --------------------------------------------
//
// CLUES `MUNICIPIO` is the official INEGI municipio name (uppercase,
// accented). We slugify, then apply aliases — same approach as
// denue-mx, but the CLUES label corpus is narrower (no longform like
// "Tlajomulco de Zúñiga", because CLUES uses the INEGI short label).
//
// Anything that doesn't match a seeded MX city slug is dropped. The
// sink filters out unknown slugs silently in any case.

const MX_MUNI_ALIASES: Record<string, string> = {
  // CDMX alcaldías + legacy umbrella label
  "ciudad-de-mexico": "cdmx",
  "distrito-federal": "cdmx",
  // Slugs that need explicit -mx suffix in our cities seed (ES collisions)
  merida: "merida-mx",
  leon: "leon-mx",
  veracruz: "veracruz-mx",
  cordoba: "cordoba-mx",
  // Intra-MX same-name disambiguations seeded with state suffix
  tonala: "tonala-jal",
  guadalupe: "guadalupe-nl",
  "santa-catarina": "santa-catarina-nl",
  juarez: "juarez-nl",
  garcia: "garcia-nl",
  victoria: "victoria-tam",
  altamira: "altamira-tam",
  "la-paz": "la-paz-mx",
  // CLUES uppercase variants of long forms still slugify the same as
  // DENUE's, so include the most common ones.
  "san-pedro-tlaquepaque": "tlaquepaque",
  "tlajomulco-de-zuniga": "tlajomulco",
  "ecatepec-de-morelos": "ecatepec",
  "naucalpan-de-juarez": "naucalpan",
  "tlalnepantla-de-baz": "tlalnepantla",
  "cuautitlan-izcalli": "cuautitlan-izcalli",
  "atizapan-de-zaragoza": "atizapan",
  "coacalco-de-berriozabal": "coacalco",
  "valle-de-chalco-solidaridad": "valle-de-chalco",
  "oaxaca-de-juarez": "oaxaca",
  "tuxtla-gutierrez": "tuxtla-gutierrez",
  "general-escobedo": "escobedo",
  "san-nicolas-de-los-garza": "san-nicolas",
  "hidalgo-del-parral": "parral",
  ahome: "los-mochis",
  cajeme: "ciudad-obregon",
  "cuajimalpa-de-morelos": "cuajimalpa",
  "la-magdalena-contreras": "magdalena-contreras",
};

let MX_CITY_SLUGS_CACHE: Set<string> | undefined;

async function ensureMxCitySlugs(): Promise<Set<string>> {
  if (MX_CITY_SLUGS_CACHE) return MX_CITY_SLUGS_CACHE;
  const cities = await getCities({ country: "MX" });
  MX_CITY_SLUGS_CACHE = new Set(cities.map((c) => c.slug));
  return MX_CITY_SLUGS_CACHE;
}

function municipioToCitySlug(
  rawLabel: string,
  valid: Set<string>,
): string | null {
  const slug = slugify(rawLabel);
  if (!slug) return null;
  const aliased = MX_MUNI_ALIASES[slug];
  if (aliased && valid.has(aliased)) return aliased;
  return valid.has(slug) ? slug : null;
}

// --- Establishment categorisation -------------------------------------
//
// CLUES categorises every row under NOMBRE TIPO ESTABLECIMIENTO +
// NOMBRE DE TIPOLOGIA. For Prolio we only need a single category bucket
// (`medicina`) because all CLUES rows are healthcare establishments by
// definition. The granular tipo/tipologia is preserved in metadata for
// downstream filtering (hospital vs clínica vs laboratorio vs móvil).
//
// We tag a coarse `tipo` field for the dashboard:
//   hospital     — TIPOLOGIA contains HOSPITAL
//   laboratorio  — TIPOLOGIA contains LABORATORIO
//   farmacia     — TIPOLOGIA contains FARMACIA
//   movil        — NOMBRE TIPO contains MOVIL or UNIDAD MOVIL
//   clinica      — everything else (CRO/DIF/CIJ/CONSULTORIO/…)

function classifyTipo(nombreTipo: string, tipologia: string): string {
  const haystack = `${nombreTipo} ${tipologia}`.toUpperCase();
  if (/HOSPITAL/.test(haystack)) return "hospital";
  if (/LABORATORIO/.test(haystack)) return "laboratorio";
  if (/FARMACIA/.test(haystack)) return "farmacia";
  if (/M[OÓ]VIL/.test(haystack)) return "movil";
  return "clinica";
}

// --- Address composition ----------------------------------------------

function buildAddress(cells: string[]): string {
  const tipoVialidad = cells[COL_TIPO_VIALIDAD]?.trim() ?? "";
  const vialidad = cells[COL_VIALIDAD]?.trim() ?? "";
  const numExt = cells[COL_NUM_EXT]?.trim() ?? "";
  const asentamiento = cells[COL_ASENTAMIENTO]?.trim() ?? "";
  const cp = cells[COL_CP]?.trim() ?? "";
  const municipio = cells[COL_MUNICIPIO]?.trim() ?? "";
  const entidad = cells[COL_ENTIDAD]?.trim() ?? "";

  const street = [tipoVialidad, vialidad, numExt].filter(Boolean).join(" ");
  return [street, asentamiento, cp, municipio, entidad]
    .filter(Boolean)
    .join(", ");
}

function parseLatLng(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(",", ".").trim();
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

// --- Main extraction ---------------------------------------------------

async function extract(limit: number): Promise<ScrapedProfessional[]> {
  const xlsxBuf = await downloadLatestCut();
  if (!xlsxBuf) return [];

  const entries = parseCentralDirectory(xlsxBuf);
  const sharedStringsEntry = entries.find(
    (e) => e.name === "xl/sharedStrings.xml",
  );
  const sheet1Entry = entries.find((e) => e.name === "xl/worksheets/sheet1.xml");
  if (!sharedStringsEntry || !sheet1Entry) {
    console.error(
      `[clues-sinais-mx] missing required XLSX parts (sharedStrings or sheet1)`,
    );
    return [];
  }

  const sharedStringsBuf = readZipEntryData(xlsxBuf, sharedStringsEntry);
  if (!sharedStringsBuf) return [];
  const strings = parseSharedStrings(sharedStringsBuf.toString("utf8"));
  console.log(`[clues-sinais-mx] sharedStrings unique=${strings.length}`);

  const sheet1Buf = readZipEntryData(xlsxBuf, sheet1Entry);
  if (!sheet1Buf) return [];
  const sheet1Xml = sheet1Buf.toString("utf8");

  const validSlugs = await ensureMxCitySlugs();
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let inspected = 0;
  let skippedNoSlug = 0;
  let skippedClosed = 0;
  let isHeader = true;

  iterateSheetRows(sheet1Xml, strings)((cells) => {
    if (isHeader) {
      isHeader = false;
      return true;
    }
    inspected += 1;
    if (out.length >= limit) return false;

    const clues = cells[COL_CLUES]?.trim();
    if (!clues || seen.has(clues)) return true;

    const estatus = cells[COL_ESTATUS]?.trim().toUpperCase() ?? "";
    if (estatus !== "EN OPERACION") {
      skippedClosed += 1;
      return true;
    }

    const municipio = cells[COL_MUNICIPIO]?.trim() ?? "";
    const citySlug = municipioToCitySlug(municipio, validSlugs);
    if (!citySlug) {
      skippedNoSlug += 1;
      return true;
    }

    const unidad = cells[COL_NOMBRE_UNIDAD]?.trim() ?? "";
    const comercial = cells[COL_NOMBRE_COMERCIAL]?.trim() ?? "";
    const name = comercial || unidad;
    if (!name) return true;

    seen.add(clues);

    const nombreTipo = cells[COL_NOMBRE_TIPO]?.trim() ?? "";
    const tipologia = cells[COL_TIPOLOGIA]?.trim() ?? "";
    const tipo = classifyTipo(nombreTipo, tipologia);

    const lat = parseLatLng(cells[COL_LATITUD]);
    const lng = parseLatLng(cells[COL_LONGITUD]);

    out.push(
      normalise({
        source: "clues-sinais-mx",
        sourceId: `clues-sinais-mx:${clues}`,
        name,
        categoryKey: "medicina",
        citySlug,
        phone: cells[COL_TELEFONO]?.trim() || undefined,
        address: buildAddress(cells) || undefined,
        lat: lat && Math.abs(lat) <= 90 ? lat : undefined,
        lng: lng && Math.abs(lng) <= 180 ? lng : undefined,
        metadata: {
          country: "MX",
          authority: "DGIS / Secretaría de Salud — CLUES",
          verified_by_authority: true,
          clues,
          tipo,
          nombre_tipo_establecimiento: nombreTipo || undefined,
          tipologia: tipologia || undefined,
          institucion: cells[COL_NOMBRE_INSTITUCION]?.trim() || undefined,
          entidad: cells[COL_ENTIDAD]?.trim() || undefined,
          municipio: municipio || undefined,
          nombre_oficial: unidad || undefined,
          nombre_comercial: comercial || undefined,
        },
      }),
    );

    return true;
  });

  console.log(
    `[clues-sinais-mx] inspected=${inspected} kept=${out.length} skipped_no_slug=${skippedNoSlug} skipped_closed=${skippedClosed}`,
  );
  return out;
}

export const cluesSinaisMxSource: ScraperSource = {
  name: "clues-sinais-mx",
  enabled() {
    return process.env.PROLIO_RUN_CLUES_SINAIS_MX === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCluesSinaisMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cluesSinaisMxSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const rawLimit = Number(
    process.env.PROLIO_CLUES_SINAIS_MX_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await extract(limit);
  if (records.length === 0)
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[clues-sinais-mx] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
