import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * Verificación Vehicular Estado de México.
 *
 *   http://citaverificacion.edomex.gob.mx/
 *
 * Portal del Edomex (Tomcat antiguo). Publica el listado oficial de
 * ~80 verificentros con nombre, dirección, municipio y teléfono.
 *
 * Implementación: HTML scraping del listado.
 *
 * Off by default. `PROLIO_RUN_VERIFICACION_EDOMEX=true`.
 * Cap with `PROLIO_VERIFICACION_EDOMEX_LIMIT` (default 200).
 */

const BASE_URL =
  process.env.PROLIO_VERIFICACION_EDOMEX_URL ||
  "http://citaverificacion.edomex.gob.mx/verificentros.html";
const DEFAULT_LIMIT = 200;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "itv";

/** Edomex municipios mapped to seeded MX city slugs. */
const MUNICIPIO_TO_CITY: Record<string, string> = {
  "naucalpan": "naucalpan",
  "naucalpan-de-juarez": "naucalpan",
  "tlalnepantla": "tlalnepantla",
  "tlalnepantla-de-baz": "tlalnepantla",
  "toluca": "toluca",
  "toluca-de-lerdo": "toluca",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  let response: Response;
  try {
    response = await fetch(BASE_URL, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[verificacion-edomex] network error: ${(error as Error).message}`);
    return out;
  }
  if (!response.ok) {
    console.error(`[verificacion-edomex] ${response.status} on ${BASE_URL}`);
    return out;
  }
  const html = await response.text();

  // Parse rows: <tr><td>NUM</td><td>NOMBRE</td><td>DIRECCION</td><td>MUNICIPIO</td><td>TEL</td></tr>
  const ROW_RE =
    /<tr[^>]*>\s*<td[^>]*>\s*([^<]{1,12})\s*<\/td>\s*<td[^>]*>([^<]{4,200})<\/td>\s*<td[^>]*>([^<]{4,200})<\/td>\s*<td[^>]*>([^<]{2,80})<\/td>(?:\s*<td[^>]*>([^<]{0,40})<\/td>)?/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = ROW_RE.exec(html)) !== null) {
    if (out.length >= limit) break;
    const num = stripHtml(m[1]);
    const nombre = stripHtml(m[2]);
    const direccion = stripHtml(m[3]);
    const municipio = stripHtml(m[4]);
    const telefono = m[5] ? stripHtml(m[5]) : undefined;
    if (!num || !/^\d+$/.test(num.replace(/[^\d]/g, "")) || !nombre) continue;
    const sid = `verif-edomex:${num}`;
    if (seen.has(sid)) continue;
    seen.add(sid);
    const muniSlug = slugify(municipio);
    const citySlug = MUNICIPIO_TO_CITY[muniSlug] ?? "tlalnepantla";
    out.push(
      normalise({
        source: "verificacion-edomex" as ScrapeSource,
        sourceId: sid,
        name: nombre,
        categoryKey: CATEGORY,
        citySlug,
        address: direccion,
        phone: telefono,
        licenseNumber: num,
        metadata: {
          country: "MX",
          authority: "SMA-EDOMEX",
          verified_by_authority: true,
          municipio,
        },
      }),
    );
  }
  console.log(`[verificacion-edomex] parsed=${out.length}`);
  return out;
}

export const verificacionEdomexEnabled = (): boolean =>
  process.env.PROLIO_RUN_VERIFICACION_EDOMEX === "true";

export const verificacionEdomexSource: ScraperSource = {
  name: "verificacion-edomex" as ScrapeSource,
  enabled: verificacionEdomexEnabled,
  async fetch() {
    return [];
  },
};

export async function runVerificacionEdomex(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!verificacionEdomexEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("verificacion-edomex", async () => {
    const rawLimit = Number(process.env.PROLIO_VERIFICACION_EDOMEX_LIMIT ?? DEFAULT_LIMIT);
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
