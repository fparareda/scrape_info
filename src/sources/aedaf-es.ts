import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * AEDAF — Asociación Española de Asesores Fiscales.
 *
 * Pre-flight 2026-05-18:
 *
 *   URL: https://www.aedaf.es/es/relacion-de-asociados
 *   robots.txt: returns HTTP 404 (no file) — all paths permitted by
 *     robots exclusion protocol convention.
 *   Auth / captcha: none — fully public SSR HTML (Symfony/Twig).
 *   Cloudflare: not detected.
 *
 * Listing pages: ?page=N (0-indexed), 25 records per page, ~27 pages
 * (~666 total members). Each listing row contains only name + degree.
 * Full contact data lives on the detail page at /detalle/{ID}.
 *
 * Strategy:
 *   1. GET each listing page ?page=0..N until empty.
 *   2. Extract href to /detalle/{ID} links.
 *   3. GET each detail page to collect address, phone, email, website.
 *
 * Category: `fiscal`. AEDAF is Spain's premier tax-advisor association
 * (founded 1967; strict admission: university graduates specialised in
 * tax law). Records carry verified membership (número de asociado).
 *
 * Off by default. Enable via PROLIO_RUN_AEDAF_ES=true.
 * Cap via PROLIO_AEDAF_ES_LIMIT (default 1000 — full roster is ~666).
 * Cron: monthly (AEDAF membership rolls are slow-moving).
 */

const BASE = "https://www.aedaf.es";
const LIST_PATH = "/es/relacion-de-asociados";
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 1_200;
const DEFAULT_LIMIT = 1_000;
const MAX_PAGES = 50; // safety cap; ~27 pages for 666 members

export const aedafEsSource: ScraperSource = {
  name: "aedaf-es",
  enabled() {
    return process.env.PROLIO_RUN_AEDAF_ES === "true";
  },
  async fetch() {
    return [];
  },
};

// --- HTTP helpers -------------------------------------------------------

async function politeFetch(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "es-ES,es;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(`[aedaf-es] HTTP ${response.status} on ${url}`);
      return null;
    }
    return await response.text();
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[aedaf-es] fetch error on ${url}: ${(e as Error).message}`);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- HTML parsers -------------------------------------------------------

/**
 * Extract /detalle/{id} hrefs from a listing page.
 * AEDAF renders links like <a href="/es/relacion-de-asociados/detalle/683">
 */
function extractDetailIds(html: string): string[] {
  const re = /href="\/es\/relacion-de-asociados\/detalle\/(\d+)"/g;
  const ids: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, (m) => {
      const code = parseInt(m.slice(2, -1));
      return String.fromCodePoint(code);
    });
}

function extractText(html: string, labelPattern: RegExp): string | undefined {
  const m = labelPattern.exec(html);
  if (!m) return undefined;
  // Grab the text content after the label tag, stripping inner HTML tags.
  const rest = html.slice((m.index ?? 0) + m[0].length);
  const endPos = rest.search(/<\/(?:p|div|li|td|span|section)/i);
  const raw = (endPos >= 0 ? rest.slice(0, endPos) : rest.slice(0, 300))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return decodeEntities(raw) || undefined;
}

interface AedafDetail {
  id: string;
  name: string;
  qualification?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  website?: string;
}

function parseDetail(html: string, id: string): AedafDetail | null {
  // Name is in <h1> or <h2> on the detail page.
  const nameM =
    /<h[12][^>]*>([\s\S]{1,200}?)<\/h[12]>/i.exec(html);
  const rawName = nameM
    ? decodeEntities(nameM[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())
    : "";
  if (!rawName) return null;

  // Phone: look for "Teléfono" label.
  const phone = extractText(html, /Teléfono\s*[:：]?\s*(?:<[^>]+>)*/i);
  // Email: look for mailto: href.
  const emailM = /href="mailto:([^"]+)"/i.exec(html);
  const email = emailM ? emailM[1].trim().toLowerCase() : undefined;
  // Website: look for external http link not mail.
  const webM = /href="(https?:\/\/(?!(?:www\.aedaf\.es))[^"]+)"/i.exec(html);
  const website = webM ? webM[1].trim() : undefined;
  // Address line.
  const address = extractText(html, /(?:Dirección|C\.\s*P\.?|Calle)\s*[:：]?\s*(?:<[^>]+>)*/i);
  // City / province via postal-code neighbourhood — look for 5-digit pattern.
  const cpM = /\b(\d{5})\b/.exec(html);
  const postalCode = cpM ? cpM[1] : undefined;
  // Qualification (titulación).
  const qual = extractText(html, /(?:Titulación|Titulacion|Formación)\s*[:：]?\s*(?:<[^>]+>)*/i);

  return { id, name: rawName, qualification: qual, email, phone, address, postalCode, website };
}

// --- City mapping -------------------------------------------------------

interface EsCityIndex {
  exact: Map<string, string>;
  postal: Map<string, string>;
}

let esCityIndexCache: EsCityIndex | null = null;

async function loadEsCityIndex(): Promise<EsCityIndex> {
  if (esCityIndexCache) return esCityIndexCache;
  const cities = await getCities({ country: "ES" });
  const exact = new Map<string, string>();
  const postal = new Map<string, string>();
  for (const c of cities) {
    exact.set(c.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""), c.slug);
    exact.set(c.slug, c.slug);
  }
  esCityIndexCache = { exact, postal };
  return esCityIndexCache;
}

function mapCity(idx: EsCityIndex, rawCity?: string, _postalCode?: string): string | undefined {
  if (!rawCity) return undefined;
  const key = rawCity.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (idx.exact.has(key)) return idx.exact.get(key);
  const slug = slugify(rawCity);
  if (idx.exact.has(slug)) return idx.exact.get(slug);
  return undefined;
}

// --- Main scrape --------------------------------------------------------

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const cityIndex = await loadEsCityIndex();
  const allIds: string[] = [];

  // Phase 1: collect all detail IDs from listing pages.
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${BASE}${LIST_PATH}?page=${page}`;
    const html = await politeFetch(url);
    if (!html) break;
    const ids = extractDetailIds(html);
    if (ids.length === 0) {
      console.log(`[aedaf-es] listing page=${page} empty — stopping`);
      break;
    }
    for (const id of ids) {
      if (!allIds.includes(id)) allIds.push(id);
    }
    console.log(`[aedaf-es] listing page=${page}: found ${ids.length} detail IDs (total ${allIds.length})`);
    await sleep(REQUEST_DELAY_MS);
    if (allIds.length >= limit) break;
  }

  console.log(`[aedaf-es] collected ${allIds.length} detail IDs`);

  // Phase 2: fetch each detail page.
  const out: ScrapedProfessional[] = [];
  let droppedNoCity = 0;

  for (const id of allIds.slice(0, limit)) {
    if (out.length >= limit) break;
    const url = `${BASE}${LIST_PATH}/detalle/${id}`;
    const html = await politeFetch(url);
    if (!html) {
      await sleep(REQUEST_DELAY_MS);
      continue;
    }
    const detail = parseDetail(html, id);
    if (!detail) {
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    // City: try to extract from address block or postal code area.
    // AEDAF detail pages expose city in the address paragraph.
    const cityM = /\b([A-ZÁÉÍÓÚÜÑa-záéíóúüñ][a-záéíóúüñA-ZÁÉÍÓÚÜÑ\s\-]{2,30})\s+\(([A-Za-záéíóúüñÁÉÍÓÚÜÑ\s]+)\)/.exec(
      detail.address ?? "",
    );
    const rawCity = cityM ? cityM[1].trim() : detail.city ?? "";
    const citySlug = mapCity(cityIndex, rawCity, detail.postalCode);

    if (!citySlug) {
      droppedNoCity += 1;
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    out.push(
      normalise({
        source: "aedaf-es",
        sourceId: `aedaf-es:${id}`,
        name: detail.name,
        categoryKey: "fiscal",
        citySlug,
        email: detail.email,
        phone: detail.phone,
        address: detail.address,
        website: detail.website,
        metadata: {
          country: "ES",
          authority: "AEDAF",
          verified_by_authority: true,
          qualification: detail.qualification,
          postal_code: detail.postalCode,
          profile_url: url,
        },
      }),
    );

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(
    `[aedaf-es] done: fetched=${out.length} droppedNoCity=${droppedNoCity}`,
  );
  return out;
}

export async function runAedafEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!aedafEsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const limitRaw = Number(process.env.PROLIO_AEDAF_ES_LIMIT ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;

  const rows = await fetchAll(limit);
  if (rows.length === 0) {
    console.log(`[aedaf-es] 0 rows — nothing to upsert`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(rows);
  console.log(
    `[aedaf-es] upserted: inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: rows.length, inserted, updated, skipped };
}
