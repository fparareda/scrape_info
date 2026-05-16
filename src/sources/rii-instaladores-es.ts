import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * RII Gas Instaladores — Registro Integrado Industrial (Spain).
 *
 * Official Ministry of Industry open-data export of all active gas
 * installer companies registered in the Integrated Industrial Registry
 * (Registro Integrado Industrial — RII) under Real Decreto 559/2010.
 *
 * Data page:
 *   https://sede.serviciosmin.gob.es/es-ES/datosabiertos/catalogo/consulta-rii-instaladores-gas
 *
 * Direct XLSX download (updated daily, no login/captcha):
 *   https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/
 *   UbicacionRIII/Consulta%20RII%20Instaladores%20Gas.xlsx
 *
 * Pre-flight (2026-05-16):
 *   robots.txt — No robots.txt on www6.serviciosmin.gob.es (404 = permit
 *     by absence). Ministry open-data policy explicitly permits reutilización.
 *   Format — Single XLSX file (~2.4 MB). No pagination, no captcha, no
 *     Cloudflare. One HTTP GET returns the entire dataset.
 *   Records — 26,466 rows (header + 26,465 data). ~25,203 unique companies
 *     after deduplication (same company appears once per habilitación
 *     category A/B/C). Province distribution covers all 50 Spanish
 *     provinces (Barcelona 5.9k, Madrid 2.6k, Valencia 1.3k, Girona 1k…).
 *   Contact coverage:
 *     Phone:            20,489 / 25,203 companies (81%)
 *     Email:            10,688 / 25,203 companies (42%)
 *     Phone+Email+Addr: 10,523 / 25,203 companies (42%)
 *   Fields — Titular/Razón social, Documento (NIF), Categoría, Teléfono,
 *     Correo electrónico, CCAA, Código postal, Dirección, Municipio,
 *     Provincia, País.
 *
 * Category mapping:
 *   fontaneria — gas installer companies are the canonical plumbing/gas
 *     installer category under the Spanish regulatory framework.
 *
 * Off by default. Enable via `PROLIO_RUN_RII_INSTALADORES_ES=true`.
 * Cap total rows with `PROLIO_RII_INSTALADORES_ES_LIMIT` (default 30000).
 */

const XLSX_URL =
  process.env.PROLIO_RII_INSTALADORES_ES_URL ||
  "https://www6.serviciosmin.gob.es/Aplicaciones/OpenDataModule_AC202101/UbicacionRIII/Consulta%20RII%20Instaladores%20Gas.xlsx";

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 120_000; // large file ~2.4 MB
const DEFAULT_LIMIT = 30_000;
const SOURCE_NAME = "rii-instaladores-es" as ScrapeSource;
const CATEGORY: CategoryKey = "fontaneria";

// ─── Province → city slug mapping ─────────────────────────────────────────
// Maps the "Provincia" field in the XLSX to seeded city slugs.
// Province name is the canonical capital city of that province.
const PROVINCE_TO_CITY: Record<string, string> = {
  "Madrid":                   "madrid",
  "Barcelona":                "barcelona",
  "Valencia":                 "valencia",
  "Sevilla":                  "sevilla",
  "Zaragoza":                 "zaragoza",
  "Málaga":                   "malaga",
  "Murcia":                   "murcia",
  "Balears, Illes":           "palma",
  "Las Palmas":               "las-palmas",
  "Palmas, Las":              "las-palmas",
  "Bizkaia":                  "bilbao",
  "Alicante":                 "alicante",
  "Córdoba":                  "cordoba",
  "Valladolid":               "valladolid",
  "Coruña, A":                "a-coruna",
  "Vitoria":                  "vitoria",
  "Álava":                    "vitoria",
  "Granada":                  "granada",
  "Asturias":                 "oviedo",
  "Castellón":                "castellon",
  "Albacete":                 "albacete",
  "Almería":                  "almeria",
  "Badajoz":                  "badajoz",
  "Burgos":                   "burgos",
  "Cantabria":                "santander",
  "Cáceres":                  "badajoz",  // no cáceres in cities, use badajoz (Extremadura)
  "Cádiz":                    "cadiz",
  "Ciudad Real":              "albacete",  // Castilla-La Mancha, fallback
  "Cuenca":                   "albacete",
  "Ceuta":                    "cadiz",
  "Girona":                   "barcelona",  // Catalonia, fallback to barcelona
  "Guadalajara":              "madrid",     // province in Castilla-La Mancha, near Madrid
  "Guipuzkoa":                "san-sebastian",
  "Huelva":                   "sevilla",
  "Huesca":                   "zaragoza",
  "Jaén":                     "granada",
  "León":                     "valladolid",
  "Lleida":                   "lleida",
  "Lugo":                     "a-coruna",
  "Navarra":                  "pamplona",
  "Ourense":                  "vigo",
  "Palencia":                 "valladolid",
  "Pontevedra":               "vigo",
  "Rioja, La":                "logrono",
  "Salamanca":                "salamanca",
  "Santa Cruz de Tenerife":   "santa-cruz-tenerife",
  "Segovia":                  "valladolid",
  "Soria":                    "zaragoza",
  "Tarragona":                "tarragona",
  "Teruel":                   "zaragoza",
  "Toledo":                   "madrid",
  "Zamora":                   "valladolid",
};

// ─── XLSX parsing ──────────────────────────────────────────────────────────
//
// The XLSX uses inline strings (t="str") with no shared-strings table.
// Each cell value sits in <x:v>…</x:v> inside the sheet XML. We avoid
// any XLSX library dependency by parsing the zip + sheet XML directly —
// the same pattern used by several other scrapers in this repo that deal
// with government XLSX exports (DGT-ITV, RASIC, etc. use plain CSV;
// here we handle XLSX because the Ministry only publishes this format
// for the gas installer dataset).

interface RiiRow {
  name: string;
  nif: string;
  categoria: string;
  phone: string;
  email: string;
  ccaa: string;
  postalCode: string;
  address: string;
  city: string;
  province: string;
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_m, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)));
}

/**
 * Parse the XLSX sheet XML into structured rows.
 * Expects inline string cells (<x:c t="str"><x:v>…</x:v></x:c>).
 * Returns all data rows (skipping the header row).
 */
function parseSheetXml(xml: string): RiiRow[] {
  const rowRe = /<x:row r="(\d+)">([\s\S]*?)<\/x:row>/g;
  const cellRe = /<x:v>([\s\S]*?)<\/x:v>/g;
  const out: RiiRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(xml)) !== null) {
    const rowNum = parseInt(m[1], 10);
    if (rowNum === 1) continue; // skip header
    const rowXml = m[2];
    const vals: string[] = [];
    cellRe.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowXml)) !== null) {
      vals.push(xmlUnescape(cm[1].replace(/\t/g, "").trim()));
    }
    // Column order: Titular, Documento, Categoría, Teléfono, Correo
    // electrónico, CCAA, Código postal, Dirección, Municipio, Provincia, País
    if (vals.length < 9) continue;
    out.push({
      name:       vals[0] ?? "",
      nif:        vals[1] ?? "",
      categoria:  vals[2] ?? "",
      phone:      vals[3] ?? "",
      email:      vals[4] ?? "",
      ccaa:       vals[5] ?? "",
      postalCode: vals[6] ?? "",
      address:    vals[7] ?? "",
      city:       vals[8] ?? "",
      province:   vals[9] ?? "",
    });
  }
  return out;
}

/**
 * Unzip the XLSX buffer and extract the worksheet XML.
 * XLSX is a ZIP containing xl/worksheets/sheet1.xml.
 */
async function extractSheetXml(buffer: ArrayBuffer): Promise<string | null> {
  // Node.js 22 has native WebStreams but no built-in JSZip. We use the
  // XLSX-as-ZIP trick: it's a standard PK ZIP. The Ministry's XLSX
  // uses inline strings so we only need the sheet XML — no sharedStrings.
  //
  // We read local file headers to locate the central directory, then find
  // "xl/worksheets/sheet1.xml" and decompress it. We use Node.js's built-in
  // `zlib.inflateRawSync` via a dynamic import.
  const { inflateRawSync } = await import("node:zlib");
  const buf = Buffer.from(buffer);

  // Walk local file headers (PK\x03\x04 signature).
  // Offset 0: signature (4 bytes)
  // Offset 4: version needed (2), flags (2), compression (2)
  // Offset 8: last mod time (2), last mod date (2), crc32 (4)
  // Offset 16: compressed size (4), uncompressed size (4)
  // Offset 24: filename length (2), extra field length (2)
  // Offset 30: filename (variable)
  const TARGET = "xl/worksheets/sheet1.xml";
  let offset = 0;
  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // Not a local file header
    const compression = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const uncompressedSize = buf.readUInt32LE(offset + 22);
    const filenameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const filename = buf.subarray(offset + 30, offset + 30 + filenameLen).toString("utf8");
    const dataOffset = offset + 30 + filenameLen + extraLen;
    if (filename === TARGET) {
      const compressed = buf.subarray(dataOffset, dataOffset + compressedSize);
      if (compression === 0) {
        // Stored (no compression)
        return compressed.toString("utf8");
      } else if (compression === 8) {
        // Deflate
        try {
          const decompressed = inflateRawSync(compressed, { maxOutputLength: 50_000_000 });
          return decompressed.toString("utf8");
        } catch (err) {
          console.warn(`[rii-instaladores-es] deflate failed: ${(err as Error).message}`);
          return null;
        }
      } else {
        console.warn(`[rii-instaladores-es] unsupported compression method ${compression}`);
        return null;
      }
    }
    offset = dataOffset + compressedSize;
  }
  console.warn(`[rii-instaladores-es] sheet1.xml not found in ZIP`);
  return null;
}

function mapCitySlug(province: string): string | undefined {
  if (!province) return undefined;
  const clean = province.trim();
  return PROVINCE_TO_CITY[clean] ?? undefined;
}

function cleanNif(raw: string): string | undefined {
  if (!raw) return undefined;
  // Format is "NIF:B12345678" or "NIF:12345678A" or empty
  const stripped = raw.replace(/^NIF:/i, "").trim();
  return stripped || undefined;
}

// ─── Main fetch ────────────────────────────────────────────────────────────

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  console.log(`[rii-instaladores-es] downloading XLSX from ${XLSX_URL}`);
  let buffer: ArrayBuffer;
  try {
    const response = await fetch(XLSX_URL, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*;q=0.1",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!response.ok) {
      console.warn(
        `[rii-instaladores-es] HTTP ${response.status} on XLSX download — skipping`,
      );
      return [];
    }
    buffer = await response.arrayBuffer();
  } catch (err) {
    console.warn(
      `[rii-instaladores-es] network error: ${(err as Error).message}`,
    );
    return [];
  }

  console.log(
    `[rii-instaladores-es] downloaded ${Math.round(buffer.byteLength / 1024)} KB`,
  );

  const sheetXml = await extractSheetXml(buffer);
  if (!sheetXml) {
    console.warn(`[rii-instaladores-es] failed to extract sheet XML`);
    return [];
  }

  const rows = parseSheetXml(sheetXml);
  console.log(`[rii-instaladores-es] parsed ${rows.length} data rows`);

  const out: ScrapedProfessional[] = [];
  // Deduplicate by NIF (when present) or name+province combination.
  // The XLSX has one row per habilitación category (A/B/C) per company,
  // so the same company appears up to 3 times. We keep the first
  // occurrence (which carries identical contact data).
  const seen = new Set<string>();
  let droppedNoCity = 0;
  let droppedDuplicate = 0;
  let droppedNoName = 0;

  for (const row of rows) {
    if (out.length >= limit) break;

    const name = row.name.trim();
    if (!name) {
      droppedNoName += 1;
      continue;
    }

    const citySlug = mapCitySlug(row.province);
    if (!citySlug) {
      droppedNoCity += 1;
      continue;
    }

    const nif = cleanNif(row.nif);
    // Dedup key: prefer NIF (globally unique per company); fall back to
    // normalised name + province so we don't drop sole traders who lack NIF.
    const dedupKey = nif
      ? `nif:${nif}`
      : `name:${name.toLowerCase().replace(/\s+/g, " ")}:${row.province}`;

    if (seen.has(dedupKey)) {
      droppedDuplicate += 1;
      continue;
    }
    seen.add(dedupKey);

    const sourceId = nif ? `rii:${nif}` : `rii:name:${dedupKey}`;

    // Build full address string.
    const addressParts: string[] = [];
    if (row.address) addressParts.push(row.address);
    if (row.postalCode) addressParts.push(row.postalCode);
    if (row.city) addressParts.push(row.city);
    if (row.province) addressParts.push(row.province);
    const address = addressParts.join(", ") || undefined;

    const record = normalise({
      source: SOURCE_NAME,
      sourceId,
      name,
      categoryKey: CATEGORY,
      citySlug,
      address,
      phone: row.phone || undefined,
      email: row.email ? row.email.toLowerCase().trim() : undefined,
      cif: nif,
      metadata: {
        country: "ES",
        ccaa: row.ccaa || undefined,
        provincia: row.province || undefined,
        categoria: row.categoria || undefined,
        registro: "RII",
        habilitacion: "Gas",
        verified_by_authority: true,
        authority: "Ministerio de Industria y Turismo",
      },
    });
    out.push(record);
  }

  console.log(
    `[rii-instaladores-es] produced=${out.length} ` +
      `droppedDuplicate=${droppedDuplicate} ` +
      `droppedNoCity=${droppedNoCity} ` +
      `droppedNoName=${droppedNoName}`,
  );
  return out;
}

// ─── Public API ────────────────────────────────────────────────────────────

export const riiInstaladoresEsSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled() {
    return process.env.PROLIO_RUN_RII_INSTALADORES_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export function riiInstaladoresEsEnabled(): boolean {
  return riiInstaladoresEsSource.enabled();
}

export async function runRiiInstaladoresEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  const limit = Number(
    process.env.PROLIO_RII_INSTALADORES_ES_LIMIT ?? DEFAULT_LIMIT,
  );
  const effective =
    Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const rows = await fetchAll(effective);
  if (rows.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(rows);
  console.log(
    `[rii-instaladores-es] upserted: inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: rows.length, inserted, updated, skipped };
}

