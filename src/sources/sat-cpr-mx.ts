import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * SAT — Contadores Públicos Registrados (CPR).
 *
 * Lista pública de contadores autorizados por el SAT para emitir
 * dictamen fiscal en México. ~15-20k registros activos (numerados
 * desde 1 en 1959).
 *
 * Form ASP clásico, sin captcha, accesible vía POST a
 * `cprResBusC.asp`. La página HTML del form (cprProcBusC.ASP)
 * arma 7 campos hidden (`txhCaso`, `txhNum`, `txhNumF`, `txhNom`,
 * `txhMunD`, `txhAlaf`, `txhEst`) y dispara el submit a la página
 * de resultados. Probado 2026-05-14 con curl directo: con
 * `txhCaso=1&txhNum=1&txhNumF=10` la respuesta es un HTML de tabla
 * con un `<tr>` por CPR (10 filas) más cabecera. El servidor falla
 * (`WSDLReader 0x8007000E - Not enough storage`) si el rango es
 * demasiado grande aunque el JS del cliente permite hasta 10000:
 * en la práctica funcionan rangos de 1000.
 *
 * Estrategia:
 *   - Iterar `RANGE_STEP` registros por POST desde 1 hasta el cap.
 *   - Parsear filas con un regex simple (HTML legacy, sin DOM).
 *   - Mapear ENTIDAD FEDERATIVA → city-slug (cdmx, monterrey, ...).
 *   - sourceId = `sat-cpr:<num>`; ese número no cambia jamás.
 *
 * El detalle por CPR (`cprDetalleC.asp?vNum=...`) no añade email
 * ni teléfono, sólo despacho + colegio + situación. No vale la
 * pena hacer N+1 requests para cada CPR; la información ya está
 * en el listado.
 *
 * Categoría Prolio: `fiscal` (contador público / dictaminador).
 * Off por defecto: `PROLIO_RUN_SAT_CPR_MX=true` activa.
 * Cap con `PROLIO_SAT_CPR_MX_LIMIT` (default 20000).
 *
 * NOTA HISTÓRICA: existió un `sat-cpr.ts` borrado en sesiones
 * anteriores cuando se asumía que el form pedía captcha. La URL
 * `consulta.sat.gob.mx/cprsinternet/...` resulta no tenerlo y
 * publica el directorio íntegro en HTML.
 */

const BASE_URL = "https://www.consulta.sat.gob.mx/cprsinternet/cprResBusC.asp";
const POLITE_UA =
  process.env.PROLIO_SAT_CPR_MX_UA ||
  "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const DEFAULT_LIMIT = 20_000;
const RANGE_STEP = 1_000; // chunk size per POST — well under the server's 10k limit
const REQUEST_TIMEOUT_MS = 60_000;
const POLITE_DELAY_MS = 250;
const CATEGORY: CategoryKey = "fiscal";

// El SAT publica el HTML en Latin-1 (ISO-8859-1), igual que sat-efos-edos.
const LATIN1 = new TextDecoder("latin1");

interface CprRow {
  num: string;
  nombre: string;
  municipio: string;
  adaf: string;
  estado: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Decode HTML entities + collapse whitespace. */
function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/&Aacute;/gi, "Á")
    .replace(/&Eacute;/gi, "É")
    .replace(/&Iacute;/gi, "Í")
    .replace(/&Oacute;/gi, "Ó")
    .replace(/&Uacute;/gi, "Ú")
    .replace(/&Ntilde;/gi, "Ñ")
    .replace(/&quot;/gi, '"')
    .replace(/&#x?[0-9a-f]+;/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the result HTML. Each CPR appears as a `<tr>` containing a
 * cell with an anchor pointing to `cprDetalleC.asp?vNum=...`. We
 * extract the 5 visible columns: nº, nombre, municipio, adaf, estado.
 */
function parseRows(html: string): CprRow[] {
  const out: CprRow[] = [];
  // Each result row contains a link to the detail page; use that as
  // a marker to locate the row, then grab all 5 cells.
  const rowRegex =
    /<tr[^>]*>[\s\S]*?cprDetalleC\.asp\?vNum=(\d+)[\s\S]*?<\/tr>/gi;
  for (const m of html.matchAll(rowRegex)) {
    const num = m[1];
    if (!num) continue;
    const trBody = m[0];
    const cells = [...trBody.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (c) => cleanCell(c[1] || ""),
    );
    if (cells.length < 5) continue;
    // The non-greedy regex sometimes swallows the outer breadcrumb
    // <tr>...</tr> for the very first data row (lines 21-63 in the
    // SAT HTML). The data we want is *always* the last 5 cells of
    // the matched block: [num, nombre, municipio, adaf, estado].
    const tail = cells.slice(-5);
    out.push({
      num,
      nombre: tail[1],
      municipio: tail[2],
      adaf: tail[3],
      estado: tail[4],
    });
  }
  return out;
}

async function postRange(from: number, to: number): Promise<CprRow[] | null> {
  const body = new URLSearchParams({
    txhCaso: "1",
    txhNum: String(from),
    txhNumF: String(to),
    txhNom: "",
    txhMunD: "",
    txhAlaf: "0",
    txhEst: "0",
    // Visible mirror fields (the server tolerates either set):
    txtNum: String(from),
    txtNumF: String(to),
    txtNombre: "",
    txtMunDel: "",
    cboAlaf: "0",
    cboEntidad: "0",
    inicio: "inicio",
  });

  let response: Response;
  try {
    response = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "User-Agent": POLITE_UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml",
        Referer: "https://www.consulta.sat.gob.mx/cprsinternet/cprProcBusC.ASP",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(
      `[sat-cpr-mx] network error ${from}-${to}: ${(error as Error).message}`,
    );
    return null;
  }
  if (!response.ok) {
    console.error(`[sat-cpr-mx] HTTP ${response.status} for ${from}-${to}`);
    return null;
  }
  const ab = await response.arrayBuffer();
  const html = LATIN1.decode(Buffer.from(ab));
  // Detect the WSDLReader memory error and treat it as a transient
  // failure (caller retries the chunk halved).
  if (/WSDLReader/i.test(html) || /HRESULT=0x8007000E/i.test(html)) {
    console.warn(`[sat-cpr-mx] backend WSDL/memory error for ${from}-${to}`);
    return null;
  }
  return parseRows(html);
}

/** POST with one halving retry if the SAT backend chokes. */
async function fetchChunk(from: number, to: number): Promise<CprRow[]> {
  const rows = await postRange(from, to);
  if (rows !== null) return rows;
  // Halve the range and retry sequentially.
  const mid = Math.floor((from + to) / 2);
  if (mid <= from) return [];
  const a = (await postRange(from, mid)) || [];
  await sleep(POLITE_DELAY_MS);
  const b = (await postRange(mid + 1, to)) || [];
  return [...a, ...b];
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let consecutiveEmpty = 0;

  for (let from = 1; from <= limit && out.length < limit; from += RANGE_STEP) {
    const to = Math.min(from + RANGE_STEP - 1, limit);
    const rows = await fetchChunk(from, to);
    if (rows.length === 0) {
      consecutiveEmpty += 1;
      // Two empty chunks in a row → we've gone past the highest issued
      // CPR number. Stop early to save bandwidth.
      if (consecutiveEmpty >= 2) {
        console.log(
          `[sat-cpr-mx] stopping early at ${from}: two empty chunks (likely past last CPR)`,
        );
        break;
      }
    } else {
      consecutiveEmpty = 0;
    }

    for (const row of rows) {
      if (out.length >= limit) break;
      const num = row.num.trim();
      if (!num || seen.has(num)) continue;
      seen.add(num);
      const nombre = row.nombre;
      if (!nombre) continue;
      const citySlug = mxStateToCity(row.estado) || "cdmx";
      out.push(
        normalise({
          source: "sat-cpr-mx" as ScrapeSource,
          sourceId: `sat-cpr:${num}`,
          name: nombre,
          categoryKey: CATEGORY,
          citySlug,
          licenseNumber: num,
          metadata: {
            country: "MX",
            authority: "SAT",
            verified_by_authority: true,
            registro_cpr: num,
            municipio: row.municipio || undefined,
            entidad_federativa: row.estado || undefined,
            adaf: row.adaf || undefined,
            fundamento: "Contador Público Registrado (art. 52 CFF)",
            fuente_url:
              "https://www.consulta.sat.gob.mx/cprsinternet/cprProcBusC.ASP",
          },
        }),
      );
    }

    console.log(
      `[sat-cpr-mx] chunk ${from}-${to}: ${rows.length} rows, total=${out.length}`,
    );
    await sleep(POLITE_DELAY_MS);
  }
  console.log(`[sat-cpr-mx] parsed=${out.length}`);
  return out;
}

export const satCprMxEnabled = (): boolean =>
  process.env.PROLIO_RUN_SAT_CPR_MX === "true";

export const satCprMxSource: ScraperSource = {
  name: "sat-cpr-mx" as ScrapeSource,
  enabled: satCprMxEnabled,
  async fetch() {
    return [];
  },
};

export async function runSatCprMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!satCprMxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("sat-cpr-mx", async () => {
    const rawLimit = Number(
      process.env.PROLIO_SAT_CPR_MX_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
    const records = await fetchAll(limit);
    if (records.length === 0)
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
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
