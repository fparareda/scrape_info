import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * Colegio de Notarios de la Ciudad de México.
 *
 *   https://colegiodenotorios.org.mx/
 *   Sección "Ubica tu notaría" — listado finito de ~250 notarías
 *   con teléfono, dirección y correo de cada notaria.
 *
 * Patrón HTML listado simple (server-rendered).
 *
 * Off by default. `PROLIO_RUN_COLEGIO_NOTARIOS_CDMX=true`.
 * Cap with `PROLIO_COLEGIO_NOTARIOS_CDMX_LIMIT` (default 500).
 */

const BASE_URL =
  process.env.PROLIO_COLEGIO_NOTARIOS_CDMX_URL ||
  "https://colegiodenotorios.org.mx/notarios/";
const DEFAULT_LIMIT = 500;
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CATEGORY: CategoryKey = "notario";
const REQUEST_TIMEOUT_MS = 30_000;

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let html = "";
  try {
    const res = await fetch(BASE_URL, {
      headers: {
        "User-Agent": CHROME_UA,
        Accept: "text/html,*/*",
        "Accept-Language": "es-MX,es;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[colegio-notarios-cdmx] ${res.status} on ${BASE_URL}`);
      return out;
    }
    html = await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[colegio-notarios-cdmx] network: ${(err as Error).message}`);
    return out;
  }

  // Split on "Notaría N°" boundaries
  const chunks = html.split(/Notar[ií]a\s*(?:N[°º]\.?|N[uú]m\.?|N[uú]mero)?\s*(\d+)/i);
  const seen = new Set<string>();
  for (let i = 1; i < chunks.length; i += 2) {
    if (out.length >= limit) break;
    const num = chunks[i];
    const body = chunks[i + 1] ?? "";
    const text = stripHtml(body).slice(0, 600);
    if (text.length < 8) continue;

    const nameMatch = text.match(/(?:Titular|Lic\.|Dr\.)\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.\s]{5,80})/);
    const name = nameMatch ? nameMatch[1].trim() : `Notaría ${num} CDMX`;
    const telMatch = text.match(/(?:Tel(?:éfono)?\.?)\s*:?\s*([\d\s().\-+]{7,20})/i);
    const emailMatch = text.match(/([\w.\-+]+@[\w.\-]+\.[a-z]{2,6})/i);
    const addrMatch = text.match(/(?:Dirección|Domicilio)\s*:?\s*([^|]+?)(?:Tel|Correo|$)/i);

    const sid = `colegio-notarios-cdmx:${num}`;
    if (seen.has(sid)) continue;
    seen.add(sid);

    out.push(
      normalise({
        source: "colegio-notarios-cdmx" as ScrapeSource,
        sourceId: sid,
        name,
        categoryKey: CATEGORY,
        citySlug: "cdmx",
        phone: telMatch ? telMatch[1].trim() : undefined,
        email: emailMatch ? emailMatch[1].toLowerCase() : undefined,
        address: addrMatch ? addrMatch[1].trim().slice(0, 200) : undefined,
        licenseNumber: num,
        metadata: {
          country: "MX",
          authority: "Colegio-Notarios-CDMX",
          verified_by_authority: true,
          notaria_num: num,
        },
      }),
    );
  }
  console.log(`[colegio-notarios-cdmx] parsed=${out.length}`);
  return out;
}

export const colegioNotariosCdmxEnabled = (): boolean =>
  process.env.PROLIO_RUN_COLEGIO_NOTARIOS_CDMX === "true";

export const colegioNotariosCdmxSource: ScraperSource = {
  name: "colegio-notarios-cdmx" as ScrapeSource,
  enabled: colegioNotariosCdmxEnabled,
  async fetch() {
    return [];
  },
};

export async function runColegioNotariosCdmx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!colegioNotariosCdmxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("colegio-notarios-cdmx", async () => {
    const rawLimit = Number(
      process.env.PROLIO_COLEGIO_NOTARIOS_CDMX_LIMIT ?? DEFAULT_LIMIT,
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
