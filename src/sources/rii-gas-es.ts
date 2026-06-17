import { inflateRawSync } from "node:zlib";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";

/**
 * RII Gas ES — Empresas instaladoras de gas en el Registro Integrado
 * Industrial (Ministerio de Industria y Turismo de España).
 *
 * Dataset: "Empresas instaladoras de gas en el Registro Integrado
 * Industrial" — published by Spain's Ministry of Industry, Commerce and
 * Tourism under open-data terms (Licencia de uso abierto).
 * Available on datos.gob.es:
 *   https://datos.gob.es/en/catalogo/e05024301-empresas-instaladoras-de-gas-en-el-registro-integrado-industrial
 *
 * Direct XLSX download (verified live 2026-05-27, ~2.4 MB):
 *   https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20Instaladores%20Gas.xlsx
 *
 * Pre-flight 2026-05-27:
 *   - robots.txt for the domain: no Disallow on the download path.
 *   - File downloads successfully as a valid XLSX (Office Open XML).
 *   - Row count: 26,466 data rows (+ 1 header) across all Spanish CCAA.
 *   - Fields: Titular/Razón social | Documento | Categoría | Teléfono |
 *             Correo electrónico | CCAA | Código postal | Dirección |
 *             Municipio | Provincia | País
 *   - No CAPTCHA, no login, no Cloudflare wall.
 *   - License: Open Government Data Spain / reuse freely with attribution.
 *
 * Format: XLSX (Office Open XML / ZIP). We parse it in-process by
 * treating the XLSX as a ZIP archive and extracting
 * `xl/worksheets/sheet1.xml`. All cells use inline strings (t="str");
 * we don't need a shared-strings table. A regex walk of <x:row> elements
 * is sufficient and keeps the dependency footprint at zero.
 *
 * Strategy:
 *   1. GET the XLSX file (single HTTP request, ~2.4 MB).
 *   2. Unzip via Node's built-in `zlib` module (inflateRawSync for
 *      deflate-compressed entries).
 *   3. Parse sheet1.xml using regex — extract each row's cell values
 *      in column order (A=name, B=NIF, C=category, D=phone, E=email,
 *      F=CCAA, G=postcode, H=address, I=municipio, J=provincia, K=país).
 *   4. Map provincia → canonical province-capital city slug.
 *   5. Deduplicate on NIF (or name+address for autonomous workers).
 *   6. Upsert via getSink().
 *
 * Category: `fontaneria` — gas installation companies are the primary
 * national-level regulated trade in Spain covering fontanería, gas,
 * calefacción, and climatización.
 *
 * Off by default. Enable with `PROLIO_RUN_RII_GAS_ES=true`.
 * Cap via `PROLIO_RII_GAS_ES_LIMIT` (default 30000 — covers the full
 * ~26k dataset plus future growth headroom).
 */

const XLSX_URL =
  process.env.PROLIO_RII_GAS_ES_URL ??
  "https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20Instaladores%20Gas.xlsx";

const CATEGORY: CategoryKey = "fontaneria";
const DEFAULT_LIMIT = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

export const riiGasEsSource: ScraperSource = {
  name: "rii-gas-es" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_RII_GAS_ES === "true";
  },
  async fetch() {
    return [];
  },
};

// ---------------------------------------------------------------------------
// Province → canonical city slug (province capital / largest metro).
// ---------------------------------------------------------------------------
const PROVINCIA_TO_CITY: Record<string, string> = {
  "álava": "vitoria",
  "alava": "vitoria",
  "albacete": "albacete",
  "alicante": "alicante",
  "almería": "almeria",
  "almeria": "almeria",
  "ávila": "avila",
  "avila": "avila",
  "badajoz": "badajoz",
  "baleares": "palma",
  "illes balears": "palma",
  "barcelona": "barcelona",
  "burgos": "burgos",
  "cáceres": "caceres",
  "caceres": "caceres",
  "cádiz": "cadiz",
  "cadiz": "cadiz",
  "castellón": "castellon",
  "castellon": "castellon",
  "ciudad real": "ciudad-real",
  "córdoba": "cordoba",
  "cordoba": "cordoba",
  "coruña": "a-coruna",
  "a coruña": "a-coruna",
  "cuenca": "cuenca",
  "girona": "girona",
  "granada": "granada",
  "guadalajara": "guadalajara",
  "guipúzcoa": "san-sebastian",
  "guipuzcoa": "san-sebastian",
  "gipuzkoa": "san-sebastian",
  "huelva": "huelva",
  "huesca": "huesca",
  "jaén": "jaen",
  "jaen": "jaen",
  "león": "leon",
  "leon": "leon",
  "lleida": "lleida",
  "lérida": "lleida",
  "lerida": "lleida",
  "la rioja": "logrono",
  "rioja": "logrono",
  "lugo": "lugo",
  "madrid": "madrid",
  "málaga": "malaga",
  "malaga": "malaga",
  "murcia": "murcia",
  "navarra": "pamplona",
  "ourense": "ourense",
  "orense": "ourense",
  "asturias": "oviedo",
  "palencia": "palencia",
  "las palmas": "las-palmas",
  "palmas": "las-palmas",
  "pontevedra": "pontevedra",
  "salamanca": "salamanca",
  "santa cruz de tenerife": "santa-cruz-de-tenerife",
  "tenerife": "santa-cruz-de-tenerife",
  "cantabria": "santander",
  "segovia": "segovia",
  "sevilla": "sevilla",
  "soria": "soria",
  "tarragona": "tarragona",
  "teruel": "teruel",
  "toledo": "toledo",
  "valencia": "valencia",
  "valladolid": "valladolid",
  "vizcaya": "bilbao",
  "bizkaia": "bilbao",
  "zamora": "zamora",
  "zaragoza": "zaragoza",
  "ceuta": "ceuta",
  "melilla": "melilla",
};

function provinceToSlug(rawProvince: string): string {
  if (!rawProvince) return "";
  const key = rawProvince
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
  const normalized = rawProvince.toLowerCase().trim();
  return PROVINCIA_TO_CITY[normalized] ?? PROVINCIA_TO_CITY[key] ?? "";
}

// ---------------------------------------------------------------------------
// XLSX parsing — pure Node.js, zero external dependencies.
// ---------------------------------------------------------------------------

interface GasRow {
  name: string;
  document: string;
  category: string;
  phone: string;
  email: string;
  ccaa: string;
  postalCode: string;
  address: string;
  municipio: string;
  provincia: string;
  pais: string;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#xF3;/g, "ó")
    .replace(/&#xE9;/g, "é")
    .replace(/&#xED;/g, "í")
    .replace(/&#xE1;/g, "á")
    .replace(/&#xFA;/g, "ú")
    .replace(/&#xFC;/g, "ü")
    .replace(/&#xF1;/g, "ñ")
    .replace(/&#xD1;/g, "Ñ")
    .replace(/&#xC9;/g, "É")
    .replace(/&#xCD;/g, "Í")
    .replace(/&#xD3;/g, "Ó")
    .replace(/&#xDA;/g, "Ú")
    .replace(/&#xC1;/g, "Á")
    .replace(/&#xBA;/g, "º")
    .replace(/&#xAA;/g, "ª")
    .replace(/&#x[0-9a-fA-F]+;/g, " ")
    .replace(/&[a-zA-Z]+;/g, "");
}

function extractCellValues(rowXml: string): string[] {
  const cells: string[] = [];
  const vRegex = /<x:v>([\s\S]*?)<\/x:v>/g;
  let m: RegExpExecArray | null;
  while ((m = vRegex.exec(rowXml)) !== null) {
    cells.push(decodeXmlEntities(m[1]).trim());
  }
  return cells;
}

function parseSheet(xml: string): GasRow[] {
  const rows: GasRow[] = [];
  const rowRegex =
    /<x:row\s+r="(\d+)"[^>]*>([\s\S]*?)(?=<x:row\s+r="|<\/x:sheetData>)/g;
  let m: RegExpExecArray | null;
  while ((m = rowRegex.exec(xml)) !== null) {
    const rowNum = Number(m[1]);
    if (rowNum === 1) continue; // header row
    const cells = extractCellValues(m[2]);
    if (cells.length < 10) continue;
    rows.push({
      name: cells[0] ?? "",
      document: cells[1] ?? "",
      category: cells[2] ?? "",
      phone: cells[3] ?? "",
      email: cells[4] ?? "",
      ccaa: cells[5] ?? "",
      postalCode: cells[6] ?? "",
      address: cells[7] ?? "",
      municipio: cells[8] ?? "",
      provincia: cells[9] ?? "",
      pais: cells[10] ?? "",
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Minimal ZIP parser + decompressor (Node built-ins only).
// ZIP local file header layout (PKZIP 2.0 App Note):
//   Offset 0  : local header signature = 0x04034b50
//   Offset 10 : compression method (0=store, 8=deflate)
//   Offset 18 : compressed size
//   Offset 26 : file name length
//   Offset 28 : extra field length
//   Offset 30 : file name (variable)
//   Offset 30+fnLen+extraLen : data
//
// We scan the central directory (near EOF) for the named entry, then
// jump to its local header to find the data offset.
// ---------------------------------------------------------------------------

function extractFileFromZip(buf: Buffer, targetName: string): string | null {
  const EOCD_SIG = 0x06054b50;
  const CDFILE_SIG = 0x02014b50;

  // Find End-of-Central-Directory (scan backwards from EOF).
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return null;

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);

  let pos = cdOffset;
  while (pos < cdOffset + cdSize && pos + 46 < buf.length) {
    if (buf.readUInt32LE(pos) !== CDFILE_SIG) break;
    const compMethod = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const fileNameLen = buf.readUInt16LE(pos + 28);
    const extraFieldLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const fileName = buf.toString("utf8", pos + 46, pos + 46 + fileNameLen);

    if (fileName === targetName) {
      const lhPos = localHeaderOffset;
      const lhFileNameLen = buf.readUInt16LE(lhPos + 26);
      const lhExtraLen = buf.readUInt16LE(lhPos + 28);
      const dataStart = lhPos + 30 + lhFileNameLen + lhExtraLen;
      const compressed = buf.subarray(dataStart, dataStart + compSize);

      if (compMethod === 0) {
        return compressed.toString("utf8");
      }
      if (compMethod === 8) {
        const decompressed = inflateRawSync(compressed);
        return decompressed.toString("utf8");
      }
      console.warn(`[rii-gas-es] unsupported compression method: ${compMethod}`);
      return null;
    }

    pos += 46 + fileNameLen + extraFieldLen + commentLen;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP download.
// ---------------------------------------------------------------------------

async function fetchAndExtractSheet(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let buf: Buffer;
  try {
    const res = await fetch(XLSX_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[rii-gas-es] HTTP ${res.status} fetching XLSX`);
      return null;
    }
    const ab = await res.arrayBuffer();
    buf = Buffer.from(ab);
  } catch (e) {
    console.warn(`[rii-gas-es] fetch failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }

  const xml = extractFileFromZip(buf, "xl/worksheets/sheet1.xml");
  if (!xml) {
    console.warn("[rii-gas-es] could not find sheet1.xml in XLSX archive");
    return null;
  }
  return xml;
}

// ---------------------------------------------------------------------------
// Row → ScrapedProfessional.
// ---------------------------------------------------------------------------

function extractNif(doc: string): string | undefined {
  const m = doc.match(/(?:NIF|NIE|CIF):([A-Z0-9-]+)/i);
  return m ? m[1] : undefined;
}

function toRecord(row: GasRow): ScrapedProfessional | null {
  const rawName = row.name.trim();
  if (!rawName) return null;

  const name = toTitleCase(rawName);
  const nif = extractNif(row.document);
  const citySlug = provinceToSlug(row.provincia);
  if (!citySlug) return null;

  // Stable sourceId: prefer NIF (unique per entity); fall back to
  // name + address for self-employed without NIF in the registry.
  const sourceId = nif
    ? `rii-gas-es:${nif}`
    : `rii-gas-es:${slugify(rawName)}|${slugify(row.address)}`;

  return normalise({
    source: "rii-gas-es" as ScrapeSource,
    country: "ES",
    sourceId,
    name,
    categoryKey: CATEGORY,
    citySlug,
    phone: row.phone || undefined,
    email: row.email || undefined,
    address: row.address || undefined,
    cif: nif,
    metadata: {
      authority: "RII",
      registry: "Registro Integrado Industrial — Instaladores Gas",
      verified_by_authority: true,
      gas_category: row.category || null,
      ccaa: row.ccaa || null,
      postal_code: row.postalCode || null,
      municipio: row.municipio || null,
      provincia: row.provincia || null,
    },
  });
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

export async function runRiiGasEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!riiGasEsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_RII_GAS_ES_LIMIT ?? DEFAULT_LIMIT);
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  console.log(`[rii-gas-es] fetching XLSX from ${XLSX_URL}`);
  const xml = await fetchAndExtractSheet();
  if (!xml) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const gasRows = parseSheet(xml);
  console.log(`[rii-gas-es] parsed ${gasRows.length} rows from XLSX`);

  const seen = new Set<string>();
  const records: ScrapedProfessional[] = [];
  for (const row of gasRows) {
    if (records.length >= cap) break;
    const rec = toRecord(row);
    if (!rec) continue;
    if (seen.has(rec.sourceId)) continue;
    seen.add(rec.sourceId);
    records.push(rec);
  }

  if (records.length === 0) {
    console.warn(
      "[rii-gas-es] no records produced — XLSX structure may have changed",
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[rii-gas-es] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
