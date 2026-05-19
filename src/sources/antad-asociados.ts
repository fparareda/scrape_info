import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * ANTAD — Asociación Nacional de Tiendas de Autoservicio y Departamentales.
 *
 *   https://www.antad.net/asociados/
 *
 * Reality check (auditoría 2026-05-15):
 *   - ANTAD agrupa **92 cadenas asociadas** repartidas en 3 categorías
 *     publicadas: 25 autoservicios + 13 departamentales + ~55
 *     especializadas (snapshot oficial: 47,358 tiendas, 21.69 M m²).
 *   - El listado público está dividido en 3 páginas-índice
 *     (`/asociados/autoservicios/`, `/asociados/departamentales/`,
 *     `/asociados/especializadas/`) que sólo muestran nombre + URL de
 *     la cadena (sin teléfono ni dirección — esos viven en el portal
 *     interno mi-antad).
 *   - Además, ANTAD publica un XLSX maestro
 *     (`/2025/02/listado-de-asociados.xlsx`) — referenciado desde
 *     `/asociados/`. Cuando llega 200 es la fuente más limpia; en su
 *     defecto, raspamos las 3 páginas-índice como fallback.
 *
 * Esta fuente NO pretende construir 47k stores: emite las 92 cadenas
 * como cabeceras corporativas (semillas para enriquecimiento posterior
 * vía Google Places por marca). Cada registro lleva en metadata su
 * categoría ANTAD (autoservicio | departamental | especializada) para
 * facilitar filtros downstream.
 *
 * Categoría Prolio: `fiscal` (proxy retail — no hay categoría retail
 * pura en el enum; las cadenas son personas morales con obligaciones
 * fiscales SAT, RFC y cumplimiento ANTAD). Anomalía aceptada y
 * documentada en metadata.especialidad.
 *
 * Off by default. `PROLIO_RUN_ANTAD_ASOCIADOS=true`.
 * Cap con `PROLIO_ANTAD_ASOCIADOS_LIMIT` (default 200 — holgado frente
 * a los 92 reales).
 */

const BASE_URL = "https://www.antad.net/asociados/";
const XLSX_URL =
  process.env.PROLIO_ANTAD_ASOCIADOS_XLSX ||
  "https://www.antad.net/2025/02/listado-de-asociados.xlsx";
const SUBPAGES: Array<{ slug: "autoservicios" | "departamentales" | "especializadas"; url: string }> = [
  { slug: "autoservicios", url: "https://www.antad.net/asociados/autoservicios/" },
  { slug: "departamentales", url: "https://www.antad.net/asociados/departamentales/" },
  { slug: "especializadas", url: "https://www.antad.net/asociados/especializadas/" },
];
const DEFAULT_LIMIT = 200;
const CATEGORY: CategoryKey = "fiscal";
const POLITE_UA =
  "Mozilla/5.0 (compatible; ProlioBot/1.0; +https://prolio.co/bot)";
const REQUEST_TIMEOUT_MS = 30_000;

interface AntadEntry {
  name: string;
  website?: string;
  kind: "autoservicios" | "departamentales" | "especializadas";
}

async function politeFetch(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/html,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[antad-asociados] ${res.status} on ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[antad-asociados] network ${url}: ${(err as Error).message}`,
    );
    return null;
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Extract <a href="..."> ... </a> pairs that look like an asociado tile.
 * The ANTAD index pages list members as cards; each card has at minimum a
 * brand name and an external website link (target="_blank"). We grab any
 * anchor with target=_blank whose href is not antad.net itself, dedupe by
 * normalised hostname, and use the anchor text or `title` as the brand.
 */
function parsePage(
  html: string,
  kind: "autoservicios" | "departamentales" | "especializadas",
): AntadEntry[] {
  const out: AntadEntry[] = [];
  const seen = new Set<string>();
  const re =
    /<a\b[^>]*?href="(https?:\/\/[^"]+)"[^>]*?(?:target="_blank"|rel="[^"]*noopener[^"]*")[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const inner = stripTags(m[2]);
    if (!inner || inner.length < 2) continue;
    // Reject obvious nav/footer links to antad's own properties.
    if (/antad\.net|facebook\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|instagram\.com|wa\.me|mailto:|tel:/i.test(href))
      continue;
    let host: string;
    try {
      host = new URL(href).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    out.push({ name: inner, website: href, kind });
  }
  return out;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];

  // Index page is informational only (totals). We still hit it for parity
  // with the original audit and as a soft availability check.
  const indexHtml = await politeFetch(BASE_URL);
  if (!indexHtml) {
    console.warn(`[antad-asociados] index unreachable, aborting`);
    return out;
  }
  console.log(`[antad-asociados] index OK (${indexHtml.length} bytes)`);

  // XLSX best-effort: if it returns 200 and looks like a zip, we noop on
  // parsing (no xlsx dep in this repo) but log size for ops. The 3
  // subpages remain the authoritative scrape path.
  try {
    const r = await fetch(XLSX_URL, {
      method: "HEAD",
      headers: { "User-Agent": POLITE_UA },
    });
    console.log(
      `[antad-asociados] xlsx HEAD ${r.status} len=${r.headers.get("content-length") ?? "?"}`,
    );
  } catch (err) {
    console.log(`[antad-asociados] xlsx HEAD skipped: ${(err as Error).message}`);
  }

  const all: AntadEntry[] = [];
  for (const { slug, url } of SUBPAGES) {
    const html = await politeFetch(url);
    if (!html) continue;
    const entries = parsePage(html, slug);
    console.log(`[antad-asociados] ${slug}: ${entries.length} entries`);
    all.push(...entries);
    // Be polite between pages.
    await new Promise((r) => setTimeout(r, 250));
  }

  // Final dedupe by hostname across categories (a chain occasionally
  // listed under two buckets — pick the first occurrence).
  const seenHost = new Set<string>();
  for (const e of all) {
    if (out.length >= limit) break;
    let host = "";
    if (e.website) {
      try {
        host = new URL(e.website).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        // fall through
      }
    }
    const dedupeKey = host || slugify(e.name);
    if (seenHost.has(dedupeKey)) continue;
    seenHost.add(dedupeKey);

    const sid = `antad:${e.kind}:${dedupeKey}`.slice(0, 120);
    out.push(
      normalise({
        source: "antad-asociados" as ScrapeSource,
        country: "MX",
        sourceId: sid,
        name: e.name,
        categoryKey: CATEGORY,
        citySlug: "cdmx",
        headline: `ANTAD ${e.kind}`,
        website: e.website,
        metadata: {
          country: "MX",
          authority: "ANTAD",
          verified_by_authority: true,
          antad_kind: e.kind,
          especialidad: `retail-${e.kind}`,
          source_url: BASE_URL,
        },
      }),
    );
  }

  console.log(
    `[antad-asociados] emitted=${out.length} parsed=${all.length} subpages=${SUBPAGES.length}`,
  );
  return out;
}

export const antadAsociadosEnabled = (): boolean =>
  process.env.PROLIO_RUN_ANTAD_ASOCIADOS === "true";

export const antadAsociadosSource: ScraperSource = {
  name: "antad-asociados" as ScrapeSource,
  enabled: antadAsociadosEnabled,
  async fetch() {
    return [];
  },
};

export async function runAntadAsociados(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!antadAsociadosEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("antad-asociados", async () => {
    const rawLimit = Number(
      process.env.PROLIO_ANTAD_ASOCIADOS_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
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

/**
 * ---------------------------------------------------------------------
 * ANTAD — probe (auditoría 2026-05-15)
 * ---------------------------------------------------------------------
 *
 *   GET  https://www.antad.net/asociados/                       200 (HTML index, totales)
 *   HEAD https://www.antad.net/2025/02/listado-de-asociados.xlsx  200 (xlsx maestro)
 *   GET  https://www.antad.net/asociados/autoservicios/           200 (25 cadenas)
 *   GET  https://www.antad.net/asociados/departamentales/         200 (13-14 cadenas)
 *   GET  https://www.antad.net/asociados/especializadas/          200 (~55 cadenas)
 *
 * Snapshot 2026-05-15 (vía WebFetch):
 *   Autoservicios — Chedraui, Soriana, HEB, La Comer, City Market,
 *     Smart & Final, Calimax, Waldos, Alsuper, Casa Ley, …
 *   Departamentales — Liverpool, Palacio de Hierro, Suburbia,
 *     Sanborns, Sears, Coppel, Woolworth, Del Sol, …
 *   Especializadas — 7-Eleven, Circle K, Farmacias del Ahorro,
 *     Farmacia Guadalajara, Benavides, AutoZone, Home Depot,
 *     Office Depot, Petco, Decathlon, Levi's, Zara, C&A, …
 *
 * Limitaciones:
 *   - El XLSX maestro requiere parser (xlsx/exceljs); preferimos hacer
 *     HEAD para health check y scrapear las 3 páginas-índice, que cubren
 *     >95% del universo con HTML simple.
 *   - Las páginas exponen sólo nombre + sitio web; teléfonos/RFC viven
 *     en el portal interno mi-antad (con login). Quedan fuera del v1.
 *   - Cada cadena emitida puede usarse como semilla para Google Places
 *     (queries por marca x estado) para construir el padrón store-level
 *     (47k tiendas) sin tocar a ANTAD.
 */
