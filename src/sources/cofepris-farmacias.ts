import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * COFEPRIS — Comisión Federal para la Protección contra Riesgos Sanitarios
 * (Mexico).
 *
 * Padrón nacional de farmacias, droguerías y boticas con licencia sanitaria
 * vigente. ~45k establecimientos nacionales (≈ 1k–4k por estado más concurridos).
 *
 * Distribución oficial: 27 PDFs publicados en `gob.mx/cofepris/documentos/
 * bases-de-datos-de-licencias-sanitarias-de-farmacias` — uno por estado más
 * un "consolidado nacional" emitido directamente por COFEPRIS (CDMX y
 * laboratorios federales). NO existe versión CSV/XLSX ni endpoint CKAN
 * en datos.gob.mx (verificado 2026-05-13).
 *
 * Por eso el scraper descarga cada PDF con `pdfjs-dist` y extrae las filas
 * tabulares: las páginas siguen un layout columnar consistente
 *   {NumLicencia} {RazonSocial} {Domicilio} {Municipio} {Tipo}
 * separadas por espacios. Tolerante a layouts levemente distintos por
 * estado (cada Coepris formatea su PDF).
 *
 * Categoría: `medicina` (proxy — son establecimientos sanitarios; las
 * farmacias atienden público y se cruzan con búsquedas de salud en
 * el catálogo Prolio).
 *
 * Off by default. `PROLIO_RUN_COFEPRIS_FARMACIAS=true` enables.
 * Cap con `PROLIO_COFEPRIS_FARMACIAS_LIMIT` (default 50000 — toda la lista).
 *
 * URL overrides: `PROLIO_COFEPRIS_FARMACIAS_PDFS` (JSON array of
 * `{estado,url}`) reemplaza el listado completo si COFEPRIS rota IDs.
 */

const POLITE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 Prolio-Bot/1.0";
const DEFAULT_LIMIT = 50_000;

interface PdfSource {
  estado: string;
  /** state slug compatible with mxStateToCity */
  estadoSlug: string;
  url: string;
}

/** Default attachment URLs (snapshot 2026-05-13). Replace via env if rotated. */
const DEFAULT_PDFS: PdfSource[] = [
  { estado: "Aguascalientes",      estadoSlug: "aguascalientes",      url: "https://www.gob.mx/cms/uploads/attachment/file/418561/farmacias_aguascalientes.pdf" },
  { estado: "Baja California",     estadoSlug: "baja-california",     url: "https://www.gob.mx/cms/uploads/attachment/file/514312/farmacias_baja_california.pdf" },
  { estado: "Campeche",            estadoSlug: "campeche",            url: "https://www.gob.mx/cms/uploads/attachment/file/418564/farmacias_campeche.pdf" },
  { estado: "Chiapas",             estadoSlug: "chiapas",             url: "https://www.gob.mx/cms/uploads/attachment/file/418566/farmacias_chiapas.pdf" },
  { estado: "Chihuahua",           estadoSlug: "chihuahua",           url: "https://www.gob.mx/cms/uploads/attachment/file/418567/farmacias_chihuahua.pdf" },
  { estado: "Coahuila",            estadoSlug: "coahuila",            url: "https://www.gob.mx/cms/uploads/attachment/file/418568/farmacias_coahuila.pdf" },
  { estado: "Colima",              estadoSlug: "colima",              url: "https://www.gob.mx/cms/uploads/attachment/file/475119/farmacias_colima.pdf" },
  { estado: "Durango",             estadoSlug: "durango",             url: "https://www.gob.mx/cms/uploads/attachment/file/503161/farmacias_durango.pdf" },
  { estado: "Estado de México",    estadoSlug: "estado-de-mexico",    url: "https://www.gob.mx/cms/uploads/attachment/file/418571/farmacias_estadodemexico.pdf" },
  { estado: "Guanajuato",          estadoSlug: "guanajuato",          url: "https://www.gob.mx/cms/uploads/attachment/file/475133/farmacias_guanajuato.pdf" },
  { estado: "Hidalgo",             estadoSlug: "hidalgo",             url: "https://www.gob.mx/cms/uploads/attachment/file/544614/farmacias_hidalgo.pdf" },
  { estado: "Jalisco",             estadoSlug: "jalisco",             url: "https://www.gob.mx/cms/uploads/attachment/file/514314/farmacias_jalisco.pdf" },
  { estado: "Michoacán",           estadoSlug: "michoacan",           url: "https://www.gob.mx/cms/uploads/attachment/file/469708/farmacias_michoacan.pdf" },
  { estado: "Morelos",             estadoSlug: "morelos",             url: "https://www.gob.mx/cms/uploads/attachment/file/418577/farmacias_morelos.pdf" },
  { estado: "Oaxaca",              estadoSlug: "oaxaca",              url: "https://www.gob.mx/cms/uploads/attachment/file/503162/farmacias_oaxaca.pdf" },
  { estado: "Puebla",              estadoSlug: "puebla",              url: "https://www.gob.mx/cms/uploads/attachment/file/418580/farmacias_puebla.pdf" },
  { estado: "Querétaro",           estadoSlug: "queretaro",           url: "https://www.gob.mx/cms/uploads/attachment/file/514315/farmacias_queretaro.pdf" },
  { estado: "Quintana Roo",        estadoSlug: "quintana-roo",        url: "https://www.gob.mx/cms/uploads/attachment/file/418552/farmacias_quintanaroo.pdf" },
  { estado: "San Luis Potosí",     estadoSlug: "san-luis-potosi",     url: "https://www.gob.mx/cms/uploads/attachment/file/514316/farmacias_sanluispotosi.pdf" },
  { estado: "Sonora",              estadoSlug: "sonora",              url: "https://www.gob.mx/cms/uploads/attachment/file/418554/farmacias_sonora.pdf" },
  { estado: "Tabasco",             estadoSlug: "tabasco",             url: "https://www.gob.mx/cms/uploads/attachment/file/503158/farmacias_tabasco.pdf" },
  { estado: "Tamaulipas",          estadoSlug: "tamaulipas",          url: "https://www.gob.mx/cms/uploads/attachment/file/514318/farmacias_tamaulipas.pdf" },
  { estado: "Tlaxcala",            estadoSlug: "tlaxcala",            url: "https://www.gob.mx/cms/uploads/attachment/file/503157/farmacias_tlaxcala.pdf" },
  { estado: "Veracruz",            estadoSlug: "veracruz",            url: "https://www.gob.mx/cms/uploads/attachment/file/544616/farmacias_veracruz.pdf" },
  { estado: "Yucatán",             estadoSlug: "yucatan",             url: "https://www.gob.mx/cms/uploads/attachment/file/514308/farmacias_yucatan.pdf" },
  { estado: "Zacatecas",           estadoSlug: "zacatecas",           url: "https://www.gob.mx/cms/uploads/attachment/file/544613/farmacias_zacatecas.pdf" },
  // Nacional (CDMX + lo emitido directo por COFEPRIS)
  { estado: "COFEPRIS Nacional",   estadoSlug: "cdmx",                url: "https://www.gob.mx/cms/uploads/attachment/file/1020177/BASE_DE_DATOS_DE_LICENCIAS_SANITARIAS_DE_FARMACIAS___DROGUERIAS_Y_BOTICAS__EMITIDAS_POR_COFEPRIS.pdf" },
];

function loadPdfSources(): PdfSource[] {
  const override = process.env.PROLIO_COFEPRIS_FARMACIAS_PDFS;
  if (!override) return DEFAULT_PDFS;
  try {
    const parsed = JSON.parse(override);
    if (Array.isArray(parsed) && parsed.every((p) => p?.url && p?.estado)) {
      return parsed.map((p: { estado: string; estadoSlug?: string; url: string }) => ({
        estado: p.estado,
        estadoSlug: p.estadoSlug ?? p.estado.toLowerCase().replace(/\s+/g, "-"),
        url: p.url,
      }));
    }
  } catch (error) {
    console.error(
      `[cofepris-farmacias] bad PROLIO_COFEPRIS_FARMACIAS_PDFS: ${(error as Error).message}`,
    );
  }
  return DEFAULT_PDFS;
}

async function downloadPdf(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "application/pdf,*/*",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      console.error(`[cofepris-farmacias] HTTP ${response.status} on ${url}`);
      return null;
    }
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  } catch (error) {
    console.error(
      `[cofepris-farmacias] network on ${url}: ${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * Extract candidate rows from a COFEPRIS pharmacy PDF.
 *
 * Each state's PDF uses a different column layout, but every row contains
 * the same three signals on (or very close to) one rendered line:
 *   - A "giro" keyword: FARMACIA / BOTICA / DROGUER[ÍI]A
 *   - A license number (digit-heavy, several formats — see `LICENSE_TOKEN`)
 *   - An issue date in dd/mm/yyyy or dd-mm-yyyy
 *
 * The previous implementation expected `<licencia> <rest>` at the start of
 * the line and lost ~95% of rows because the licencia is usually in the
 * middle column. We now scan every Y-position, accept any line that carries
 * all three signals, and also merge tightly-stacked Y-neighbour fragments
 * (some states render one logical row across 2-3 stacked Y-coordinates).
 */
async function extractPdfRows(
  pdfBytes: Uint8Array,
): Promise<Array<{ licencia: string; line: string }>> {
  const doc = await getDocument({ data: pdfBytes, useSystemFonts: true })
    .promise;
  const rowsOut: Array<{ licencia: string; line: string }> = [];
  const seen = new Set<string>();
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const yMap = new Map<number, Array<{ x: number; str: string }>>();
    for (const item of content.items) {
      if (!("str" in item) || !item.str) continue;
      const tx = (item as { transform: number[] }).transform;
      const y = Math.round(tx[5]);
      const x = tx[4];
      const arr = yMap.get(y) ?? [];
      arr.push({ x, str: item.str });
      yMap.set(y, arr);
    }
    const ys = [...yMap.keys()].sort((a, b) => b - a);
    const lineByY = new Map<number, string>();
    for (const y of ys) {
      const cells = yMap.get(y)!.sort((a, b) => a.x - b.x);
      lineByY.set(
        y,
        cells.map((c) => c.str).join(" ").replace(/\s+/g, " ").trim(),
      );
    }
    const handled = new Set<number>();
    // 1) Single-line anchors (most rows match here).
    for (const y of ys) {
      const line = lineByY.get(y)!;
      const lic = anchorLicense(line);
      if (!lic) continue;
      handled.add(y);
      if (seen.has(lic)) continue;
      seen.add(lic);
      rowsOut.push({ licencia: lic, line });
    }
    // 2) Merge adjacent Y-pairs (gap ≤ 6) for layouts that split one
    //    logical row across two text rows.
    for (let k = 0; k < ys.length; k += 1) {
      const y = ys[k];
      if (handled.has(y)) continue;
      const baseLine = lineByY.get(y)!;
      if (!baseLine) continue;
      for (let dk = 1; dk <= 2 && k + dk < ys.length; dk += 1) {
        const yNext = ys[k + dk];
        if (handled.has(yNext)) continue;
        const gap = Math.abs(y - yNext);
        if (gap === 0 || gap > 6) break;
        const merged = `${lineByY.get(yNext)!} ${baseLine}`
          .replace(/\s+/g, " ")
          .trim();
        const lic = anchorLicense(merged);
        if (!lic) continue;
        handled.add(y);
        handled.add(yNext);
        if (seen.has(lic)) break;
        seen.add(lic);
        rowsOut.push({ licencia: lic, line: merged });
        break;
      }
    }
  }
  return rowsOut;
}

/**
 * License number candidates seen across the 27 COFEPRIS state PDFs:
 *   - `30 121 09 0002`   (Veracruz / Jalisco, with spaces)
 *   - `14-002-09-0306`   (Jalisco IMSS rows, hyphens)
 *   - `28041090170`      (Tamaulipas, packed 11 digits)
 *   - `09002090086`      (COFEPRIS nacional, packed 11 digits)
 *   - `,01121008`        (legacy Veracruz, comma-prefixed 8 digits)
 */
const LICENSE_TOKEN =
  /(?:\d{2}[\s-]\d{3}[\s-]\d{2}[\s-]\d{3,4}|\b\d{10,12}\b|,\d{8,12})/;
const DATE_RE = /\b\d{2}[\/-]\d{2}[\/-]\d{4}\b/;
const GIRO_RE = /\b(FARMACIA|BOTICA|DROGUER[ÍI]A|Farmacia|Botica|Droguer[íi]a)\b/;
/**
 * Header / column-name patterns. Lines containing these are NEVER pharmacy
 * rows even if they happen to include digits+keyword combinations.
 */
const HEADER_RE =
  /(L[ÍI]NEAS DE COMERC|RAZ[ÓO]N SOCIAL|ESTABLECIMIENTO\s+\(?FARMACIA|GIRO\s+\(FARMACIA|GIRO\s+LINEAS|CODIGO FECHA|FECHA\s+EXPEDICI|NO\.\s+LICENCIA|No\.\s+LICENCIA|BASE DE DATOS|SUBDIRECCI[ÓO]N|COMISI[ÓO]N (FEDERAL|ESTATAL)|DIRECCI[ÓO]N DE EVAL)/i;

function anchorLicense(line: string): string | null {
  if (line.length < 25) return null;
  if (HEADER_RE.test(line)) return null;
  if (!GIRO_RE.test(line)) return null;
  const licMatch = line.match(LICENSE_TOKEN);
  if (!licMatch) return null;
  if (!DATE_RE.test(line)) return null;
  const licencia = licMatch[0].replace(/[\s,-]/g, "");
  if (licencia.length < 8) return null;
  return licencia;
}

/** Detect tipo from row text. */
function detectTipo(text: string): string {
  const t = text.toLowerCase();
  if (/drogueria|droguer[íi]a/.test(t)) return "drogueria";
  if (/botica/.test(t)) return "botica";
  return "farmacia";
}

/**
 * Pull the establishment name from an anchor line. PDFs differ wildly so we
 * use a best-effort: strip the trailing fragments (license, date, postal
 * code, entidad keyword, comercialization clauses) and take the leading
 * substring up to the first GIRO keyword.
 *
 * Returns { name, address?, municipio? } — address/municipio are
 * heuristic and may be undefined.
 */
function splitAnchorLine(
  line: string,
  estado: string,
): { name: string; address?: string; municipio?: string } {
  // Drop the license + date region and everything after — that's metadata.
  let body = line;
  const licIdx = body.search(LICENSE_TOKEN);
  if (licIdx > 10) body = body.slice(0, licIdx).trim();

  // Drop the state name if it appears at the tail (e.g. "VERACRUZ").
  const estadoUpper = estado.toUpperCase();
  body = body
    .replace(new RegExp(`\\s+${estadoUpper}\\s*$`, "i"), "")
    .replace(/\s+(Jalisco|Veracruz|Tamaulipas|Ciudad de M[ée]xico|M[ée]xico)\s*$/i, "")
    .trim();

  // Strip trailing 5-digit postal code segment.
  body = body.replace(/\s+\d{5}\s*$/, "").trim();

  // The name is the segment BEFORE the first giro keyword.
  const giroIdx = body.search(GIRO_RE);
  let name = body;
  let after = "";
  if (giroIdx > 0) {
    name = body.slice(0, giroIdx).trim().replace(/[,;]$/, "");
    after = body.slice(giroIdx).replace(GIRO_RE, "").trim();
  }
  // If name accidentally captured a leading consecutive number (COFEPRIS
  // nacional rows start with "1 Farmatodo..."), strip it.
  name = name.replace(/^\s*\d{1,5}\s+/, "").trim();
  // Reject if name is now empty — fall back to the line itself trimmed.
  if (!name || name.length < 3) name = body.replace(GIRO_RE, "").trim();

  // Crude address/municipio guess from `after`: take the first comma chunk
  // as address, last as municipio if there are multiple.
  let address: string | undefined;
  let municipio: string | undefined;
  if (after) {
    const parts = after.split(/\s{2,}|,\s+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      address = parts[0];
      municipio = parts[parts.length - 1];
    } else if (parts.length === 1) {
      address = parts[0];
    }
  }
  return { name, address, municipio };
}

async function fetchPdfRecords(
  src: PdfSource,
  remaining: number,
): Promise<ScrapedProfessional[]> {
  if (remaining <= 0) return [];
  const bytes = await downloadPdf(src.url);
  if (!bytes) return [];
  let rows: Array<{ licencia: string; line: string }>;
  try {
    rows = await extractPdfRows(bytes);
  } catch (error) {
    console.error(
      `[cofepris-farmacias] ${src.estado} pdf parse: ${(error as Error).message}`,
    );
    return [];
  }
  const out: ScrapedProfessional[] = [];
  const citySlug = mxStateToCity(src.estadoSlug) ?? "cdmx";

  for (const row of rows) {
    if (out.length >= remaining) break;
    const parts = splitAnchorLine(row.line, src.estado);
    if (!parts.name || parts.name.length < 3) continue;
    const tipo = detectTipo(row.line);

    out.push(
      normalise({
        source: "cofepris-farmacias" as ScrapeSource,
        country: "MX",
        sourceId: `cofepris:${row.licencia}`,
        name: parts.name,
        categoryKey: "medicina",
        citySlug,
        licenseNumber: row.licencia,
        address: parts.address,
        metadata: {
          country: "MX",
          authority: "COFEPRIS",
          verified_by_authority: true,
          licencia_numero: row.licencia,
          tipo, // farmacia | drogueria | botica
          entidad: src.estado,
          municipio: parts.municipio,
        },
      }),
    );
  }
  console.log(
    `[cofepris-farmacias] ${src.estado}: kept=${out.length} of ${rows.length} rows`,
  );
  return out;
}

export const cofeprisFarmaciasEnabled = (): boolean =>
  process.env.PROLIO_RUN_COFEPRIS_FARMACIAS === "true";

export const cofeprisFarmaciasSource: ScraperSource = {
  name: "cofepris-farmacias" as ScrapeSource,
  enabled: cofeprisFarmaciasEnabled,
  async fetch() {
    return [];
  },
};

export async function runCofeprisFarmacias(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cofeprisFarmaciasEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("cofepris-farmacias" as ScrapeSource, async () => {
    const rawLimit = Number(
      process.env.PROLIO_COFEPRIS_FARMACIAS_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

    const sources = loadPdfSources();
    const all: ScrapedProfessional[] = [];
    for (const src of sources) {
      if (all.length >= limit) break;
      const remaining = limit - all.length;
      const records = await fetchPdfRecords(src, remaining);
      all.push(...records);
    }

    if (all.length === 0)
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(all);
    console.log(
      `[cofepris-farmacias] done — fetched=${all.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
    return {
      rowsFetched: all.length,
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
