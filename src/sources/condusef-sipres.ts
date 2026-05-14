import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * CONDUSEF — SIPRES (Sistema de Información Pública de Registro de
 * Prestadores de Servicios Financieros).
 *
 *   Public JSP form: https://webapps.condusef.gob.mx/SIPRES/jsp/pub/index.jsp
 *   AJAX endpoint:   POST https://webapps.condusef.gob.mx/SIPRES/jsp/pub/resulbusq.jsp
 *
 * ~5-8k entidades financieras (bancos, aseguradoras, sofomes, casas de
 * bolsa, fondos de inversión, AFORES, SOFIPOS, fintech IFC/IFPE, etc.)
 * registered by ministerio de ley (Ley de Protección y Defensa al Usuario
 * de Servicios Financieros).
 *
 * The JSP rejects an empty query ("No usaste filtros" → 500 page server-
 * side). We iterate the 31 published `psec` sector codes one at a time;
 * each sector returns an HTML <table> with rows we parse.
 *
 * Mapeo de categoría: "fiscal" (closest in current taxonomy — these are
 * regulated financial institutions, not consumer professionals).
 *
 * Off by default. `PROLIO_RUN_CONDUSEF_SIPRES=true`.
 * Cap with `PROLIO_CONDUSEF_SIPRES_LIMIT` (default 10000).
 */

const ENDPOINT = "https://webapps.condusef.gob.mx/SIPRES/jsp/pub/resulbusq.jsp";
const INDEX_URL = "https://webapps.condusef.gob.mx/SIPRES/jsp/pub/index.jsp";
const DEFAULT_LIMIT = 10_000;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "fiscal";
const SECTOR_DELAY_MS = 1500;

// Sector codes scraped 2026-05-14 from `select#psec` on the SIPRES index.
// label is what CONDUSEF displays; stored in metadata.sector.
const SECTORS: Array<{ code: string; label: string }> = [
  { code: "4",  label: "AFORES" },
  { code: "22", label: "ASEGURADORAS" },
  { code: "7",  label: "Almacenes generales de depósito" },
  { code: "10", label: "Arrendadoras financieras" },
  { code: "40", label: "BANCOS - Instituciones de banca múltiple" },
  { code: "37", label: "BANCOS DESARROLLO" },
  { code: "13", label: "CASAS DE BOLSA" },
  { code: "16", label: "Casas de cambio" },
  { code: "19", label: "Empresas de factoraje financiero" },
  { code: "65", label: "FINTECH IFC - Financiamiento Colectivo" },
  { code: "66", label: "FINTECH IFPE - Fondos de Pago Electrónico" },
  { code: "50", label: "Financiera Rural" },
  { code: "53", label: "Fondos de Inversión" },
  { code: "43", label: "Instituciones de fianzas" },
  { code: "76", label: "Operadores del Mercado de Derivados" },
  { code: "32", label: "Organismos de Servicio Social" },
  { code: "23", label: "PENSIONES" },
  { code: "61", label: "SIC - Sociedades de información crediticia" },
  { code: "29", label: "SOCAP" },
  { code: "26", label: "SOFINCO" },
  { code: "27", label: "SOFIPO" },
  { code: "69", label: "SOFOM ENR" },
  { code: "68", label: "SOFOM ER" },
  { code: "24", label: "Salud" },
  { code: "55", label: "Sociedades Controladoras" },
  { code: "71", label: "Distribuidoras de Acciones de Sociedades de Inversión" },
  { code: "52", label: "Sociedades de Inversión" },
  { code: "58", label: "Sociedades de ahorro y préstamo" },
  { code: "64", label: "Sociedades de inversión SIEFORE" },
  { code: "70", label: "Operadoras de Fondos de inversión" },
  { code: "85", label: "UNIONES de crédito" },
];

interface SipresRow {
  clave: string;
  denominacion: string;
  nombreCorto: string;
  estatus: string;
  sector: string;
  estado: string;
  ultimaActualizacion: string;
  noLocalizable: string;
  idins?: string;
}

/**
 * Bootstrap a JSESSIONID — the JSP server appears to require a session
 * cookie issued by index.jsp before resulbusq.jsp returns useful HTML.
 * Returns the cookie header string or empty if bootstrap failed.
 */
async function bootstrapSession(): Promise<string> {
  try {
    const r = await fetch(INDEX_URL, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
    const setCookie = r.headers.get("set-cookie") ?? "";
    // Extract JSESSIONID + cookiesession1 if present.
    const cookies: string[] = [];
    const m1 = /JSESSIONID=([^;]+)/.exec(setCookie);
    if (m1) cookies.push(`JSESSIONID=${m1[1]}`);
    const m2 = /cookiesession1=([^;]+)/.exec(setCookie);
    if (m2) cookies.push(`cookiesession1=${m2[1]}`);
    return cookies.join("; ");
  } catch (error) {
    console.error(`[condusef-sipres] session bootstrap failed: ${(error as Error).message}`);
    return "";
  }
}

async function fetchSector(
  sectorCode: string,
  cookie: string,
): Promise<string> {
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "User-Agent": POLITE_UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": INDEX_URL,
        Cookie: cookie,
        Accept: "text/html",
      },
      body: `tipo=1&pnom=&pedo=&psec=${sectorCode}&psta=`,
      signal: AbortSignal.timeout(180_000),
    });
    if (!r.ok) {
      console.error(`[condusef-sipres] sector=${sectorCode} status=${r.status}`);
      return "";
    }
    const buf = await r.arrayBuffer();
    // Page is served as Latin-1 (cp1252) — decode manually like CNSF CSVs.
    const bytes = new Uint8Array(buf);
    let html = "";
    for (let i = 0; i < bytes.length; i += 1) html += String.fromCharCode(bytes[i]);
    return html;
  } catch (error) {
    console.error(`[condusef-sipres] sector=${sectorCode} error: ${(error as Error).message}`);
    return "";
  }
}

/** Strip HTML tags, collapse whitespace, decode common entities. */
function textOf(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRows(html: string): SipresRow[] {
  const out: SipresRow[] = [];
  // Skip header — locate rows inside <tbody>.
  const tbodyMatch = /<tbody>([\s\S]*?)<\/tbody>/i.exec(html);
  const body = tbodyMatch ? tbodyMatch[1] : html;
  const trRe = /<tr>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(body)) !== null) {
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    const rawCells: string[] = [];
    let tm: RegExpExecArray | null;
    while ((tm = tdRe.exec(m[1])) !== null) {
      rawCells.push(tm[1]);
      cells.push(textOf(tm[1]));
    }
    if (cells.length < 6) continue;
    // Extract idins from the second cell's onclick handler.
    let idins: string | undefined;
    const idMatch = /idins=(\d+)/.exec(rawCells[1] ?? "");
    if (idMatch) idins = idMatch[1];
    out.push({
      clave: cells[0],
      denominacion: cells[1],
      nombreCorto: cells[2],
      estatus: cells[3],
      sector: cells[4],
      estado: cells[5],
      ultimaActualizacion: cells[6] ?? "",
      noLocalizable: cells[7] ?? "",
      idins,
    });
  }
  return out;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const cookie = await bootstrapSession();
  if (!cookie) {
    console.warn("[condusef-sipres] proceeding without cookie — JSP may still respond");
  }
  const seen = new Set<string>();
  for (const sector of SECTORS) {
    if (out.length >= limit) break;
    const html = await fetchSector(sector.code, cookie);
    if (!html || html.includes("error-502__container")) {
      // Server returned the boilerplate 500 page. Re-bootstrap session once.
      console.warn(`[condusef-sipres] sector=${sector.code} got 500 page`);
      continue;
    }
    const rows = parseRows(html);
    console.log(
      `[condusef-sipres] sector=${sector.code} (${sector.label}) rows=${rows.length}`,
    );
    for (const row of rows) {
      if (out.length >= limit) break;
      if (!row.denominacion) continue;
      const id = row.idins || row.clave;
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const citySlug = mxStateToCity(row.estado) ?? "cdmx";
      out.push(
        normalise({
          source: "condusef-sipres" as ScrapeSource,
          sourceId: `condusef-sipres:${id}`,
          name: row.denominacion,
          categoryKey: CATEGORY,
          citySlug,
          licenseNumber: row.clave || undefined,
          metadata: {
            country: "MX",
            authority: "CONDUSEF",
            verified_by_authority: true,
            tipo: "entidad-financiera",
            sector: sector.label,
            sector_code: sector.code,
            nombre_corto: row.nombreCorto || undefined,
            estatus: row.estatus || undefined,
            estado: row.estado || undefined,
            ultima_actualizacion: row.ultimaActualizacion || undefined,
            idins: row.idins,
          },
        }),
      );
    }
    await delay(SECTOR_DELAY_MS);
  }
  console.log(`[condusef-sipres] total=${out.length}`);
  return out;
}

export const condusefSipresEnabled = (): boolean =>
  process.env.PROLIO_RUN_CONDUSEF_SIPRES === "true";

export const condusefSipresSource: ScraperSource = {
  name: "condusef-sipres" as ScrapeSource,
  enabled: condusefSipresEnabled,
  async fetch() {
    return [];
  },
};

export async function runCondusefSipres(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!condusefSipresEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("condusef-sipres", async () => {
    const rawLimit = Number(process.env.PROLIO_CONDUSEF_SIPRES_LIMIT ?? DEFAULT_LIMIT);
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
