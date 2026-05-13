import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * CNBV — Padrón de Entidades Supervisadas por la Comisión Nacional
 * Bancaria y de Valores (México).
 *
 * Universo: ~5,300 entidades financieras supervisadas — bancos múltiples,
 * casas de bolsa, SOFOM E.R./E.N.R., fondos de inversión, sociedades
 * cooperativas de ahorro y préstamo, fintechs (IFC + IFPE), uniones de
 * crédito, asesores en inversión, almacenes generales, casas de cambio,
 * centros cambiarios, etc.
 *
 * El portal oficial es una página de SharePoint que embebe un iframe al
 * sistema "PES" (Padrón de Entidades Supervisadas):
 *
 *   https://www.cnbv.gob.mx/Paginas/PADRÓN-DE-ENTIDADES-SUPERVISADAS.aspx
 *     └─ iframe → http://pes.cnbv.gob.mx/Clasificador
 *                  └─ /Consulta/ConsultaEntidad  (full HTML grid, ~5MB)
 *
 * El botón "Exportar a Excel" en realidad genera un PDF de 319 páginas
 * (link literal: `/Consulta/ExportarExcel`) — no es parseable sin un
 * lector PDF tabular. En vez de eso, parseamos la tabla HTML completa:
 * `/Consulta/ConsultaEntidad` renderiza server-side los 5,312 registros
 * en un grid DevExpress, con 4 columnas:
 *
 *   CASFIM (clave) · RAZÓN SOCIAL · NOMBRE CORTO · SECTOR
 *
 * La página no expone domicilio ni teléfono — el único campo de contacto
 * en CNBV vive en los detalles por sector (Banca múltiple/Casas de bolsa
 * publican domicilios individuales en sus subportales). Para el padrón
 * unificado, registramos sólo identidad jurídica + tipo de entidad.
 *
 * Categoría: `fiscal` (la más afín — CNBV no encaja en construcción/médica;
 * fiscal cubre el espacio financiero/regulatorio mexicano junto a CNSF,
 * SAT y CRE).
 *
 * Off by default. `PROLIO_RUN_CNBV_ENTIDADES=true` enables.
 * Cap con `PROLIO_CNBV_ENTIDADES_LIMIT` (default 10000 — el padrón
 * entero cabe holgado).
 * URL override: `PROLIO_CNBV_ENTIDADES_XLSX` (mal nombrado por
 * coherencia con el resto de bulk-sources MX; acepta cualquier URL que
 * devuelva el grid HTML o un XLSX/CSV con columnas equivalentes).
 */

const DEFAULT_URL =
  process.env.PROLIO_CNBV_ENTIDADES_XLSX ||
  "http://pes.cnbv.gob.mx/Consulta/ConsultaEntidad";
const DEFAULT_LIMIT = 10_000;
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const CATEGORY: CategoryKey = "fiscal";

/**
 * Map a CNBV "SECTOR" label to a coarse tipo_entidad bucket that's
 * easier to filter on downstream. The raw sector string is also kept
 * verbatim in metadata.
 */
function mapTipoEntidad(sector: string): string {
  const s = sector.toUpperCase();
  if (s.includes("BANCA MÚLTIPLE") || s.includes("BANCA MULTIPLE"))
    return "banca-multiple";
  if (s.includes("BANCA DE DESARROLLO")) return "banca-desarrollo";
  if (s.includes("CASA") && s.includes("BOLSA")) return "casa-bolsa";
  if (s.includes("CASA") && s.includes("CAMBIO")) return "casa-cambio";
  if (s.includes("CENTRO") && s.includes("CAMBIARIO")) return "centro-cambiario";
  if (
    s.includes("SOFOM") ||
    s.includes("SOCIEDADES FINANCIERAS DE OBJETO MÚLTIPLE") ||
    s.includes("SOCIEDADES FINANCIERAS DE OBJETO MULTIPLE")
  ) {
    return s.includes("NO REGULADA") || s.includes("E.N.R")
      ? "sofom-enr"
      : "sofom-er";
  }
  if (s.includes("FONDO DE INVERSIÓN") || s.includes("FONDO DE INVERSION"))
    return "fondo-inversion";
  if (s.includes("OPERADORA") && s.includes("FONDOS"))
    return "operadora-fondos";
  if (s.includes("DISTRIBUIDORA") && s.includes("INTEGRAL"))
    return "distribuidora-integral";
  if (s.includes("ASESOR") && s.includes("INVERSI"))
    return "asesor-inversion";
  if (s.includes("UNI") && s.includes("CRÉDITO")) return "union-credito";
  if (s.includes("SOCIEDAD") && s.includes("AHORRO") && s.includes("PRÉSTAMO"))
    return "socap";
  if (s.includes("SOCIEDAD FINANCIERA POPULAR") || s === "SOFIPO")
    return "sofipo";
  if (s.includes("FINANCIAMIENTO COLECTIVO")) return "fintech-ifc";
  if (s.includes("FONDOS DE PAGO ELECTRÓNICO") || s.includes("IFPE"))
    return "fintech-ifpe";
  if (s.includes("ALMAC") && s.includes("DEP")) return "almacen-deposito";
  if (s.includes("EMISORA")) return "emisora";
  if (s.includes("BOLSA")) return "bolsa-valores";
  if (s.includes("CALIFICADORA")) return "calificadora";
  if (s.includes("INFORMACIÓN CREDITICIA")) return "sic";
  if (s.includes("CONTROLADORA")) return "controladora-grupo";
  if (s.includes("PROVEEDOR") && s.includes("PRECIOS")) return "proveedor-precios";
  if (s.includes("REDES DE MEDIOS DE DISPOSICIÓN")) return "red-disposicion";
  if (s.includes("CONTRAPARTE")) return "contraparte-central";
  if (s.includes("DEPÓSITO DE VALORES")) return "deposito-valores";
  if (s.includes("CÁMARA") && s.includes("COMPENSACIÓN")) return "camara-compensacion";
  if (s.includes("OFICINA DE REPRESENTACIÓN")) return "oficina-representacion";
  return "otro";
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&Aacute;/g, "Á")
    .replace(/&Eacute;/g, "É")
    .replace(/&Iacute;/g, "Í")
    .replace(/&Oacute;/g, "Ó")
    .replace(/&Uacute;/g, "Ú")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/&Ntilde;/g, "Ñ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Parse the DevExpress grid HTML at `/Consulta/ConsultaEntidad`. Rows
 * are sequences of 4 `<td class="dxgv ...">` cells in document order;
 * the grid header uses styled tds (not <th>) which we drop by skipping
 * the first 4 cells (header row).
 */
function parseGridHtml(html: string): Array<{
  casfim: string;
  razonSocial: string;
  nombreCorto: string;
  sector: string;
}> {
  // Body data cells all carry the dxgv class; header cells use a
  // different style ("text-align:Center" without dxgv). Capture every
  // dxgv td's inner text.
  const tdRe = /<td[^>]*class="[^"]*dxgv[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
  const cells: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tdRe.exec(html)) !== null) {
    const inner = m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    cells.push(decodeHtmlEntities(inner));
  }
  const out: Array<{
    casfim: string;
    razonSocial: string;
    nombreCorto: string;
    sector: string;
  }> = [];
  // Some rows have an empty leading dxgv (selector column). The
  // observed pattern is groups of 4 useful cells: CASFIM | razón |
  // corto | sector. Drop pure-whitespace cells at row boundaries.
  // Simpler: walk in strides of 4 and require the first cell to
  // resemble a CASFIM key (digits) OR fall back to permissive mode.
  for (let i = 0; i + 3 < cells.length; ) {
    const a = cells[i];
    const b = cells[i + 1];
    const c = cells[i + 2];
    const d = cells[i + 3];
    // Skip filler / separator cells (single non-breaking space → empty).
    if (!a && !b && !c && !d) {
      i += 1;
      continue;
    }
    out.push({
      casfim: a,
      razonSocial: b,
      nombreCorto: c === " " ? "" : c,
      sector: d,
    });
    i += 4;
  }
  return out;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  let response: Response;
  try {
    response = await fetch(DEFAULT_URL, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/html,application/xhtml+xml,*/*",
      },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    console.error(
      `[cnbv-entidades] network error: ${(error as Error).message}`,
    );
    return out;
  }
  if (!response.ok) {
    console.error(`[cnbv-entidades] ${response.status} on ${DEFAULT_URL}`);
    return out;
  }
  const text = await response.text();
  const rows = parseGridHtml(text);
  const tiposDetectados = new Map<string, number>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const razonSocial = row.razonSocial.trim();
    if (!razonSocial) continue;
    const sector = row.sector.trim();
    if (!sector) continue;
    const casfim = row.casfim.trim();
    // CASFIM is the canonical primary key but ~3% of rows (e.g. some
    // SOFOM E.N.R.) have it blank. Fall back to slug-of-name so we
    // still upsert deterministically.
    const sourceKey =
      casfim ||
      `byname:${razonSocial.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)}`;

    const tipo = mapTipoEntidad(sector);
    tiposDetectados.set(tipo, (tiposDetectados.get(tipo) ?? 0) + 1);

    out.push(
      normalise({
        source: "cnbv-entidades" as ScrapeSource,
        sourceId: `cnbv:${sourceKey}`,
        name: razonSocial,
        categoryKey: CATEGORY,
        // CNBV padrón does not expose domicilio. Default to CDMX since
        // CNBV is federal and the regulated HQ is overwhelmingly in
        // Mexico City; downstream geocoding can refine if needed.
        citySlug: "cdmx",
        licenseNumber: casfim || undefined,
        metadata: {
          country: "MX",
          authority: "CNBV",
          verified_by_authority: true,
          numero_registro: casfim || undefined,
          razon_social: razonSocial,
          nombre_corto: row.nombreCorto.trim() || undefined,
          sector_cnbv: sector,
          tipo_entidad: tipo,
        },
      }),
    );
  }

  const summary = Array.from(tiposDetectados.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(
    `[cnbv-entidades] parsed=${out.length} of ${rows.length} grid rows; top tipos: ${summary}`,
  );
  return out;
}

export const cnbvEntidadesEnabled = (): boolean =>
  process.env.PROLIO_RUN_CNBV_ENTIDADES === "true";

export const cnbvEntidadesSource: ScraperSource = {
  name: "cnbv-entidades" as ScrapeSource,
  enabled: cnbvEntidadesEnabled,
  async fetch() {
    return [];
  },
};

export async function runCnbvEntidades(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cnbvEntidadesEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("cnbv-entidades" as ScrapeSource, async () => {
    const rawLimit = Number(
      process.env.PROLIO_CNBV_ENTIDADES_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
    const records = await fetchAll(limit);
    if (records.length === 0)
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
    console.log(
      `[cnbv-entidades] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
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
