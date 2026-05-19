import { inflateRawSync } from "node:zlib";
import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * IFT-RPC — Registro Público de Concesiones del Instituto Federal
 * de Telecomunicaciones (México).
 *
 * Universo: ~15k concesiones y permisos otorgados por el IFT a personas
 * morales y físicas para explotar bandas del espectro, instalar redes
 * públicas de telecomunicaciones, prestar servicios de radio AM/FM, TV
 * abierta y restringida, radiocomunicación privada, etc. Es el padrón
 * canónico del sector telecom/radiodifusión en MX (regulator-published,
 * licencia abierta).
 *
 * Distribución: bulk XLSX en el visor del RPC. El archivo "03 Concesiones,
 * Autorizaciones y Permisos" agrega los tres instrumentos:
 *   https://rpc.ift.org.mx/vrpc/visor/downloads
 *     └─ /vrpc/assets/publish/uploads/concesiones/03_concesiones_permisos_autorizaciones_<DDMMYY>.xlsx
 *
 * Estructura (37 columnas en sheet1):
 *   0  ID CONCESION                 (numérico interno IFT)
 *   1  FOLIO ELECTRÓNICO            (clave canónica, p.ej. "FET003467CO-100854")
 *   2  TIPO FOLIO                   (TELECOMUNICACIONES | RADIODIFUSIÓN | …)
 *   3  TIPO                         (CONCESIÓN | AUTORIZACIÓN | PERMISO)
 *   4  TIPO CONCESIÓN               (CONCESIÓN ÚNICA | BANDAS ESPECTRO | …)
 *   5  ESTATUS                      (VIGENTE | TERMINADO POR … | EXTINTO …)
 *   6  ID OPERADOR                  (clave operador, agrupa múltiples concesiones)
 *   7  NOMBRE OPERADOR              (razón social — el campo de interés)
 *   8  NOMBRE COMERCIAL
 *   9  EXPEDIENTE
 *  10  FECHA OTORGAMIENTO
 *  11  VIGENCIA (años)
 *  20  TIPO USO                     (COMERCIAL | PÚBLICO | SOCIAL | PRIVADO)
 *  26  SERVICIOS                    (cadena multivalor con servicios autorizados)
 *  27  DISTINTIVO                   (estación AM/FM/TV)
 *  36  LIGA                         (URL pública al detalle, columna AK)
 *
 * El registro no incluye domicilio ni teléfono — solo identidad del
 * concesionario. Para el padrón unificado registramos por OPERADOR
 * (deduplicado) en vez de por concesión, así un grupo como TELMEX que
 * tiene N concesiones aparece como una sola entidad con metadata.servicios
 * agregando todos sus servicios.
 *
 * citySlug: "cdmx" — IFT es federal, los concesionarios son a nivel
 * nacional y la sede corporativa abrumadoramente vive en CDMX. Downstream
 * geocoding puede refinar con SIEM/DENUE si hace falta.
 *
 * Categoría: `fiscal` (proxy comercial — IFT no encaja en construcción/
 * salud; fiscal es la misma elección que CNBV, CNSF, CONDUSEF para
 * entidades reguladas mexicanas).
 *
 * Off by default. `PROLIO_RUN_IFT_RPC_MX=true` enables.
 * Cap con `PROLIO_IFT_RPC_MX_LIMIT` (default 20000 — cabe el padrón
 * completo deduplicado).
 * URL override: `PROLIO_IFT_RPC_MX_XLSX` (el slug de fecha cambia mes a
 * mes; cuando rompa, actualizar a la nueva fecha del index `/visor/downloads`).
 */

const DEFAULT_URL =
  process.env.PROLIO_IFT_RPC_MX_XLSX ||
  "https://rpc.ift.org.mx/vrpc/assets/publish/uploads/concesiones/03_concesiones_permisos_autorizaciones_260426.xlsx";
const DEFAULT_LIMIT = 20_000;
const CATEGORY: CategoryKey = "fiscal";

// Chrome UA — el edge de IFT (Imperva/Incapsula) sirve un 307 con cookies
// a UAs no-browser pero acepta cualquier UA tipo Chrome moderno tras dejar
// fluir el set-cookie en la siguiente petición. Node fetch sigue cookies
// implícitamente a través del 307 hop si el header location apunta al
// mismo origen, pero por seguridad enviamos UA realista desde la primera
// llamada para evitar el desafío JS de Incapsula.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// --- Minimal ZIP central-dir parser ------------------------------------
// XLSX = OOXML = a flat zip. Same approach as denue-mx: parseo manual del
// EOCD + central directory + inflateRaw para los streams deflate. Evita
// dependencia externa de un parser xlsx (proyecto sin lockfile bloat).

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
    entries.push({ name, compressedSize, uncompressedSize, method, localHeaderOffset });
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
      return inflateRawSync(slice);
    } catch (e) {
      console.warn(`[ift-rpc-mx] inflate failed for ${entry.name}: ${(e as Error).message}`);
      return null;
    }
  }
  console.warn(`[ift-rpc-mx] unsupported zip method ${entry.method} for ${entry.name}`);
  return null;
}

// --- XLSX content extraction ------------------------------------------

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Parse `xl/sharedStrings.xml` into a flat array indexed by `<si>` order.
 * Each `<si>` may contain one or more `<t>` children (rich-text runs);
 * concatenamos su texto en orden. ~59k entries en el archivo IFT.
 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  // Match <si>...</si> blocks; inside extract every <t ...>text</t> run.
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1];
    let buf = "";
    let tm: RegExpExecArray | null;
    tRe.lastIndex = 0;
    while ((tm = tRe.exec(inner)) !== null) {
      buf += tm[1];
    }
    out.push(decodeXmlEntities(buf));
  }
  return out;
}

/**
 * Iterate `<row>` blocks in `xl/worksheets/sheet1.xml`, yielding each as
 * a 0-indexed column array. Cells with `t="s"` resolve through the
 * sharedStrings table; numeric/inline values are returned as-is.
 *
 * Column letter → 0-based index is computed from the `r` attribute on
 * each `<c>` (e.g. r="AK15342" → col=36). Missing columns appear as "".
 */
function* iterRows(sheetXml: string, shared: string[]): Generator<string[]> {
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  // Cell shape: <c r="A1" t="s" s="1"><v>123</v></c> or <c r="..." t="inlineStr"><is><t>...</t></is></c>
  const cellRe =
    /<c\s+r="([A-Z]+)\d+"(?:\s+s="\d+")?(?:\s+t="([^"]+)")?(?:\s+s="\d+")?\s*(?:\/>|>([\s\S]*?)<\/c>)/g;
  const tInlineRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  const vRe = /<v\b[^>]*>([\s\S]*?)<\/v>/;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(sheetXml)) !== null) {
    const rowBody = rm[1];
    const cols: string[] = [];
    let cm: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rowBody)) !== null) {
      const ref = cm[1];
      const type = cm[2];
      const body = cm[3] ?? "";
      const colIdx = columnRefToIndex(ref);
      // Resolve value
      let value = "";
      if (type === "s") {
        const v = vRe.exec(body);
        if (v) {
          const idx = Number(v[1]);
          if (Number.isFinite(idx) && idx >= 0 && idx < shared.length) {
            value = shared[idx];
          }
        }
      } else if (type === "inlineStr") {
        tInlineRe.lastIndex = 0;
        let tm: RegExpExecArray | null;
        let buf = "";
        while ((tm = tInlineRe.exec(body)) !== null) buf += tm[1];
        value = decodeXmlEntities(buf);
      } else {
        const v = vRe.exec(body);
        if (v) value = decodeXmlEntities(v[1]);
      }
      while (cols.length < colIdx) cols.push("");
      cols.push(value);
    }
    yield cols;
  }
}

function columnRefToIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i += 1) {
    n = n * 26 + (ref.charCodeAt(i) - 64);
  }
  return n - 1;
}

// --- Fetch + record build ---------------------------------------------

async function downloadXlsx(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      console.error(`[ift-rpc-mx] HTTP ${res.status} on ${url}`);
      return null;
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    console.error(`[ift-rpc-mx] network error: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Map IFT TIPO + TIPO CONCESIÓN into a coarse servicio bucket. The raw
 * fields are also persisted verbatim in metadata.
 */
function mapServicio(tipo: string, tipoConcesion: string): string {
  const a = (tipo || "").toUpperCase();
  const b = (tipoConcesion || "").toUpperCase();
  const both = `${a} ${b}`;
  if (both.includes("RADIODIFUSIÓN") || both.includes("RADIODIFUSION")) {
    if (both.includes("TV") || both.includes("TELEVISIÓN") || both.includes("TELEVISION"))
      return "tv-abierta";
    if (both.includes("AM") || both.includes("FM") || both.includes("RADIO"))
      return "radio-am-fm";
    return "radiodifusion";
  }
  if (both.includes("BANDAS") || both.includes("ESPECTRO")) return "espectro-radioelectrico";
  if (both.includes("RED PÚBLICA") || both.includes("RED PUBLICA")) return "red-publica-telecom";
  if (both.includes("CONCESION ÚNICA") || both.includes("CONCESIÓN ÚNICA") ||
      both.includes("CONCESION UNICA"))
    return "concesion-unica-telecom";
  if (both.includes("RADIOCOMUNICACIÓN") || both.includes("RADIOCOMUNICACION"))
    return "radiocomunicacion";
  if (both.includes("SATELITAL") || both.includes("SATÉLITE") || both.includes("SATELITE"))
    return "satelital";
  if (both.includes("TV") || both.includes("TELEVISIÓN") || both.includes("TELEVISION"))
    return "television-restringida";
  if (both.includes("TELECOMUNICACIONES")) return "telecomunicaciones";
  return "otro";
}

interface OperatorAgg {
  idOperador: string;
  nombreOperador: string;
  nombreComercial: string;
  concesionesActivas: number;
  concesionesTotal: number;
  servicios: Set<string>;
  tipos: Set<string>;
  tiposConcesion: Set<string>;
  tiposUso: Set<string>;
  distintivos: Set<string>;
  liga: string;
  folioEjemplo: string;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const buf = await downloadXlsx(DEFAULT_URL);
  if (!buf) return out;

  const entries = parseCentralDirectory(buf);
  const sharedEntry = entries.find((e) => e.name === "xl/sharedStrings.xml");
  const sheetEntry =
    entries.find((e) => e.name === "xl/worksheets/sheet1.xml") ||
    entries.find((e) => /^xl\/worksheets\/sheet1?\.xml$/i.test(e.name));
  if (!sharedEntry || !sheetEntry) {
    console.error(
      `[ift-rpc-mx] missing required entries in XLSX; got ${entries.map((e) => e.name).join(", ")}`,
    );
    return out;
  }
  const sharedRaw = readZipEntryData(buf, sharedEntry);
  const sheetRaw = readZipEntryData(buf, sheetEntry);
  if (!sharedRaw || !sheetRaw) {
    console.error(`[ift-rpc-mx] failed to inflate sharedStrings or sheet1`);
    return out;
  }
  const sharedStrings = parseSharedStrings(sharedRaw.toString("utf8"));
  console.log(
    `[ift-rpc-mx] xlsx=${(buf.length / 1024 / 1024).toFixed(1)}MB sharedStrings=${sharedStrings.length}`,
  );

  // Group by ID OPERADOR (col 6) — a single operator typically holds
  // multiple concesiones; we emit one ScrapedProfessional per operator.
  const byOperator = new Map<string, OperatorAgg>();
  let totalRows = 0;
  let withName = 0;
  let header = true;

  for (const cols of iterRows(sheetRaw.toString("utf8"), sharedStrings)) {
    if (header) {
      header = false;
      continue;
    }
    totalRows += 1;
    const idOperador = (cols[6] || "").trim();
    const nombreOperador = (cols[7] || "").trim();
    if (!nombreOperador) continue;
    withName += 1;

    const folio = (cols[1] || "").trim();
    const tipoFolio = (cols[2] || "").trim(); // TELECOMUNICACIONES / RADIODIFUSIÓN
    const tipo = (cols[3] || "").trim(); // CONCESIÓN / AUTORIZACIÓN / PERMISO
    const tipoConcesion = (cols[4] || "").trim();
    const estatus = (cols[5] || "").trim();
    const nombreComercial = (cols[8] || "").trim();
    const tipoUso = (cols[20] || "").trim();
    void cols[26]; // SERVICIOS — campo libre extenso; lo dejamos fuera para no inflar metadata
    const distintivo = (cols[27] || "").trim();
    // LIGA está en columna AK (índice 36). Algunas filas raras lo emiten en 35 si una columna intermedia
    // está vacía y XLSX colapsa; usamos el primer candidato no vacío que parezca URL.
    const liga = [cols[36], cols[35]].find((s) => /^https?:\/\//i.test(String(s || ""))) || "";

    // Dedup key: prefer ID OPERADOR; fallback to slugged name (some rows
    // for personas físicas have blank operador id).
    const opKey =
      idOperador ||
      `byname:${nombreOperador
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 80)}`;

    let agg = byOperator.get(opKey);
    if (!agg) {
      agg = {
        idOperador,
        nombreOperador,
        nombreComercial,
        concesionesActivas: 0,
        concesionesTotal: 0,
        servicios: new Set(),
        tipos: new Set(),
        tiposConcesion: new Set(),
        tiposUso: new Set(),
        distintivos: new Set(),
        liga: "",
        folioEjemplo: "",
      };
      byOperator.set(opKey, agg);
    }
    agg.concesionesTotal += 1;
    if (estatus.toUpperCase() === "VIGENTE") agg.concesionesActivas += 1;
    if (nombreComercial && !agg.nombreComercial) agg.nombreComercial = nombreComercial;
    const servicioBucket = mapServicio(tipoFolio, tipoConcesion);
    if (servicioBucket) agg.servicios.add(servicioBucket);
    if (tipoFolio) agg.tipos.add(tipoFolio);
    if (tipo) agg.tiposConcesion.add(`${tipo}${tipoConcesion ? `:${tipoConcesion}` : ""}`);
    else if (tipoConcesion) agg.tiposConcesion.add(tipoConcesion);
    if (tipoUso) agg.tiposUso.add(tipoUso);
    if (distintivo) agg.distintivos.add(distintivo);
    if (!agg.liga && liga) agg.liga = liga;
    if (!agg.folioEjemplo && folio) agg.folioEjemplo = folio;
  }

  for (const [opKey, agg] of byOperator) {
    if (out.length >= limit) break;
    // Drop operators with zero vigente AND zero historical — defensive,
    // shouldn't happen since we only insert when at least one row matched.
    if (agg.concesionesTotal === 0) continue;
    const estatusGlobal = agg.concesionesActivas > 0 ? "vigente" : "terminado";
    out.push(
      normalise({
        source: "ift-rpc-mx" as ScrapeSource,
        country: "MX",
        sourceId: `ift-rpc-mx:${opKey}`,
        name: agg.nombreOperador,
        categoryKey: CATEGORY,
        // IFT is federal; concesionarios sin domicilio publicado. Anclamos
        // a CDMX por consistencia con CNBV/CNSF; refinable downstream.
        citySlug: "cdmx",
        website: agg.liga || undefined,
        licenseNumber: agg.idOperador || undefined,
        metadata: {
          country: "MX",
          authority: "IFT",
          verified_by_authority: true,
          id_operador: agg.idOperador || undefined,
          nombre_comercial: agg.nombreComercial || undefined,
          folio_ejemplo: agg.folioEjemplo || undefined,
          concesiones_total: agg.concesionesTotal,
          concesiones_vigentes: agg.concesionesActivas,
          estatus: estatusGlobal,
          servicio: Array.from(agg.servicios).sort().join(", ") || undefined,
          tipos: Array.from(agg.tipos).sort().join(", ") || undefined,
          tipos_concesion: Array.from(agg.tiposConcesion).sort().join(", ") || undefined,
          tipos_uso: Array.from(agg.tiposUso).sort().join(", ") || undefined,
          distintivos:
            agg.distintivos.size > 0
              ? Array.from(agg.distintivos).slice(0, 20).sort().join(", ")
              : undefined,
        },
      }),
    );
  }

  console.log(
    `[ift-rpc-mx] rows=${totalRows} withName=${withName} operadoresUnicos=${byOperator.size} emitidos=${out.length}`,
  );
  return out;
}

export const iftRpcMxEnabled = (): boolean =>
  process.env.PROLIO_RUN_IFT_RPC_MX === "true";

export const iftRpcMxSource: ScraperSource = {
  name: "ift-rpc-mx" as ScrapeSource,
  enabled: iftRpcMxEnabled,
  async fetch() {
    return [];
  },
};

export async function runIftRpcMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!iftRpcMxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("ift-rpc-mx" as ScrapeSource, async () => {
    const rawLimit = Number(process.env.PROLIO_IFT_RPC_MX_LIMIT ?? DEFAULT_LIMIT);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
    const records = await fetchAll(limit);
    if (records.length === 0)
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
    console.log(
      `[ift-rpc-mx] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
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
