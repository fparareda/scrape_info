import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * Notariado Mexicano — Asociación Nacional del Notariado Mexicano.
 *
 * Directory at:
 *   https://www.notariadomexicano.org.mx/directorio-de-notarios/
 *
 * Patrón análogo a CGN (España, src/sources/cgn-notariado.ts):
 * página índice con sub-páginas por estado, cada sub-página lista
 * los notarios con nombre + dirección + teléfono. ~4-5k notarios.
 *
 * Pre-flight (2026-05-13):
 *   El sitio devuelve 403 incluso con User-Agent Chrome realista +
 *   headers Accept/Accept-Language/Referer. Cloudflare bot management
 *   activo. Probado:
 *     - curl con UA Chrome 147 + Accept-Language es-MX: 403
 *     - curl con --compressed + Referer google.com: 403
 *     - WebFetch (servidor de Anthropic): 403
 *   Bypass posible sólo con navegador headless (Playwright/Puppeteer)
 *   o residential proxy. NO implementado aquí.
 *
 * Off by default. `PROLIO_RUN_NOTARIADO_MX=true` enables.
 * Cap with `PROLIO_NOTARIADO_MX_LIMIT` (default 5000).
 *
 * Estado actual: stub honesto. Devuelve 0 rows hasta que se incorpore
 * un fetcher capaz de pasar el desafío Cloudflare. El extractor está
 * preparado y debería funcionar si en el futuro se sirve el HTML
 * desde un proxy/browser headless.
 */

const BASE_URL =
  process.env.PROLIO_NOTARIADO_MX_BASE ||
  "https://www.notariadomexicano.org.mx/directorio-de-notarios/";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 1_500;
const DEFAULT_LIMIT = 5_000;
const CATEGORY: CategoryKey = "notario";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function politeFetch(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": CHROME_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        Referer: "https://www.google.com/",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[notariado-mx] ${res.status} on ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[notariado-mx] network error on ${url}: ${(err as Error).message}`);
    return null;
  }
}

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

interface NotarioRecord {
  sourceId: string;
  name: string;
  notariaNum?: string;
  address?: string;
  phone?: string;
  email?: string;
  citySlug: string;
}

/**
 * Extract per-state directory URLs from the index page. The directory
 * page links to each state via /directorio-de-notarios/<state-slug>/.
 */
function extractStateUrls(html: string): string[] {
  const out = new Set<string>();
  const re = /href="(https?:\/\/www\.notariadomexicano\.org\.mx\/directorio-de-notarios\/[a-z\-]+\/?)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.add(m[1].replace(/\/?$/, "/"));
  }
  return Array.from(out);
}

/**
 * Parse notarios from a per-state page. The site renders entries
 * in repeated blocks containing "Notaría N°" + name + address + tel.
 * We use a permissive split on "Notaría" boundaries.
 */
function parseNotarios(html: string, stateSlug: string): NotarioRecord[] {
  const out: NotarioRecord[] = [];
  const seen = new Set<string>();
  const citySlug = mxStateToCity(stateSlug) ?? "cdmx";

  // Split on "Notaría" markers (heading-style entries). Each chunk
  // becomes a candidate notary block.
  const chunks = html.split(/Notar[ií]a\s*(?:N[°º]\.?|N[uú]mero)?\s*(\d+)/i);
  // chunks: [pre, num1, body1, num2, body2, ...]
  for (let i = 1; i < chunks.length; i += 2) {
    const num = chunks[i];
    const body = chunks[i + 1] ?? "";
    const text = stripHtml(body).slice(0, 800);
    if (text.length < 10) continue;

    // Name: heuristic — first ALL-CAPS or Title-Case phrase before "Lic." / "Dr." or comma
    const nameMatch = text.match(/^[\s,.:-]*([A-ZÁÉÍÓÚÑa-záéíóúñ.\s]{6,80})/);
    const name = nameMatch ? nameMatch[1].trim().replace(/\s+/g, " ") : `Notaría ${num}`;
    if (name.length < 4) continue;

    const phoneMatch = text.match(/(?:Tel(?:éfono)?\.?:?\s*)([\d\s().\-+]{7,20})/i);
    const emailMatch = text.match(/([\w.\-+]+@[\w.\-]+\.[a-z]{2,6})/i);
    const addrMatch = text.match(/(?:Dirección|Domicilio)\s*:?\s*([^|]+)/i);

    const sourceId = `notariado-mx:${stateSlug}-${num}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    out.push({
      sourceId,
      name,
      notariaNum: num,
      address: addrMatch ? addrMatch[1].trim().slice(0, 200) : undefined,
      phone: phoneMatch ? phoneMatch[1].trim() : undefined,
      email: emailMatch ? emailMatch[1].toLowerCase() : undefined,
      citySlug,
    });
  }
  return out;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const indexHtml = await politeFetch(BASE_URL);
  if (!indexHtml) {
    console.warn(`[notariado-mx] could not fetch index ${BASE_URL}`);
    return out;
  }

  const stateUrls = extractStateUrls(indexHtml);
  console.log(`[notariado-mx] discovered ${stateUrls.length} state pages`);

  for (const stateUrl of stateUrls) {
    if (out.length >= limit) break;
    await sleep(REQUEST_DELAY_MS);
    const stateSlug =
      stateUrl.replace(/^.*\/directorio-de-notarios\//, "").replace(/\/$/, "");
    const html = await politeFetch(stateUrl);
    if (!html) continue;
    const records = parseNotarios(html, stateSlug);
    let added = 0;
    for (const r of records) {
      out.push(
        normalise({
          source: "notariado-mx" as ScrapeSource,
          sourceId: r.sourceId,
          name: r.name,
          categoryKey: CATEGORY,
          citySlug: r.citySlug,
          phone: r.phone,
          email: r.email,
          address: r.address,
          metadata: {
            country: "MX",
            authority: "ANNM",
            verified_by_authority: true,
            state: stateSlug,
            notaria_num: r.notariaNum,
          },
        }),
      );
      added += 1;
      if (out.length >= limit) break;
    }
    console.log(
      `[notariado-mx] state=${stateSlug} parsed=${records.length} added=${added} total=${out.length}`,
    );
  }
  return out;
}

export const notariadoMxEnabled = (): boolean =>
  process.env.PROLIO_RUN_NOTARIADO_MX === "true";

export const notariadoMxSource: ScraperSource = {
  name: "notariado-mx" as ScrapeSource,
  enabled: notariadoMxEnabled,
  async fetch() {
    return [];
  },
};

export async function runNotariadoMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!notariadoMxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("notariado-mx", async () => {
    const rawLimit = Number(process.env.PROLIO_NOTARIADO_MX_LIMIT ?? DEFAULT_LIMIT);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
    const records = await fetchAll(limit);
    if (records.length === 0) {
      console.warn(`[notariado-mx] 0 records — check HTML structure / WAF`);
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    }
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
    console.log(
      `[notariado-mx] done fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
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
