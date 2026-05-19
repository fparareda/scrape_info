/**
 * Helper compartido para federaciones ES tipo "Consejo General + Ventanilla
 * Única" (Ley 17/2009).
 *
 * Patrón observado en CGAE, CSCAE, CGPE, CGN: cada consejo nacional publica
 * un índice de colegios provinciales/autonómicos; cada colegio está obligado
 * por la Ley 17/2009 (Servicios y su libre prestación) a exponer un padrón
 * público de colegiados como parte de su Ventanilla Única.
 *
 * Este módulo factoriza los dos pasos comunes:
 *   1. `fetchConsejoIndex` — descarga la portada del consejo y extrae el
 *      listado de colegios (nombre + URL).
 *   2. `extractGenericPadron` — itera el padrón público de un colegio
 *      (paginación ?page=N) y devuelve filas {num, name}.
 *
 * Cada federación instancia el helper con su propia configuración: regex de
 * detección de colegios en el índice, lista hardcoded de los N colegios
 * grandes a scrapear (los chicos suelen requerir captcha/login y no merecen
 * el esfuerzo del primer pase), y categoría Prolio destino.
 *
 * Mantén el helper agnóstico — sin acoplamiento a regex específicos de un
 * colegio. Las federaciones que necesiten extractor bespoke pueden pasar uno
 * en `ColegioConfig.extractor`.
 */

import type { ScrapedProfessional } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";
import type { CategoryKey } from "../prolio-types.js";

export const CONSEJO_USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
export const CONSEJO_REQUEST_DELAY_MS = 2000;
export const CONSEJO_DEFAULT_LIMIT = 1000;
export const CONSEJO_MAX_PAGES = 200;

export interface ColegioRow {
  num: string;
  name: string;
}

export type ConsejoExtractor = (
  colegio: ConsejoColegioConfig,
  limit: number,
) => Promise<ColegioRow[]>;

export type ConsejoStatus = "A" | "B" | "C";

export interface ConsejoColegioConfig {
  slug: string;
  name: string;
  citySlug: string;
  cityName: string;
  base: string;
  padronPath?: string;
  status: ConsejoStatus;
  extractor: ConsejoExtractor | null;
  notes?: string;
}

export async function fetchHtml(url: URL | string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": CONSEJO_USER_AGENT, Accept: "text/html,*/*" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `${typeof url === "string" ? url : url.toString()} → ${response.status}`,
    );
  }
  return response.text();
}

/**
 * Two generic row patterns observed in 80%+ of "Censo / Padrón" templates:
 *   - flat HTML table: <td>NUM</td><td>APELLIDOS, NOMBRE</td>
 *   - class-tagged list: <span class="numero">NUM</span> ... <span
 *     class="nombre|colegiado|...">NAME</span>
 */
const ROW_RE_TABLE =
  /<tr[^>]*>\s*<td[^>]*>\s*(\d{2,7})\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/gi;
const ROW_RE_TAGGED =
  /(?:n[º°o]?\s*coleg[^<]*?[:>]\s*|colegiad[oa][^<]*?[:>]\s*)?(\d{2,7})[\s\S]{0,300}?<[^>]+class="[^"]*(?:nombre|name|colegiado|apellidos|titular)[^"]*"[^>]*>\s*([^<]+?)\s*</gi;

export function parseRowsLoose(html: string): ColegioRow[] {
  const out: ColegioRow[] = [];
  const seen = new Set<string>();
  for (const re of [ROW_RE_TABLE, ROW_RE_TAGGED]) {
    re.lastIndex = 0;
    for (const m of html.matchAll(re)) {
      const [, num, name] = m;
      if (!num || !name) continue;
      if (seen.has(num)) continue;
      seen.add(num);
      out.push({ num, name: name.trim() });
    }
    if (out.length > 0) break;
  }
  return out;
}

/**
 * Generic paginated extractor. Works against any colegio that publishes a
 * "Censo / Padrón" page with ?page=N pagination and either a table-shaped
 * or class-tagged HTML response. Each consejo decides the path
 * (`padronPath`) and which slugs to enable.
 */
export const consejoGenericExtractor: ConsejoExtractor = async (
  colegio,
  limit,
) => {
  const out: ColegioRow[] = [];
  const seen = new Set<string>();
  if (!colegio.padronPath) return out;
  for (let p = 1; p <= CONSEJO_MAX_PAGES; p += 1) {
    if (out.length >= limit) break;
    const url = new URL(`${colegio.base}${colegio.padronPath}`);
    if (p > 1) url.searchParams.set("page", String(p));
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      console.error(
        `[consejo-vu] ${colegio.slug} p${p} fetch: ${(e as Error).message}`,
      );
      break;
    }
    const rows = parseRowsLoose(html);
    if (rows.length === 0) break;
    let added = 0;
    for (const r of rows) {
      if (seen.has(r.num)) continue;
      seen.add(r.num);
      out.push(r);
      added += 1;
      if (out.length >= limit) break;
    }
    if (added === 0) break;
    if (p < CONSEJO_MAX_PAGES) await delay(CONSEJO_REQUEST_DELAY_MS);
  }
  return out;
};

export interface ConsejoFederationConfig {
  /** Federation slug — used as sourceId prefix + log namespace. */
  federationSlug: string;
  /** Source name (must be a ScrapeSource); typically `colegio`. */
  sourceName: import("../types.js").ScrapeSource;
  /** Authority label in metadata (e.g. "CGCFE"). */
  authority: string;
  /** Prolio category to route rows into. */
  categoryKey: CategoryKey;
  /** Hardcoded list of scrapable colegios for this consejo. */
  colegios: ConsejoColegioConfig[];
  /** Env var allowing operator to restrict to specific slugs (CSV). */
  onlyEnv?: string;
}

export function selectColegios(
  cfg: ConsejoFederationConfig,
): ConsejoColegioConfig[] {
  const onlyEnvName = cfg.onlyEnv;
  const only = (onlyEnvName ? process.env[onlyEnvName] : "") ?? "";
  if (only && only.trim()) {
    const wanted = new Set(
      only.split(",").map((s) => s.trim().toLowerCase()),
    );
    return cfg.colegios.filter((c) => wanted.has(c.slug));
  }
  return cfg.colegios.filter(
    (c) => c.status === "A" && c.extractor !== null,
  );
}

/**
 * Common fan-out runner. Each colegio is iterated in series with a polite
 * inter-colegio pause. Failures are caught per-colegio so one bad target
 * doesn't poison the rest.
 */
export async function fetchFederation(
  cfg: ConsejoFederationConfig,
  limitPerColegio: number,
): Promise<ScrapedProfessional[]> {
  const targets = selectColegios(cfg);
  console.log(
    `[${cfg.federationSlug}] fan-out: ${targets.length}/${cfg.colegios.length} colegios in scope`,
  );

  const out: ScrapedProfessional[] = [];
  for (const colegio of targets) {
    if (!colegio.extractor) continue;
    let rows: ColegioRow[] = [];
    try {
      rows = await colegio.extractor(colegio, limitPerColegio);
    } catch (error) {
      console.error(
        `[${cfg.federationSlug}] ${colegio.slug} extractor failed: ${(error as Error).message}`,
      );
      rows = [];
    }
    for (const r of rows) {
      out.push(
        normalise({
          source: cfg.sourceName,
          country: "ES",
          sourceId: `${cfg.federationSlug}:${colegio.slug}:${r.num}`,
          name: toTitleCase(r.name),
          categoryKey: cfg.categoryKey,
          citySlug: colegio.citySlug,
          licenseNumber: r.num,
          metadata: {
            country: "ES",
            authority: cfg.authority,
            colegio: colegio.slug.toUpperCase(),
            colegio_name: colegio.name,
            verified_by_authority: true,
          },
        }),
      );
    }
    console.log(
      `[${cfg.federationSlug}] ${colegio.slug} (${colegio.cityName}) → ${rows.length} rows`,
    );
    if (rows.length > 0) await delay(CONSEJO_REQUEST_DELAY_MS);
  }
  return out;
}

/**
 * Shared run wrapper. Reads the limit env, calls `fetchFederation`,
 * upserts to sink, returns the standard run summary.
 */
export async function runConsejoFederation(
  cfg: ConsejoFederationConfig,
  options: { limitEnv: string; defaultLimit?: number },
): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  const defaultLimit = options.defaultLimit ?? CONSEJO_DEFAULT_LIMIT;
  const rawLimit = Number(process.env[options.limitEnv] ?? defaultLimit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : defaultLimit;
  const records = await fetchFederation(cfg, limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[${cfg.federationSlug}] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
