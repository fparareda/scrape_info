import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * PROFEPA — Verificentros vigentes en el Estado de México.
 *
 *   https://www.gob.mx/profepa/acciones-y-programas/verificentros-vigentes-en-el-estado-de-mexico
 *
 * ~162 verificentros Edomex publicados por PROFEPA con número, razón
 * social, domicilio y municipio.
 *
 * **Estado actual (verificado 2026-05-14)**: gob.mx está detrás de un
 * challenge ("Challenge Validation" / sec-text iframe) que sirve HTML
 * de bypass JS antes del contenido real. Un fetch directo desde CI
 * recibe el challenge stub (~1.9KB) en vez de la tabla. Soluciones:
 *
 *   1. Override `PROLIO_PROFEPA_VERIFICENTROS_EDOMEX_URL` apuntando a
 *      una copia descargada (S3, raw GitHub gist, etc.) de la página
 *      cuando el HTML real está disponible.
 *   2. Si gob.mx levanta el challenge, fetch directo funciona.
 *
 * Off by default. `PROLIO_RUN_PROFEPA_VERIFICENTROS_EDOMEX=true`.
 * Cap con `PROLIO_PROFEPA_VERIFICENTROS_EDOMEX_LIMIT` (default 200).
 */

const DEFAULT_URL =
  process.env.PROLIO_PROFEPA_VERIFICENTROS_EDOMEX_URL ||
  "https://www.gob.mx/profepa/acciones-y-programas/verificentros-vigentes-en-el-estado-de-mexico";
const DEFAULT_LIMIT = 200;
const POLITE_UA =
  "Mozilla/5.0 (compatible; ScrapeInfo/1.0; +https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "itv";

/** Edomex municipios mapped to seeded MX city slugs. Fallback tlalnepantla. */
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

function looksLikeChallenge(html: string): boolean {
  return /Challenge Validation|sec-text-if|sec-cpt-if/i.test(html);
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  let response: Response;
  try {
    response = await fetch(DEFAULT_URL, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.5",
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(
      `[profepa-verificentros-edomex] network error: ${(error as Error).message}`,
    );
    return out;
  }
  if (!response.ok) {
    console.error(
      `[profepa-verificentros-edomex] ${response.status} on ${DEFAULT_URL}`,
    );
    return out;
  }
  const html = await response.text();
  if (looksLikeChallenge(html)) {
    console.warn(
      "[profepa-verificentros-edomex] gob.mx challenge page returned — set PROLIO_PROFEPA_VERIFICENTROS_EDOMEX_URL to a cached copy; skipping",
    );
    return out;
  }

  // Tabla PROFEPA: <tr><td>NUM</td><td>RAZON SOCIAL</td><td>DIRECCION</td><td>MUNICIPIO</td></tr>
  const ROW_RE =
    /<tr[^>]*>\s*<td[^>]*>\s*([^<]{1,12})\s*<\/td>\s*<td[^>]*>([^<]{4,250})<\/td>\s*<td[^>]*>([^<]{4,250})<\/td>\s*<td[^>]*>([^<]{2,80})<\/td>/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = ROW_RE.exec(html)) !== null) {
    if (out.length >= limit) break;
    const num = stripHtml(m[1]);
    const nombre = stripHtml(m[2]);
    const direccion = stripHtml(m[3]);
    const municipio = stripHtml(m[4]);
    const digits = num.replace(/[^\d]/g, "");
    if (!digits || !nombre) continue;
    const sid = `profepa-verif-edomex:${digits}`;
    if (seen.has(sid)) continue;
    seen.add(sid);
    const muniSlug = slugify(municipio);
    const citySlug = MUNICIPIO_TO_CITY[muniSlug] ?? "tlalnepantla";
    out.push(
      normalise({
        source: "profepa-verificentros-edomex" as ScrapeSource,
        country: "MX",
        sourceId: sid,
        name: nombre,
        categoryKey: CATEGORY,
        citySlug,
        address: direccion,
        licenseNumber: digits,
        metadata: {
          country: "MX",
          authority: "PROFEPA",
          verified_by_authority: true,
          municipio,
        },
      }),
    );
  }
  console.log(`[profepa-verificentros-edomex] parsed=${out.length}`);
  return out;
}

export const profepaVerificentrosEdomexEnabled = (): boolean =>
  process.env.PROLIO_RUN_PROFEPA_VERIFICENTROS_EDOMEX === "true";

export const profepaVerificentrosEdomexSource: ScraperSource = {
  name: "profepa-verificentros-edomex" as ScrapeSource,
  enabled: profepaVerificentrosEdomexEnabled,
  async fetch() {
    return [];
  },
};

export async function runProfepaVerificentrosEdomex(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!profepaVerificentrosEdomexEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("profepa-verificentros-edomex", async () => {
    const rawLimit = Number(
      process.env.PROLIO_PROFEPA_VERIFICENTROS_EDOMEX_LIMIT ?? DEFAULT_LIMIT,
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
