import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * Verificación Responsable Jalisco — Centros de Verificación.
 *
 *   https://verificacionresponsable.jalisco.gob.mx/conoce-mas/centros-de-verificacion
 *
 * **Estado actual (verificado 2026-05)**: la página es una SPA Angular
 * (Vuexy) que renderiza el contenido en el cliente. El HTML servido
 * por el servidor no contiene los 21 centros — solo un `<app-root>`
 * vacío y bundles JS (main, vendor, polyfills). El JS llama a
 * `https://api.verificacion.jalisco.gob.mx/...` pero las rutas
 * `/centros`, `/centros-verificacion`, `/api/centros`,
 * `/publico/centros`, etc. devuelven 404. La API requiere login de
 * verificador (`/sesion/ingresar-verificador`) y no expone padrón
 * público.
 *
 * Mientras no aparezca un endpoint público, el source es un stub
 * honesto: skip + warning. Si se descubre, fijar
 * `PROLIO_VERIFICACION_JALISCO_URL` con el endpoint JSON.
 *
 * Off by default. `PROLIO_RUN_VERIFICACION_JALISCO=true`.
 * Cap with `PROLIO_VERIFICACION_JALISCO_LIMIT` (default 100).
 */

const BASE_URL = process.env.PROLIO_VERIFICACION_JALISCO_URL || "";
const DEFAULT_LIMIT = 100;
const POLITE_UA = "ScrapeInfo/1.0 (+https://github.com/fparareda/scrape_info)";
const CATEGORY: CategoryKey = "itv";

const MUNICIPIO_TO_CITY: Record<string, string> = {
  "guadalajara": "guadalajara",
  "zapopan": "zapopan",
  "tlaquepaque": "guadalajara",
  "san-pedro-tlaquepaque": "guadalajara",
  "tonala": "guadalajara",
  "tlajomulco-de-zuniga": "guadalajara",
  "el-salto": "guadalajara",
  "puerto-vallarta": "guadalajara",
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
  if (!BASE_URL) {
    console.warn(
      "[verificacion-jalisco] PROLIO_VERIFICACION_JALISCO_URL not set — Jalisco SPA, no public JSON endpoint; skipping",
    );
    return out;
  }
  let response: Response;
  try {
    response = await fetch(BASE_URL, {
      headers: { "User-Agent": POLITE_UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`[verificacion-jalisco] network error: ${(error as Error).message}`);
    return out;
  }
  if (!response.ok) {
    console.error(`[verificacion-jalisco] ${response.status} on ${BASE_URL}`);
    return out;
  }
  const html = await response.text();

  // The page renders each centro as a card/block. We split on blocks
  // containing "Centro de Verificación" + name + address + tel.
  const blocks = html.split(/<(?:div|article)[^>]*class="[^"]*(?:centro|card|verificacion)[^"]*"[^>]*>/i);
  const seen = new Set<string>();
  for (let i = 1; i < blocks.length; i += 1) {
    if (out.length >= limit) break;
    const text = stripHtml(blocks[i].slice(0, 2000));
    if (text.length < 20) continue;

    const nameMatch = text.match(/(Centro de Verificación[^,.|]{2,80}|Verificentro[^,.|]{2,80})/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    const addrMatch = text.match(/(?:Dirección|Domicilio)\s*:?\s*([^|]{5,200})/i);
    const telMatch = text.match(/(?:Tel(?:éfono)?\.?)\s*:?\s*([\d\s().\-+]{7,20})/i);
    const muniMatch = text.match(/(?:Municipio|Ciudad)\s*:?\s*([A-Za-zÁÉÍÓÚáéíóúñÑ\s]{3,60})/i);

    const muniSlug = muniMatch ? slugify(muniMatch[1]) : "guadalajara";
    const citySlug = MUNICIPIO_TO_CITY[muniSlug] ?? "guadalajara";
    const sid = `verif-jalisco:${slugify(name)}`;
    if (seen.has(sid)) continue;
    seen.add(sid);

    out.push(
      normalise({
        source: "verificacion-jalisco" as ScrapeSource,
        sourceId: sid,
        name,
        categoryKey: CATEGORY,
        citySlug,
        address: addrMatch ? addrMatch[1].trim() : undefined,
        phone: telMatch ? telMatch[1].trim() : undefined,
        metadata: {
          country: "MX",
          authority: "SEMADET-JALISCO",
          verified_by_authority: true,
          municipio: muniMatch ? muniMatch[1].trim() : undefined,
        },
      }),
    );
  }
  console.log(`[verificacion-jalisco] parsed=${out.length}`);
  return out;
}

export const verificacionJaliscoEnabled = (): boolean =>
  process.env.PROLIO_RUN_VERIFICACION_JALISCO === "true";

export const verificacionJaliscoSource: ScraperSource = {
  name: "verificacion-jalisco" as ScrapeSource,
  enabled: verificacionJaliscoEnabled,
  async fetch() {
    return [];
  },
};

export async function runVerificacionJalisco(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!verificacionJaliscoEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("verificacion-jalisco", async () => {
    const rawLimit = Number(process.env.PROLIO_VERIFICACION_JALISCO_LIMIT ?? DEFAULT_LIMIT);
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
