/**
 * Provincial Spanish Colegios Oficiales de Médicos (OMC) scraper.
 *
 * OMC (cgcom.es) umbrella aggregates 52 provincial colegios, each with
 * its own public colegiado directory. These are the highest-trust
 * source of médicos data in Spain (direct from the regulator) so every
 * row we ingest gets `metadata.verified_by_colegio = true` — our
 * landings can render a "Verificado por COM <Provincia>" badge.
 *
 * Pre-flight 2026-04-24 against ALL 52 provincial colegios (re-run of
 * the 2026-04-23 smaller sweep). Full matrix lives in
 * `docs/COLEGIOS_MEDICOS_SPAIN.md`. Three colegios cleared the bar:
 *
 *   COMZ    Zaragoza    JSON POST /Procesar/procesar.php
 *   ICOMEM  Madrid      Form POST (303-redirect) → server-rendered
 *                       <tr class="linea_colegiado"> table, /pag/N pages
 *   COMGI   Gipuzkoa    GET /Default.aspx?...pagGC=N, server-rendered
 *                       <div class="elemento"> list
 *
 * The other 49 are SKIP'd — 17 captcha, 18 JS-only SPA, 5 no-buscador,
 * 8 timeout, 1 hardcoded 404. See the doc for per-colegio verdicts and
 * the candidate shortlist for a future Playwright pass.
 *
 * Dispatch is by colegio code. Run a subset via
 * `PROLIO_COLEGIOS_MEDICOS_ONLY=madrid,zaragoza`; per-colegio row cap
 * via `PROLIO_COLEGIOS_MEDICOS_LIMIT` (default 1000).
 *
 * Each colegio run is a separate `scrape_runs` row named
 * `omc-<code>` so admin-panel yield reporting is per-province.
 *
 * Politeness:
 *   - Per-host serial queue, 1 req/sec (1000ms throttle — gov sites are
 *     more sensitive than private directories).
 *   - robots.txt honoured (standard parser, * block).
 *   - Prolio-Bot UA; falls back to Chrome on 403.
 *   - 15s timeout (ICOMEM surname sweeps can be slow).
 *   - Page budget default 1000 per colegio.
 */

import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_BUDGET = 1_000;
const TIMEOUT_MS = 15_000;
const THROTTLE_MS = 1_000;

const UA_BOT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const UA_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// -----------------------------------------------------------------------------
// Per-host queue + fetch
// -----------------------------------------------------------------------------

interface HostState {
  lastFetchAt: number;
  robotsDisallow: string[];
  robotsLoaded: boolean;
  useChromeUa: boolean;
  queue: Promise<unknown>;
  cookies: Map<string, string>;
}

const hostStates = new Map<string, HostState>();

function getHostState(host: string): HostState {
  let state = hostStates.get(host);
  if (!state) {
    state = {
      lastFetchAt: 0,
      robotsDisallow: [],
      robotsLoaded: false,
      useChromeUa: false,
      queue: Promise.resolve(),
      cookies: new Map(),
    };
    hostStates.set(host, state);
  }
  return state;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface FetchResult {
  status: number;
  body: string | null;
  /** Final URL after redirects (fetch follows by default). */
  url: string;
}

function cookieHeaderFor(state: HostState): string | undefined {
  if (state.cookies.size === 0) return undefined;
  const parts: string[] = [];
  for (const [k, v] of state.cookies) parts.push(`${k}=${v}`);
  return parts.join("; ");
}

function ingestSetCookies(state: HostState, res: Response): void {
  // Node's fetch exposes set-cookie via res.headers.getSetCookie() in
  // modern runtimes. Keep only name=value (ignore attributes) — we only
  // need session continuity for form POST → redirect flows.
  const anyHeaders = res.headers as unknown as {
    getSetCookie?: () => string[];
  };
  const raw = anyHeaders.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(";", 1);
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) state.cookies.set(name, value);
  }
}

interface RawFetchInit {
  method: "GET" | "POST";
  ua: string;
  body?: string;
  contentType?: string;
  acceptHtml?: boolean;
}

async function rawFetch(
  url: string,
  init: RawFetchInit,
  state: HostState,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "User-Agent": init.ua,
      Accept: init.acceptHtml
        ? "text/html,application/xhtml+xml,*/*;q=0.8"
        : "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    };
    if (init.method === "POST") {
      headers["Content-Type"] =
        init.contentType ?? "application/x-www-form-urlencoded";
    }
    const cookieHeader = cookieHeaderFor(state);
    if (cookieHeader) headers["Cookie"] = cookieHeader;
    const res = await fetch(url, {
      method: init.method,
      headers,
      body: init.method === "POST" ? init.body : undefined,
      signal: controller.signal,
      redirect: "follow",
    });
    ingestSetCookies(state, res);
    const text = res.ok ? await res.text() : null;
    return { status: res.status, body: text, url: res.url };
  } catch (error) {
    console.warn(
      `[competitor-es-colegios-medicos] fetch ${init.method} ${url}: ${
        (error as Error).message
      }`,
    );
    return { status: 0, body: null, url };
  } finally {
    clearTimeout(timer);
  }
}

async function loadRobots(host: string): Promise<void> {
  const state = getHostState(host);
  state.robotsLoaded = true;
  const { body } = await rawFetch(
    `https://${host}/robots.txt`,
    { method: "GET", ua: UA_BOT },
    state,
  );
  if (!body) return;
  let inStar = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) {
      inStar = ua[1].trim() === "*";
      continue;
    }
    if (!inStar) continue;
    const dis = line.match(/^disallow:\s*(.+)$/i);
    if (dis) {
      const path = dis[1].trim();
      if (path) state.robotsDisallow.push(path);
    }
  }
}

interface PoliteFetchOptions {
  method?: "GET" | "POST";
  body?: string;
  contentType?: string;
  acceptHtml?: boolean;
}

async function politeFetch(
  url: string,
  opts: PoliteFetchOptions = {},
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const state = getHostState(parsed.host);
  const method = opts.method ?? "GET";

  const run = async (): Promise<string | null> => {
    if (!state.robotsLoaded) await loadRobots(parsed.host);
    const pathname = parsed.pathname;
    for (const rule of state.robotsDisallow) {
      if (rule === "/" || pathname.startsWith(rule)) return null;
    }
    const since = Date.now() - state.lastFetchAt;
    if (since < THROTTLE_MS) await sleep(THROTTLE_MS - since);
    state.lastFetchAt = Date.now();

    const init: RawFetchInit = {
      method,
      ua: state.useChromeUa ? UA_CHROME : UA_BOT,
      body: opts.body,
      contentType: opts.contentType,
      acceptHtml: opts.acceptHtml,
    };
    let res = await rawFetch(url, init, state);
    if (res.status === 403 && !state.useChromeUa) {
      state.useChromeUa = true;
      state.lastFetchAt = Date.now();
      res = await rawFetch(url, { ...init, ua: UA_CHROME }, state);
    }
    if (res.status >= 400 || !res.body) return null;
    return res.body;
  };

  const result = state.queue.then(run, run);
  state.queue = result.catch(() => undefined);
  return result;
}

// -----------------------------------------------------------------------------
// Shared adapter contract
// -----------------------------------------------------------------------------

/**
 * Every provincial adapter produces `ScrapedProfessional` rows directly
 * (via `normalise()`), reporting how many HTTP requests it issued. The
 * dispatcher handles telemetry and sink upsert.
 */
export interface ColegioAdapter {
  code: string;
  colegioFull: string;
  provincia: string;
  /**
   * City slug (must exist in public.cities) used as the bucket for every
   * row — sink drops unknown slugs. Provincial colegios cover a whole
   * province, but our landings are city-indexed, so we attach all rows
   * to the provincial capital.
   */
  citySlug: string;
  /** Public buscador URL for `metadata.source_url`. */
  sourceUrl: string;
  run(budget: { remaining: number }): Promise<{
    rows: ScrapedProfessional[];
    fetched: number;
  }>;
}

function titleCase(raw: string): string {
  return raw
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((t) =>
      /\s+|-/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1),
    )
    .join("");
}

/** Decode HTML entities we actually see in colegio listings. */
function decodeEntities(s: string): string {
  return s
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/&uuml;/gi, "ü")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Split "APELLIDOS, NOMBRE" → { apellidos, nombre } with fallbacks. */
function splitColegiadoName(raw: string): { nombre: string; apellidos: string } {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.includes(",")) {
    const [ap, nom] = cleaned.split(",", 2);
    return {
      apellidos: titleCase(ap.trim()),
      nombre: titleCase((nom ?? "").trim()),
    };
  }
  // No comma — treat the last word as nombre (conservative fallback).
  const parts = cleaned.split(/\s+/);
  if (parts.length <= 1) return { apellidos: "", nombre: titleCase(cleaned) };
  return {
    apellidos: titleCase(parts.slice(0, -1).join(" ")),
    nombre: titleCase(parts.slice(-1)[0]),
  };
}

// -----------------------------------------------------------------------------
// COMZ (Zaragoza) adapter — JSON POST to ventanilla-publica
// -----------------------------------------------------------------------------

interface ComzRow {
  numeroColegiado: string;
  nombre: string;
  apellido1: string;
  apellido2: string;
  titulo: string;
  vpc: string;
  fechaEmision: string | null;
  fechaExpiracion: string | null;
  tipomodalidadejercicio: string;
  nombrecentro: string;
  direccioncentro: string;
  codigopostalcentro: string;
  localidadcentro: string;
  nombreprivada: string;
  tipoviaprivada: string;
  direccionprivada: string;
  codigopostalprivada: string;
  localidadprivada: string;
  titulomir: string;
}

interface ComzResponse {
  estado?: { codigo?: number; descripcion?: string };
  datos?: ComzRow[];
}

const COMZ_URL =
  "https://www.comz.org/Procesar/procesar.php" +
  "?controller=ControllerVentanillaPublica&consulta=1";

/**
 * Observed non-empty counts for 3-digit prefixes (see module history):
 *   500=2541, 501=4851, 502=677, 503=269, 504=414, 505=7189,
 *   506=21, 507=19, 508=24, 509=196, 510=28.
 * Expand 500/501/504/505 to 4-digit buckets for the ~7k response cap.
 */
function comzPrefixes(): string[] {
  const out: string[] = [];
  for (const top of ["500", "501", "504", "505"]) {
    for (let d = 0; d <= 9; d += 1) out.push(`${top}${d}`);
  }
  for (const p of ["502", "503", "506", "507", "508", "509", "510"]) {
    out.push(p);
  }
  return out;
}

function buildComzAddress(row: ComzRow): string | undefined {
  if (row.direccioncentro && row.localidadcentro) {
    const parts = [
      row.direccioncentro,
      row.codigopostalcentro,
      row.localidadcentro,
    ].filter((s) => s && s.trim().length > 0);
    return parts.join(", ");
  }
  if (row.direccionprivada && row.localidadprivada) {
    const parts = [
      row.direccionprivada,
      row.codigopostalprivada,
      row.localidadprivada,
    ].filter((s) => s && s.trim().length > 0);
    return parts.join(", ");
  }
  return undefined;
}

function comzRowToProfessional(row: ComzRow): ScrapedProfessional | undefined {
  if (!row.numeroColegiado || !row.nombre || !row.apellido1) return undefined;
  const fullName = [row.nombre, row.apellido1, row.apellido2]
    .filter((s) => s && s.trim().length > 0)
    .map((s) => titleCase(s.trim()))
    .join(" ");
  if (!fullName) return undefined;

  const specialty = row.titulo?.trim() || undefined;
  return normalise({
    source: "com_zaragoza",
    country: "ES",
    sourceId: row.numeroColegiado,
    name: fullName,
    categoryKey: "medicina" satisfies CategoryKey,
    citySlug: "zaragoza",
    licenseNumber: row.numeroColegiado,
    headline: specialty,
    address: buildComzAddress(row),
    metadata: {
      colegio: "COMZ",
      colegio_full: "Colegio Oficial de Médicos de Zaragoza",
      provincia: "Zaragoza",
      verified_by_colegio: true,
      specialty,
      centro: row.nombrecentro || undefined,
      tipo_ejercicio: row.tipomodalidadejercicio || undefined,
      mir_titulo: row.titulomir || undefined,
      source_url: "https://www.comz.org/buscador-colegiados",
    },
  });
}

const comzAdapter: ColegioAdapter = {
  code: "zaragoza",
  colegioFull: "Colegio Oficial de Médicos de Zaragoza",
  provincia: "Zaragoza",
  citySlug: "zaragoza",
  sourceUrl: "https://www.comz.org/buscador-colegiados",
  async run(budget) {
    const out = new Map<string, ScrapedProfessional>();
    let fetched = 0;
    for (const prefix of comzPrefixes()) {
      if (budget.remaining <= 0) break;
      budget.remaining -= 1;
      fetched += 1;
      const body = `nombre=&apellidos=&numeroColegiado=${encodeURIComponent(
        prefix,
      )}`;
      const text = await politeFetch(COMZ_URL, {
        method: "POST",
        body,
      });
      if (!text) continue;
      let parsed: ComzResponse;
      try {
        parsed = JSON.parse(text) as ComzResponse;
      } catch {
        continue;
      }
      if (parsed.estado?.codigo !== 200) continue;
      const datos = parsed.datos ?? [];
      for (const row of datos) {
        const pro = comzRowToProfessional(row);
        if (!pro) continue;
        if (out.has(pro.sourceId)) continue;
        out.set(pro.sourceId, pro);
      }
      console.log(
        `[omc-zaragoza] prefix=${prefix} datos=${datos.length} ` +
          `unique=${out.size} budget=${budget.remaining}`,
      );
    }
    return { rows: [...out.values()], fetched };
  },
};

// -----------------------------------------------------------------------------
// ICOMEM (Madrid) adapter — form POST → redirect → paginated <tr>
// -----------------------------------------------------------------------------

const ICOMEM_BUSCADOR =
  "https://www.icomem.es/ventanilla-unica/buscador-colegiados";

/**
 * Parse ICOMEM's `<tr class="linea_colegiado">` rows. Structure:
 *
 *   <tr class="linea_colegiado" data-id='N' ...>
 *     <td>282889049</td>                 ← numColegiado
 *     <td>APELLIDOS, NOMBRE</td>
 *     <td class="text-center">...</td>   ← activo
 *   </tr>
 */
function parseIcomemRows(
  html: string,
): Array<{ numColegiado: string; name: string }> {
  const out: Array<{ numColegiado: string; name: string }> = [];
  const rowRe =
    /<tr class="linea_colegiado"[^>]*>\s*<td>\s*([0-9]+)\s*<\/td>\s*<td>\s*([^<]+?)\s*<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    out.push({
      numColegiado: m[1].trim(),
      name: decodeEntities(m[2]),
    });
  }
  return out;
}

/** Returns the max pagination number visible on the results page. */
function parseIcomemMaxPage(html: string): number {
  let max = 1;
  const re = /title="Página (\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function icomemRowToProfessional(
  r: { numColegiado: string; name: string },
): ScrapedProfessional | undefined {
  const { nombre, apellidos } = splitColegiadoName(r.name);
  if (!nombre && !apellidos) return undefined;
  const fullName = [nombre, apellidos].filter((s) => s).join(" ").trim();
  if (!fullName) return undefined;
  return normalise({
    source: "com_madrid",
    country: "ES",
    sourceId: r.numColegiado,
    name: fullName,
    categoryKey: "medicina" satisfies CategoryKey,
    citySlug: "madrid",
    licenseNumber: r.numColegiado,
    metadata: {
      colegio: "ICOMEM",
      colegio_full: "Ilustre Colegio Oficial de Médicos de Madrid",
      provincia: "Madrid",
      verified_by_colegio: true,
      source_url: ICOMEM_BUSCADOR,
    },
  });
}

/**
 * Alphabet sweep: surname-prefix letters that partition the ~48k
 * ICOMEM dataset. Each letter returns up to ~1.9k pages (14 rows/page),
 * so we cap by the caller's budget. The initial POST resolves to a
 * query-stateful session (cookie-backed), then subsequent GETs on
 * `/pag/N` page through the same result set.
 */
const ICOMEM_LETTERS = "abcdefghijklmnñopqrstuvwxyz".split("");

const icomemAdapter: ColegioAdapter = {
  code: "madrid",
  colegioFull: "Ilustre Colegio Oficial de Médicos de Madrid",
  provincia: "Madrid",
  citySlug: "madrid",
  sourceUrl: ICOMEM_BUSCADOR,
  async run(budget) {
    const out = new Map<string, ScrapedProfessional>();
    let fetched = 0;

    for (const letter of ICOMEM_LETTERS) {
      if (budget.remaining <= 0) break;
      // 1) POST the letter surname filter. Response is a 303 redirect
      //    back to the buscador page (fetch follows automatically) and
      //    sets a session cookie that binds the query.
      budget.remaining -= 1;
      fetched += 1;
      const firstBody =
        `enviar=1&apellido1=${encodeURIComponent(letter)}` +
        `&apellido2=&nombre=&num_colegiado=&especialidad=`;
      const firstHtml = await politeFetch(ICOMEM_BUSCADOR, {
        method: "POST",
        body: firstBody,
        acceptHtml: true,
      });
      if (!firstHtml) continue;
      for (const r of parseIcomemRows(firstHtml)) {
        const pro = icomemRowToProfessional(r);
        if (pro && !out.has(pro.sourceId)) out.set(pro.sourceId, pro);
      }
      const maxPage = parseIcomemMaxPage(firstHtml);

      // 2) Page 2..maxPage via GET. Real cap enforced by budget; stop
      //    early if a page yields zero new rows (pagination drift).
      for (let p = 2; p <= maxPage; p += 1) {
        if (budget.remaining <= 0) break;
        budget.remaining -= 1;
        fetched += 1;
        const pageUrl = `${ICOMEM_BUSCADOR}/pag/${p}`;
        const pageHtml = await politeFetch(pageUrl, { acceptHtml: true });
        if (!pageHtml) continue;
        let added = 0;
        for (const r of parseIcomemRows(pageHtml)) {
          const pro = icomemRowToProfessional(r);
          if (pro && !out.has(pro.sourceId)) {
            out.set(pro.sourceId, pro);
            added += 1;
          }
        }
        if (added === 0) break; // session expired or pagination drift
      }
      console.log(
        `[omc-madrid] letter=${letter} maxPage=${maxPage} ` +
          `unique=${out.size} budget=${budget.remaining}`,
      );
    }

    return { rows: [...out.values()], fetched };
  },
};

// -----------------------------------------------------------------------------
// COMGI (Gipuzkoa) adapter — GET pagination on ASP.NET page
// -----------------------------------------------------------------------------

const COMGI_BASE =
  "https://www.comgi.eus/Default.aspx?lng=ES&mod=gisep&sec=colegiados&num=0&esp=0&eje=0&ter=0";

/**
 * Parse `<div class="elemento ...">` blocks from the COMGI page.
 * Shape:
 *   <div class="elemento [par]">
 *     <span class="num">202009235</span>
 *     <span class="nom">APELLIDOS, NOMBRE</span>
 *     <div class="well well-sm">
 *       <div class="row">
 *         <div class="col-md-6 esp">...Especialidades: <li>...</li>...</div>
 *         <div class="col-md-6 ter">...Áreas: <li>...</li>...</div>
 *       </div>
 *     </div>
 *   </div>
 */
function parseComgiBlocks(html: string): Array<{
  num: string;
  name: string;
  especialidad?: string;
}> {
  const out: Array<{ num: string; name: string; especialidad?: string }> = [];
  // Greedy boundary via next "elemento" / end-of-pagination.
  const re =
    /<div class="elemento(?:\s+par)?">\s*<span class="num">\s*([0-9]+)\s*<\/span>\s*<span class="nom">\s*([^<]+?)\s*<\/span>([\s\S]*?)(?=<div class="elemento"|<div class="elemento par"|<ul class="pagination"|<\/div>\s*<ul class="pagination")/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tail = m[3] ?? "";
    const espMatch = tail.match(
      /Especialidades:\s*<\/span>\s*<ul>\s*<li>\s*([^<]+?)\s*<\/li>/i,
    );
    out.push({
      num: m[1].trim(),
      name: decodeEntities(m[2]),
      especialidad: espMatch ? decodeEntities(espMatch[1]).trim() : undefined,
    });
  }
  return out;
}

function parseComgiMaxPage(html: string): number {
  let max = 1;
  const re = /pagGC=(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function comgiRowToProfessional(r: {
  num: string;
  name: string;
  especialidad?: string;
}): ScrapedProfessional | undefined {
  const { nombre, apellidos } = splitColegiadoName(r.name);
  if (!nombre && !apellidos) return undefined;
  const fullName = [nombre, apellidos].filter((s) => s).join(" ").trim();
  if (!fullName) return undefined;
  const specialty = r.especialidad ? titleCase(r.especialidad) : undefined;
  return normalise({
    source: "com_gipuzkoa",
    country: "ES",
    sourceId: r.num,
    name: fullName,
    categoryKey: "medicina" satisfies CategoryKey,
    citySlug: "san-sebastian",
    licenseNumber: r.num,
    headline: specialty,
    metadata: {
      colegio: "COMGI",
      colegio_full: "Colegio Oficial de Médicos de Gipuzkoa",
      provincia: "Gipuzkoa",
      verified_by_colegio: true,
      specialty,
      source_url: COMGI_BASE,
    },
  });
}

const comgiAdapter: ColegioAdapter = {
  code: "gipuzkoa",
  colegioFull: "Colegio Oficial de Médicos de Gipuzkoa",
  provincia: "Gipuzkoa",
  citySlug: "san-sebastian",
  sourceUrl: COMGI_BASE,
  async run(budget) {
    const out = new Map<string, ScrapedProfessional>();
    let fetched = 0;

    // Probe page 1 to discover total pagination count.
    if (budget.remaining <= 0) return { rows: [], fetched };
    budget.remaining -= 1;
    fetched += 1;
    const firstHtml = await politeFetch(`${COMGI_BASE}&pagGC=1`, {
      acceptHtml: true,
    });
    if (!firstHtml) return { rows: [], fetched };
    for (const r of parseComgiBlocks(firstHtml)) {
      const pro = comgiRowToProfessional(r);
      if (pro && !out.has(pro.sourceId)) out.set(pro.sourceId, pro);
    }
    const maxPage = parseComgiMaxPage(firstHtml);

    for (let p = 2; p <= maxPage; p += 1) {
      if (budget.remaining <= 0) break;
      budget.remaining -= 1;
      fetched += 1;
      const pageHtml = await politeFetch(`${COMGI_BASE}&pagGC=${p}`, {
        acceptHtml: true,
      });
      if (!pageHtml) continue;
      let added = 0;
      for (const r of parseComgiBlocks(pageHtml)) {
        const pro = comgiRowToProfessional(r);
        if (pro && !out.has(pro.sourceId)) {
          out.set(pro.sourceId, pro);
          added += 1;
        }
      }
      if (added === 0) break;
      if (p % 10 === 0) {
        console.log(
          `[omc-gipuzkoa] page=${p}/${maxPage} unique=${out.size} ` +
            `budget=${budget.remaining}`,
        );
      }
    }

    console.log(
      `[omc-gipuzkoa] done unique=${out.size} fetched=${fetched}`,
    );
    return { rows: [...out.values()], fetched };
  },
};

// -----------------------------------------------------------------------------
// Dispatcher
// -----------------------------------------------------------------------------

const COLEGIOS: Record<string, ColegioAdapter> = {
  zaragoza: comzAdapter,
  madrid: icomemAdapter,
  gipuzkoa: comgiAdapter,
};

function parseOnlyFilter(): Set<string> | null {
  const raw = process.env.PROLIO_COLEGIOS_MEDICOS_ONLY?.trim();
  if (!raw) return null;
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.size === 0 ? null : set;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface CompetitorEsColegiosMedicosResult {
  fetched: number;
  parsed: number;
  inserted: number;
  updated: number;
  skipped: number;
  /** Per-colegio breakdown (by code). */
  perColegio: Record<
    string,
    { fetched: number; parsed: number; inserted: number; updated: number; skipped: number }
  >;
}

export function competitorEsColegiosMedicosEnabled(): boolean {
  // Accept both the legacy and the new, shorter env name. Legacy remains
  // the canonical one in .github/workflows/scrape.yml.
  return (
    process.env.PROLIO_RUN_COMPETITOR_ES_COLEGIOS_MEDICOS === "true" ||
    process.env.PROLIO_RUN_COLEGIOS_MEDICOS === "true"
  );
}

export async function runCompetitorEsColegiosMedicos(): Promise<CompetitorEsColegiosMedicosResult> {
  const limit = Number(
    process.env.PROLIO_COLEGIOS_MEDICOS_LIMIT ??
      process.env.PROLIO_COMPETITOR_ES_COLEGIOS_MEDICOS_LIMIT ??
      String(DEFAULT_BUDGET),
  );
  const perColegioBudget =
    Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_BUDGET;

  const only = parseOnlyFilter();
  const codes = Object.keys(COLEGIOS).filter((c) => (only ? only.has(c) : true));

  console.log(
    `[competitor-es-colegios-medicos] starting — ` +
      `adapters=[${codes.join(",")}] per_colegio_budget=${perColegioBudget}`,
  );

  const sink = getSink();
  const perColegio: CompetitorEsColegiosMedicosResult["perColegio"] = {};
  let totals = {
    fetched: 0,
    parsed: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
  };

  for (const code of codes) {
    const adapter = COLEGIOS[code];
    // One scrape_runs row per colegio so per-province yield is visible
    // in /admin. Telemetry failures are swallowed inside withScrapeRun.
    await withScrapeRun(`omc-${code}`, async () => {
      const budget = { remaining: perColegioBudget };
      let fetched = 0;
      let rows: ScrapedProfessional[] = [];
      try {
        const res = await adapter.run(budget);
        rows = res.rows;
        fetched = res.fetched;
      } catch (err) {
        console.warn(
          `[omc-${code}] adapter crashed: ${(err as Error).message}`,
        );
        throw err;
      }
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      if (rows.length > 0) {
        const s = await sink.upsert(rows);
        inserted = s.inserted;
        updated = s.updated;
        skipped = s.skipped;
      }
      perColegio[code] = {
        fetched,
        parsed: rows.length,
        inserted,
        updated,
        skipped,
      };
      totals.fetched += fetched;
      totals.parsed += rows.length;
      totals.inserted += inserted;
      totals.updated += updated;
      totals.skipped += skipped;
      console.log(
        `[omc-${code}] done fetched=${fetched} parsed=${rows.length} ` +
          `inserted=${inserted} updated=${updated} skipped=${skipped}`,
      );
      return {
        rowsFetched: fetched,
        rowsUpserted: inserted + updated,
        rowsSkipped: skipped,
        metadata: {
          colegio: adapter.colegioFull,
          provincia: adapter.provincia,
          city_slug: adapter.citySlug,
        },
      };
    }).catch((e) =>
      console.error(`[omc-${code}] crashed: ${(e as Error).message}`),
    );
  }

  console.log(
    `[competitor-es-colegios-medicos] done — fetched=${totals.fetched} ` +
      `parsed=${totals.parsed} inserted=${totals.inserted} ` +
      `updated=${totals.updated} skipped=${totals.skipped}`,
  );

  return { ...totals, perColegio };
}
