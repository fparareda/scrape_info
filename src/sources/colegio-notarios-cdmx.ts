import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

/**
 * Colegio de Notarios de la Ciudad de México.
 *
 *   https://colegiodenotarios.org.mx/directorio
 *   Sección "Ubica tu notaría" — listado oficial de ~250 notarías CDMX.
 *
 * Patrón (auditado 2026-05-13):
 *   El directorio es server-rendered pero requiere un POST con un
 *   filtro (alcaldía). Iteramos sobre las 14 alcaldías; cada respuesta
 *   trae bloques con la forma:
 *
 *     "Notario \n  Nombre Apellido - Notaría No. NN"
 *     "Notaria \n  Nombre Apellido - Notaría No. NN"
 *
 *   Sin teléfono ni email visibles en la lista (sólo se ven al hacer
 *   click en cada ficha individual — TODO para v2).
 *
 * Off by default. `PROLIO_RUN_COLEGIO_NOTARIOS_CDMX=true`.
 * Cap with `PROLIO_COLEGIO_NOTARIOS_CDMX_LIMIT` (default 500).
 */

const BASE_URL =
  process.env.PROLIO_COLEGIO_NOTARIOS_CDMX_URL ||
  "https://colegiodenotarios.org.mx/directorio";
const DEFAULT_LIMIT = 500;
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const CATEGORY: CategoryKey = "notario";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 1_000;

const ALCALDIAS = [
  "Álvaro Obregón",
  "Azcapotzalco",
  "Benito Juárez",
  "Coyoacán",
  "Cuajimalpa de Morelos",
  "Cuauhtémoc",
  "Gustavo A. Madero",
  "Iztacalco",
  "Iztapalapa",
  "Magdalena Contreras",
  "Miguel Hidalgo",
  "Tlalpan",
  "Xochimilco",
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postSearch(alcaldia: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const body = new URLSearchParams();
    body.append("Buscar", "1");
    body.append("Filtro[0]", "");
    body.append("Filtro[1]", "");
    body.append("Filtro[3]", alcaldia);
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "User-Agent": CHROME_UA,
        Accept: "text/html,*/*",
        "Accept-Language": "es-MX,es;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(
        `[colegio-notarios-cdmx] ${res.status} on POST ${BASE_URL} (alcaldia=${alcaldia})`,
      );
      return null;
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `[colegio-notarios-cdmx] network ${alcaldia}: ${(err as Error).message}`,
    );
    return null;
  }
}

interface Row {
  name: string;
  num: string;
  rol: "Notario" | "Notaria";
  address?: string;
  phone?: string;
  email?: string;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse one alcaldía page. Each notario is inside:
 *   <div class="nombre_dir">
 *     Notario|Notaria
 *     <Name> - Notaría No. NN
 *   </div>
 *   ...Dirección: ... Teléfono(s): <a href="tel:N">N</a>...
 */
function parseRows(html: string, alcaldia: string): Row[] {
  const out: Row[] = [];
  const HEADER_RE = /<div\s+class="nombre_dir"[^>]*>\s*(Notario|Notaria)\s*([\s\S]{4,200}?)\s*-\s*Notar[ií]a\s*No\.?\s*(\d{1,4})\s*<\/div>([\s\S]{0,2000})/gi;
  let m: RegExpExecArray | null;
  while ((m = HEADER_RE.exec(html)) !== null) {
    const rolRaw = m[1].toLowerCase();
    const rol: "Notario" | "Notaria" =
      rolRaw === "notaria" ? "Notaria" : "Notario";
    const name = stripHtml(m[2]);
    const num = m[3];
    if (name.length < 4) continue;
    const tail = m[4];
    const dirMatch = tail.match(
      /Dirección:\s*<\/[a-z]+>\s*<\/em>([\s\S]{0,400}?)(?:<br|Tel[eé]fono|Correo|$)/i,
    );
    const telMatch = tail.match(/href="tel:[^"]*"[^>]*>\s*([^<]{6,30})/i);
    const address = dirMatch
      ? stripHtml(dirMatch[1]).replace(/\s{2,}/g, " ").trim()
      : undefined;
    const phone = telMatch ? telMatch[1].replace(/\s+/g, " ").trim() : undefined;
    out.push({ name, num, rol, address, phone });
  }
  return out;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  for (const alcaldia of ALCALDIAS) {
    if (out.length >= limit) break;
    await sleep(REQUEST_DELAY_MS);
    const html = await postSearch(alcaldia);
    if (!html) continue;
    const rows = parseRows(html, alcaldia);
    let added = 0;
    for (const r of rows) {
      if (out.length >= limit) break;
      const sid = `colegio-notarios-cdmx:${r.num}`;
      if (seen.has(sid)) continue;
      seen.add(sid);
      out.push(
        normalise({
          source: "colegio-notarios-cdmx" as ScrapeSource,
          country: "MX",
          sourceId: sid,
          name: r.name,
          categoryKey: CATEGORY,
          citySlug: "cdmx",
          licenseNumber: r.num,
          phone: r.phone,
          address: r.address,
          metadata: {
            country: "MX",
            authority: "Colegio-Notarios-CDMX",
            verified_by_authority: true,
            notaria_num: r.num,
            alcaldia,
            rol: r.rol,
          },
        }),
      );
      added += 1;
    }
    console.log(
      `[colegio-notarios-cdmx] alcaldia="${alcaldia}" parsed=${rows.length} added=${added} total=${out.length}`,
    );
  }
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
