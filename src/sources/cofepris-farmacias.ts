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

async function extractPdfText(pdfBytes: Uint8Array): Promise<string[]> {
  const doc = await getDocument({ data: pdfBytes, useSystemFonts: true })
    .promise;
  const lines: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Group items by approximate Y position to recover row layout.
    const rows = new Map<number, Array<{ x: number; str: string }>>();
    for (const item of content.items) {
      if (!("str" in item) || !item.str) continue;
      const tx = (item as { transform: number[] }).transform;
      const y = Math.round(tx[5]);
      const x = tx[4];
      const arr = rows.get(y) ?? [];
      arr.push({ x, str: item.str });
      rows.set(y, arr);
    }
    const ys = [...rows.keys()].sort((a, b) => b - a);
    for (const y of ys) {
      const cells = rows.get(y)!.sort((a, b) => a.x - b.x);
      const line = cells.map((c) => c.str).join(" ").trim();
      if (line) lines.push(line);
    }
  }
  return lines;
}

/**
 * Heuristic line classifier. COFEPRIS PDFs vary by state, but rows always
 * lead with the licencia number (alphanumeric, often `LIC-FAR-`, `13AT-`,
 * `19LS-`, plain digits, or `<state-code> <year> <seq>`). We accept any
 * leading token of length ≥ 5 that is dominated by alphanumerics/hyphens.
 *
 * Returns null when the line is a header, footer, or page anchor.
 */
const HEADER_RE =
  /(licencia|num(ero|\.)\s*sanitar|razon\s*social|domicilio|municipio|cofepris|p[áa]gina|de\s*\d+|fecha\s*de|tipo\s*de|denominaci[óo]n)/i;
const LICENCIA_RE = /^([A-Z0-9][A-Z0-9./-]{3,30})\s+(.+)$/i;

interface ParsedRow {
  licencia: string;
  rest: string;
}

function parseRow(line: string): ParsedRow | null {
  if (line.length < 15) return null;
  if (HEADER_RE.test(line) && !/^\d/.test(line)) return null;
  const m = LICENCIA_RE.exec(line);
  if (!m) return null;
  const licencia = m[1].trim();
  // Reject obvious non-licencias (words like "FARMACIA", state names).
  if (/^(FARMACIA|DROGUER|BOTICA|FARMACIAS)$/i.test(licencia)) return null;
  // Must contain at least one digit (real licencias always do).
  if (!/\d/.test(licencia)) return null;
  return { licencia, rest: m[2].trim() };
}

/** Detect tipo from row text. */
function detectTipo(text: string): string {
  const t = text.toLowerCase();
  if (/drogueria|droguer[íi]a/.test(t)) return "drogueria";
  if (/botica/.test(t)) return "botica";
  return "farmacia";
}

/** Try to split `rest` into {razonSocial, domicilio, municipio}. Best
 *  effort — we don't trust column boundaries since PDFs differ. We split
 *  on the last comma group as a domicilio/municipio guess. */
function splitRest(rest: string): {
  name: string;
  address?: string;
  municipio?: string;
} {
  // Strip the tipo tail if present.
  let body = rest.replace(/\s+(FARMACIA|DROGUER[ÍI]A|BOTICA)\s*$/i, "").trim();
  // Try to find a municipio at the end: last token sequence after a
  // double-space gap or final comma block.
  const commaParts = body.split(/\s*,\s*/);
  if (commaParts.length >= 3) {
    const municipio = commaParts.pop()!.trim();
    const address = commaParts.pop()!.trim();
    const name = commaParts.join(", ").trim();
    return { name: name || body, address, municipio };
  }
  if (commaParts.length === 2) {
    const municipio = commaParts.pop()!.trim();
    const name = commaParts[0].trim();
    return { name, municipio };
  }
  return { name: body };
}

async function fetchPdfRecords(
  src: PdfSource,
  remaining: number,
): Promise<ScrapedProfessional[]> {
  if (remaining <= 0) return [];
  const bytes = await downloadPdf(src.url);
  if (!bytes) return [];
  let lines: string[];
  try {
    lines = await extractPdfText(bytes);
  } catch (error) {
    console.error(
      `[cofepris-farmacias] ${src.estado} pdf parse: ${(error as Error).message}`,
    );
    return [];
  }
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  const citySlug = mxStateToCity(src.estadoSlug) ?? "cdmx";

  for (const line of lines) {
    if (out.length >= remaining) break;
    const row = parseRow(line);
    if (!row) continue;
    if (seen.has(row.licencia)) continue;
    seen.add(row.licencia);

    const parts = splitRest(row.rest);
    if (!parts.name || parts.name.length < 3) continue;
    const tipo = detectTipo(line);

    out.push(
      normalise({
        source: "cofepris-farmacias" as ScrapeSource,
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
    `[cofepris-farmacias] ${src.estado}: kept=${out.length} of ${lines.length} pdf lines`,
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
