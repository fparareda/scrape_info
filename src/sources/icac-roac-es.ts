import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * ICAC — Registro Oficial de Auditores de Cuentas (ROAC).
 *
 * Instituto de Contabilidad y Auditoría de Cuentas (ICAC) is Spain's
 * official accounting and audit regulator. The ROAC is the mandatory
 * national registry of all statutory auditors and audit societies.
 *
 * Pre-flight (2026-05-22):
 *
 *   consejodentistas.es — REROUTED.
 *     The national dentist council's buscador redirects to guiadentistas.es,
 *     which is already in the repo as `guiadentistas-es`. No new endpoint.
 *
 *   registrodemediadores.dgsfp.mineco.gob.es — BLOCKED.
 *     ECONNREFUSED from datacenter IP. TCP connection refused outright.
 *     Not accessible from GitHub Actions runners.
 *
 *   ICAC ROAC (www.icac.gob.es/buscador-roac) — VIABLE / BUILT.
 *     robots.txt allows `/roac/` — only disallows `/admin/`, `/user/`,
 *     `/search/`, `/servicios-roac/sanciones`. Confirmed: 2026-05-22.
 *     The Drupal CMS at /buscador-roac embeds a legacy PHP iframe at
 *     /roac/consultas/busqueda1.php. That PHP page POSTs search parameters
 *     to roac_001.php, which returns a server-rendered HTML table —
 *     no JS required, no auth token.
 *     Data quality:
 *       - ~3,451 ejerciente (practicing) individual auditors.
 *       - ~1,338 registered audit societies (Sociedad de Auditoría).
 *       - Total ~4,789 active entities; full roll ~9,197 (includes inactive).
 *       - Server has a 10,000-row cap; fetching ejerciente and sociedad
 *         separately keeps both under the cap.
 *       - Fields from list: ROAC number, full name, province, status.
 *         (Detail page roac_002.php carries address + website but would
 *         require ~4,789 additional requests — not fetched in this pass.)
 *     Category: `fiscal` — statutory financial auditing maps to the fiscal
 *     professional category, same rationale as `graduados-sociales-es`.
 *     No Cloudflare/CAPTCHA/login wall detected.
 *
 * Off by default. Enable via `PROLIO_RUN_ICAC_ROAC_ES=true`.
 * Cap: `PROLIO_ICAC_ROAC_ES_LIMIT` (default 5000).
 * Schedule: monthly (ROAC rolls update annually).
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_LIMIT = 5000;
const ROAC_POST_URL =
  "https://www.icac.gob.es/roac/consultas/roac_001.php";
const CATEGORY: CategoryKey = "fiscal";

// --- Province → city-slug mapping for ES provinces ----------------------
// Maps the province names as returned by ROAC (uppercase) to Prolio city slugs.
// The slug is the capital city of each province (Prolio convention for
// province-level data with no finer granularity).
const PROVINCE_TO_CITY: Record<string, string> = {
  "ALAVA": "vitoria-gasteiz",
  "ÁLAVA": "vitoria-gasteiz",
  "ALBACETE": "albacete",
  "ALICANTE": "alicante",
  "ALMERIA": "almeria",
  "ALMERÍA": "almeria",
  "ASTURIAS": "oviedo",
  "AVILA": "avila",
  "ÁVILA": "avila",
  "BADAJOZ": "badajoz",
  "BARCELONA": "barcelona",
  "BURGOS": "burgos",
  "CACERES": "caceres",
  "CÁCERES": "caceres",
  "CADIZ": "cadiz",
  "CÁDIZ": "cadiz",
  "CANTABRIA": "santander",
  "CASTELLON": "castellon-de-la-plana",
  "CASTELLÓN": "castellon-de-la-plana",
  "CEUTA": "ceuta",
  "CIUDAD REAL": "ciudad-real",
  "CORDOBA": "cordoba",
  "CÓRDOBA": "cordoba",
  "CUENCA": "cuenca",
  "GIRONA": "girona",
  "GRANADA": "granada",
  "GUADALAJARA": "guadalajara-es",
  "GIPUZKOA": "donostia-san-sebastian",
  "HUELVA": "huelva",
  "HUESCA": "huesca",
  "ILLES BALEARS": "palma",
  "JAEN": "jaen",
  "JAÉN": "jaen",
  "LA RIOJA": "logrono",
  "LAS PALMAS": "las-palmas-de-gran-canaria",
  "LEON": "leon-es",
  "LEÓN": "leon-es",
  "LLEIDA": "lleida",
  "LUGO": "lugo",
  "MADRID": "madrid",
  "MALAGA": "malaga",
  "MÁLAGA": "malaga",
  "MELILLA": "melilla",
  "MURCIA": "murcia",
  "NAVARRA": "pamplona",
  "OURENSE": "ourense",
  "PALENCIA": "palencia",
  "PONTEVEDRA": "pontevedra",
  "A CORUÑA": "a-coruna",
  "SALAMANCA": "salamanca",
  "SANTA CRUZ DE TENERIFE": "santa-cruz-de-tenerife",
  "SEGOVIA": "segovia",
  "SEVILLA": "sevilla",
  "SORIA": "soria",
  "TARRAGONA": "tarragona",
  "TERUEL": "teruel",
  "TOLEDO": "toledo",
  "VALENCIA": "valencia",
  "VALLADOLID": "valladolid",
  "BIZKAIA": "bilbao",
  "ZAMORA": "zamora",
  "ZARAGOZA": "zaragoza",
};

// --- HTTP helpers --------------------------------------------------------

interface FetchResponse {
  status: number;
  body: string;
}

/**
 * Fetch with polite UA first; on 403/503 retry once with Chrome UA.
 * Returns null on network error so callers can skip the source cleanly.
 */
async function politeFetch(
  url: string,
  options: RequestInit = {},
): Promise<FetchResponse | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
          ...(options.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[icac-roac-es] blocked polite UA (${response.status}); retrying with Chrome UA`,
          );
          continue;
        }
        return { status: response.status, body: "" };
      }
      if (!response.ok) return { status: response.status, body: "" };
      const body = await response.text();
      return { status: response.status, body };
    } catch (error) {
      clearTimeout(timer);
      const message = (error as Error).message ?? String(error);
      console.warn(`[icac-roac-es] network error on ${url}: ${message}`);
      return null;
    }
  }
  return null;
}

async function isRobotsBlocked(url: string): Promise<boolean> {
  const { host, pathname } = new URL(url);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(`https://${host}/robots.txt`, {
      headers: { "User-Agent": POLITE_UA },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return false;
    const text = await response.text();
    return pathMatchesDisallow(pathname, text);
  } catch {
    return false;
  }
}

function pathMatchesDisallow(pathname: string, robotsTxt: string): boolean {
  const lines = robotsTxt.split(/\r?\n/);
  let inStar = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [key, ...valueParts] = line.split(":");
    if (!key) continue;
    const value = valueParts.join(":").trim();
    const k = key.toLowerCase();
    if (k === "user-agent") {
      inStar = value === "*";
    } else if (k === "disallow" && inStar && value) {
      if (value === "/") return true;
      if (pathname.startsWith(value)) return true;
    }
  }
  return false;
}

// --- HTML parsing --------------------------------------------------------

interface RoacRow {
  id: string;   // ROAC number (e.g. "05962" or "S1234")
  name: string;
  province: string;
  status: string; // "Ejerciente" | "No ejerciente" | "Sociedad de Auditoría"
}

/**
 * Parse the HTML table from roac_001.php response.
 * Table rows look like:
 *   <tr><td>05962 <td>ABATI GARCÍA MANSO, RAFAEL <td>MADRID <td class='Ejerciente'>...<b>Ejerciente<td><a href='roac_002.php?nroac=05962'>Visualizar</a>
 */
function parseRoacTable(html: string): RoacRow[] {
  const rows: RoacRow[] = [];
  // Match each data row: ROAC id, name, province, status
  const rowRegex =
    /<tr><td>(S?\d+)\s*<td>([^<]+?)\s*<td>([^<]*?)\s*<td[^>]*>\s*<div[^>]*><\/div>\s*<b>([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = rowRegex.exec(html)) !== null) {
    const id = m[1].trim();
    const name = m[2].trim();
    const province = m[3].trim();
    const status = m[4].trim();
    if (id && name) {
      rows.push({ id, name, province, status });
    }
  }
  return rows;
}

function provinceToCitySlug(province: string): string {
  if (!province) return "";
  const upper = province.toUpperCase().trim();
  return PROVINCE_TO_CITY[upper] ?? "";
}

// --- Main fetch logic ----------------------------------------------------

async function fetchRoacByType(
  tipo: "Auditor" | "Sociedad",
  situacion: string,
): Promise<RoacRow[]> {
  const body = new URLSearchParams({
    Auth: "12345678",
    nombre: "",
    tipo,
    situacion,
    provincia: "",
  });

  const result = await politeFetch(ROAC_POST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!result || result.status !== 200 || !result.body) {
    console.warn(`[icac-roac-es] fetch failed for tipo=${tipo}: status=${result?.status ?? "null"}`);
    return [];
  }

  const rows = parseRoacTable(result.body);
  console.log(`[icac-roac-es] tipo=${tipo} situacion=${situacion} → ${rows.length} rows`);
  return rows;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  // Check robots.txt
  const blocked = await isRobotsBlocked(ROAC_POST_URL);
  if (blocked) {
    console.error("[icac-roac-es] robots.txt disallows this path — aborting");
    return [];
  }

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();

  // Fetch practicing individual auditors (ejerciente)
  const auditorRows = await fetchRoacByType("Auditor", "1");
  // Fetch all audit societies (no situacion filter — societies have no status)
  const sociedadRows = await fetchRoacByType("Sociedad", "-1");

  const allRows = [...auditorRows, ...sociedadRows];

  for (const row of allRows) {
    if (out.length >= limit) break;
    const sourceId = `icac-roac:${row.id}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const citySlug = provinceToCitySlug(row.province);
    const isSociedad = row.id.startsWith("S");

    out.push(
      normalise({
        source: "icac-roac-es",
        country: "ES",
        sourceId,
        name: row.name,
        categoryKey: CATEGORY,
        citySlug,
        licenseNumber: row.id,
        metadata: {
          authority: "ICAC",
          registry: "ROAC",
          verified_by_authority: true,
          status: row.status,
          tipo: isSociedad ? "Sociedad de Auditoría" : "Auditor",
          provincia: row.province || undefined,
          country: "ES",
        },
      }),
    );
  }

  console.log(`[icac-roac-es] parsed=${out.length} (limit=${limit})`);
  return out;
}

// --- Exports -------------------------------------------------------------

export const icacRoacEsSource: ScraperSource = {
  name: "icac-roac-es",
  enabled() {
    return process.env.PROLIO_RUN_ICAC_ROAC_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runIcacRoacEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!icacRoacEsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  return withScrapeRun("icac-roac-es", async () => {
    const rawLimit = Number(process.env.PROLIO_ICAC_ROAC_ES_LIMIT ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

    const records = await fetchAll(limit);
    if (records.length === 0) {
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    }

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
