import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * PROFECO — Registro Público de Contratos de Adhesión (RPCA).
 *
 * Different from `profeco-sancionados` (Buró Comercial / quejas).
 * This source covers the RPCA: every provider in MX that offers a
 * contract under a NOM-regulated adhesion regime must register the
 * contract here. The dataset is the universe of regulated providers,
 * not sanctions.
 *
 *   Portal:        https://rpca.profeco.gob.mx/
 *   Search page:   https://rpca.profeco.gob.mx/consumidor.html
 *   DataTables AJAX endpoint discovered in js/index.js:
 *                  https://rpca.profeco.gob.mx/busqueda?t=a&a=s
 *
 * Endpoint returns DataTables JSON:
 *   {
 *     "recordsFiltered": 61847,
 *     "recordsTotal":    61847,
 *     "draw":            1,
 *     "data": [
 *       { razon_social, nombre_comercial, numero_registro,
 *         naturaleza, estatus, fecha, link }
 *     ]
 *   }
 *
 * `numero_registro` (e.g. "2650-2025") is unique → sourceId.
 *
 * This source filters by `naturaleza` to keep only contracts in the
 * auto-repair / mechanics space. Categoría = `mecanica` for all rows.
 * If the universe later needs other giros we can lift the filter and
 * map per-naturaleza like profeco-sancionados does.
 *
 * Off by default. `PROLIO_RUN_PROFECO_RPCA_TALLERES=true`.
 * Cap with `PROLIO_PROFECO_RPCA_TALLERES_LIMIT` (default 10000).
 */

const ENDPOINT =
  process.env.PROLIO_PROFECO_RPCA_TALLERES_ENDPOINT ||
  "https://rpca.profeco.gob.mx/busqueda?t=a&a=s";
const DEFAULT_LIMIT = 10_000;
const PAGE_SIZE = 500;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "mecanica";

/**
 * Match `naturaleza` strings that fall in the auto-repair / mechanics
 * giro. The RPCA labels are stable Spanish strings; we accept any
 * obvious automotive service.
 */
function isTallerNaturaleza(raw: string | undefined): boolean {
  if (!raw) return false;
  const s = raw.toLowerCase();
  if (/(reparaci[óo]n|mantenimiento).*(veh[íi]culo|automovil|autom[óo]vil|motocicl)/.test(s))
    return true;
  if (/taller.*mec[áa]nic/.test(s)) return true;
  if (/servicios? automotri/.test(s)) return true;
  // hojalatería, pintura, alineación, balanceo — when present
  if (/(hojalater|pintura automotriz|alineaci[óo]n|balanceo)/.test(s))
    return true;
  return false;
}

interface RpcaRow {
  razon_social?: string;
  nombre_comercial?: string;
  numero_registro?: string;
  naturaleza?: string;
  estatus?: string;
  fecha?: string;
  link?: string;
}

interface RpcaResponse {
  recordsFiltered: number;
  recordsTotal: number;
  draw: number;
  data: RpcaRow[];
}

async function fetchPage(start: number, length: number, draw: number): Promise<RpcaResponse | null> {
  const url = `${ENDPOINT}&draw=${draw}&start=${start}&length=${length}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "application/json,text/plain,*/*",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(
      `[profeco-rpca-talleres] network error start=${start}: ${(error as Error).message}`,
    );
    return null;
  }
  if (!response.ok) {
    console.error(
      `[profeco-rpca-talleres] ${response.status} at start=${start}`,
    );
    return null;
  }
  try {
    return (await response.json()) as RpcaResponse;
  } catch (error) {
    console.error(
      `[profeco-rpca-talleres] bad JSON at start=${start}: ${(error as Error).message}`,
    );
    return null;
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  // First page also gives us recordsTotal.
  const first = await fetchPage(0, PAGE_SIZE, 1);
  if (!first) return out;
  const total = first.recordsTotal ?? 0;
  console.log(
    `[profeco-rpca-talleres] recordsTotal=${total}, paginating with PAGE_SIZE=${PAGE_SIZE}`,
  );

  const processPage = (page: RpcaResponse) => {
    for (const row of page.data) {
      if (out.length >= limit) return false;
      const naturaleza = (row.naturaleza || "").trim();
      if (!isTallerNaturaleza(naturaleza)) continue;
      const numero = (row.numero_registro || "").trim();
      if (!numero || seen.has(numero)) continue;
      const razonSocial = (row.razon_social || "").trim();
      const nombreComercial = (row.nombre_comercial || "").trim();
      const isPlaceholderNombre =
        !nombreComercial || /^sin\s+informaci/i.test(nombreComercial);
      const name = isPlaceholderNombre ? razonSocial : nombreComercial;
      if (!name) continue;
      seen.add(numero);
      out.push(
        normalise({
          source: "profeco-rpca-talleres" as ScrapeSource,
          country: "MX",
          sourceId: `profeco-rpca:${numero}`,
          name,
          categoryKey: CATEGORY,
          // RPCA listing doesn't expose state at this endpoint; the
          // detail page (getDoc?p=…) is a PDF. Use cdmx as neutral
          // anchor — downstream enrichment can refine via crossmatch.
          citySlug: "cdmx",
          description: naturaleza || undefined,
          metadata: {
            country: "MX",
            authority: "PROFECO",
            registry: "RPCA",
            numero_registro: numero,
            razon_social: razonSocial || undefined,
            nombre_comercial: isPlaceholderNombre ? undefined : nombreComercial,
            naturaleza: naturaleza || undefined,
            estatus: row.estatus || undefined,
            fecha_registro: row.fecha || undefined,
            detail_url: `https://rpca.profeco.gob.mx/getDoc?p=${encodeURIComponent(numero)}`,
          },
        }),
      );
    }
    return true;
  };

  if (!processPage(first)) {
    console.log(`[profeco-rpca-talleres] hit limit on page 1, parsed=${out.length}`);
    return out;
  }

  let draw = 2;
  for (let start = PAGE_SIZE; start < total; start += PAGE_SIZE) {
    if (out.length >= limit) break;
    const page = await fetchPage(start, PAGE_SIZE, draw++);
    if (!page) continue;
    if (!processPage(page)) break;
    // polite pacing — endpoint is small but we don't want to hammer
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(
    `[profeco-rpca-talleres] parsed=${out.length} of ${total} total RPCA rows (filter=naturaleza∈mecánica)`,
  );
  return out;
}

export const profecoRpcaTalleresEnabled = (): boolean =>
  process.env.PROLIO_RUN_PROFECO_RPCA_TALLERES === "true";

export const profecoRpcaTalleresSource: ScraperSource = {
  name: "profeco-rpca-talleres" as ScrapeSource,
  enabled: profecoRpcaTalleresEnabled,
  async fetch() {
    return [];
  },
};

export async function runProfecoRpcaTalleres(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!profecoRpcaTalleresEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("profeco-rpca-talleres", async () => {
    const rawLimit = Number(
      process.env.PROLIO_PROFECO_RPCA_TALLERES_LIMIT ?? DEFAULT_LIMIT,
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
