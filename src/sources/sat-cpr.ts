import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * SAT — Contadores Públicos Registrados (CPR) ante el Servicio de
 * Administración Tributaria.
 *
 *   http://omawww.sat.gob.mx/terceros_autorizados/contadores_registrados/Paginas/default.aspx
 *
 * Public roster of ~20k contadores autorizados to issue dictamen
 * fiscal. The search form supports 5 query modes; the most efficient
 * for full enumeration is "rango de número de registro" — sequential
 * integer IDs from 1..N.
 *
 * STUB CAVEAT: the public form is a SharePoint ASPX with ViewState
 * postbacks. A robust implementation needs cookie + __VIEWSTATE +
 * __EVENTVALIDATION juggling, which is fragile. This file ships the
 * skeleton + page-walker; on a CI run it logs "0 records" until the
 * postback logic is wired (TODO below).
 *
 * Off by default. `PROLIO_RUN_SAT_CPR=true`. Cap with
 * `PROLIO_SAT_CPR_LIMIT` (default 5000).
 */

const BASE_URL =
  process.env.PROLIO_SAT_CPR_BASE ||
  "http://omawww.sat.gob.mx/terceros_autorizados/contadores_registrados/Paginas/default.aspx";
const DEFAULT_LIMIT = 5_000;
const REQUEST_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const POLITE_UA =
  "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "fiscal";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function politeFetch(url: string, init?: RequestInit): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.5",
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[sat-cpr] ${res.status} on ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[sat-cpr] network error: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Range-based enumeration. For now: fetch the landing page to confirm
 * reachability; full postback search is a TODO requiring ASPX
 * ViewState handling that we don't want to ship as a brittle hack.
 */
async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const indexHtml = await politeFetch(BASE_URL);
  if (!indexHtml) {
    console.warn(`[sat-cpr] landing page unreachable`);
    return out;
  }

  // TODO: implement the ASPX postback search using rango de registro
  // [1..rangeEnd] in pages of e.g. 500. Each search response renders
  // a results table; rows look like:
  //   <td>00012345</td><td>NOMBRE COMPLETO</td><td>RFC</td><td>ESTADO</td>
  // We parse and emit one record per row.
  const RANGO_START = Number(process.env.PROLIO_SAT_CPR_START ?? 1);
  const RANGO_END = Number(process.env.PROLIO_SAT_CPR_END ?? limit);
  const PAGE_SIZE = 500;
  console.log(
    `[sat-cpr] STUB — would enumerate rango ${RANGO_START}..${RANGO_END} in pages of ${PAGE_SIZE}`,
  );

  // Skeleton row emitter — exercised only if a range-export plain
  // endpoint is discovered. Leaves empty result in default config.
  const TABLE_ROW_RE =
    /<tr[^>]*>\s*<td[^>]*>\s*(\d{4,8})\s*<\/td>\s*<td[^>]*>\s*([^<]{4,120})\s*<\/td>(?:\s*<td[^>]*>\s*([^<]*)\s*<\/td>){0,4}/gi;

  let m: RegExpExecArray | null;
  while ((m = TABLE_ROW_RE.exec(indexHtml)) !== null) {
    if (out.length >= limit) break;
    const cpr = m[1];
    const name = m[2].trim();
    const stateRaw = (m[3] ?? "").trim();
    const citySlug = mxStateToCity(stateRaw) ?? "cdmx";
    out.push(
      normalise({
        source: "sat-cpr" as ScrapeSource,
        sourceId: `sat-cpr:${cpr}`,
        name,
        categoryKey: CATEGORY,
        citySlug,
        licenseNumber: cpr,
        metadata: {
          country: "MX",
          authority: "SAT",
          verified_by_authority: true,
          state: stateRaw,
        },
      }),
    );
  }

  await sleep(REQUEST_DELAY_MS);
  return out;
}

export const satCprEnabled = (): boolean =>
  process.env.PROLIO_RUN_SAT_CPR === "true";

export const satCprSource: ScraperSource = {
  name: "sat-cpr" as ScrapeSource,
  enabled: satCprEnabled,
  async fetch() {
    return [];
  },
};

export async function runSatCpr(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!satCprEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("sat-cpr", async () => {
    const rawLimit = Number(process.env.PROLIO_SAT_CPR_LIMIT ?? DEFAULT_LIMIT);
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
