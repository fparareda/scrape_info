/**
 * AEDAF — Asociación Española de Asesores Fiscales (Spain, fiscal).
 *
 * Public member directory at:
 *   https://www.aedaf.es/es/relacion-de-asociados
 *
 * Pre-flight (2026-06-07):
 *   robots.txt — 404 (no file) = fully permissive. No Cloudflare,
 *     no CAPTCHA, no login required. Server-rendered HTML throughout.
 *   Page structure — listing pages at ?page=N (N=0..25, 25 rows/page)
 *     expose name + link to /detalle/{id}. Detail pages expose full
 *     address (street, CP, city, province), phone, fax, email, and
 *     professional qualifications.
 *   Record count — 664 members opt-in to the public directory (out of
 *     3,600+ total AEDAF members). IDs are non-sequential; must be
 *     harvested from listing pages before fetching details.
 *   Category — `fiscal` (asesores fiscales = tax advisors; distinct
 *     from CGPE-procuradores which covers court officers).
 *
 * Two-phase fetch:
 *   1. Iterate listing pages 0..MAX_LISTING_PAGES, collect /detalle/{id}
 *      hrefs until a page returns 0 new IDs (signals end-of-list).
 *   2. Fetch each detail page, parse contact fields, derive city slug.
 *
 * Off by default. Enable via PROLIO_RUN_AEDAF_ASESORES_FISCALES=true.
 * Monthly cron — AEDAF membership rolls change slowly.
 */

import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";

const BASE_URL = "https://www.aedaf.es";
const LISTING_PATH = "/es/relacion-de-asociados";
const DETAIL_PATH = "/es/relacion-de-asociados/detalle/";

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30_000;
/** Polite pacing: 1.5 s between detail fetches (~664 fetches × 1.5 s ≈ 17 min). */
const REQUEST_DELAY_MS = 1_500;
const MAX_LISTING_PAGES = 30;
const DEFAULT_LIMIT = 2_000;
const CATEGORY: CategoryKey = "fiscal";

// ── Province → city-slug map (reused from cgn-notariado pattern) ────────────

const PROVINCE_TO_CITY: Record<string, string> = {
  "a coruña": "a-coruna",
  "álava": "vitoria-gasteiz",
  alava: "vitoria-gasteiz",
  albacete: "albacete",
  alicante: "alicante",
  almería: "almeria",
  almeria: "almeria",
  asturias: "oviedo",
  ávila: "avila",
  avila: "avila",
  badajoz: "badajoz",
  baleares: "palma",
  "illes balears": "palma",
  barcelona: "barcelona",
  burgos: "burgos",
  cáceres: "caceres",
  caceres: "caceres",
  cádiz: "cadiz",
  cadiz: "cadiz",
  cantabria: "santander",
  castellón: "castellon-de-la-plana",
  castellon: "castellon-de-la-plana",
  ceuta: "ceuta",
  "ciudad real": "ciudad-real",
  córdoba: "cordoba",
  cordoba: "cordoba",
  cuenca: "cuenca",
  girona: "girona",
  granada: "granada",
  guadalajara: "guadalajara",
  gipuzkoa: "donostia-san-sebastian",
  guipúzcoa: "donostia-san-sebastian",
  huelva: "huelva",
  huesca: "huesca",
  jaén: "jaen",
  jaen: "jaen",
  "la rioja": "logrono",
  "las palmas": "las-palmas-de-gran-canaria",
  león: "leon",
  leon: "leon",
  lleida: "lleida",
  lugo: "lugo",
  madrid: "madrid",
  málaga: "malaga",
  malaga: "malaga",
  melilla: "melilla",
  murcia: "murcia",
  navarra: "pamplona",
  ourense: "ourense",
  palencia: "palencia",
  pontevedra: "pontevedra",
  salamanca: "salamanca",
  "santa cruz de tenerife": "santa-cruz-de-tenerife",
  tenerife: "santa-cruz-de-tenerife",
  segovia: "segovia",
  sevilla: "sevilla",
  soria: "soria",
  tarragona: "tarragona",
  teruel: "teruel",
  toledo: "toledo",
  valencia: "valencia",
  valladolid: "valladolid",
  vizcaya: "bilbao",
  bizkaia: "bilbao",
  zamora: "zamora",
  zaragoza: "zaragoza",
};

// ── HTTP helpers ─────────────────────────────────────────────────────────────

interface FetchResponse {
  status: number;
  body: string;
}

async function politeFetch(url: string): Promise<FetchResponse | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "Accept-Language": "es-ES,es;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (res.status === 403 || res.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(`[aedaf] blocked (${res.status}) with polite UA, retrying Chrome UA`);
          continue;
        }
        return { status: res.status, body: "" };
      }
      if (!res.ok) return { status: res.status, body: "" };
      return { status: res.status, body: await res.text() };
    } catch (err) {
      clearTimeout(timer);
      console.warn(`[aedaf] network error on ${url}: ${(err as Error).message}`);
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── City / province helpers ──────────────────────────────────────────────────

function slugifyCity(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const slug = input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug || undefined;
}

function citySlugFromProvince(province: string | undefined): string | undefined {
  if (!province) return undefined;
  const key = province
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (PROVINCE_TO_CITY[key]) return PROVINCE_TO_CITY[key];
  for (const [k, slug] of Object.entries(PROVINCE_TO_CITY)) {
    if (key.includes(k) || k.includes(key)) return slug;
  }
  return undefined;
}

// ── HTML parsing ─────────────────────────────────────────────────────────────

/**
 * Phase 1: Extract /detalle/{id} hrefs from a listing page.
 * The listing page renders rows like:
 *   <a href="/es/relacion-de-asociados/detalle/796">Name</a>
 */
function parseListingIds(html: string): string[] {
  const ids: string[] = [];
  const re = new RegExp(
    DETAIL_PATH.replace(/\//g, "\\/") + "(\\d+)",
    "g",
  );
  let match: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((match = re.exec(html)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      ids.push(match[1]);
    }
  }
  return ids;
}

interface AedafRecord {
  id: string;
  name: string;
  address?: string;
  postalCode?: string;
  city?: string;
  province?: string;
  phone?: string;
  fax?: string;
  email?: string;
  qualifications?: string;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Phase 2: Parse a detail page for a single member.
 *
 * Fields observed on AEDAF detail pages (server-rendered Drupal):
 *   - Name: in <h1> or prominent heading
 *   - Dirección / Domicilio: street + postal code + city + province
 *   - Teléfono: phone number
 *   - Fax: fax number
 *   - Correo: email address (mailto: href or plain text)
 *   - Titulación / Formación: professional qualifications
 *
 * Uses label-anchored regexes on the stripped text of the page body.
 */
function parseDetailPage(id: string, html: string): AedafRecord | null {
  const text = stripTags(html);

  // Name — try h1 tag or the page <title> without site name
  const h1Match = html.match(/<h1[^>]*>\s*([^<]{3,200})\s*<\/h1>/i);
  const rawName = h1Match
    ? stripTags(h1Match[1]).trim()
    : undefined;
  if (!rawName || rawName.length < 3) {
    console.warn(`[aedaf] detail/${id}: could not extract name`);
    return null;
  }

  // Email — extract from mailto: href first (most reliable)
  const mailtoMatch = html.match(/mailto:([\w._%+\-]+@[\w.\-]+\.[a-zA-Z]{2,10})/i);
  const email = mailtoMatch ? mailtoMatch[1].toLowerCase() : undefined;

  // Phone — labelled "Teléfono" or "Tel." followed by digits
  const telMatch = text.match(/[Tt]el[eé]fono\.?\s*:?\s*([\d\s()+./\-]{6,25})/);
  const rawPhone = telMatch
    ? telMatch[1].replace(/[\s.]/g, "").trim()
    : undefined;
  const phone = rawPhone && /^\+?[\d]{6,}/.test(rawPhone) ? rawPhone : undefined;

  // Fax
  const faxMatch = text.match(/[Ff]ax\.?\s*:?\s*([\d\s()+./\-]{6,25})/);
  const fax = faxMatch
    ? faxMatch[1].replace(/[\s.]/g, "").trim()
    : undefined;

  // Qualifications — labelled "Titulación" or "Formación"
  const qualMatch = text.match(/[Tt]itulaci[oó]n\.?\s*:?\s*([^\n.]{5,200})/);
  const qualifications = qualMatch ? qualMatch[1].trim() : undefined;

  // Address block — labelled "Dirección", "Domicilio", "Dirección fiscal"
  // Format in Spanish directories: "Calle Major 10, 08001 - Barcelona (Barcelona)"
  const addrMatch = text.match(
    /(?:[Dd]irecci[oó]n|[Dd]omicilio)[^:]*:?\s*([^]+?)(?=\s+[Tt]el[eé]|[Ff]ax|[Cc]orreo|[Tt]itulaci|$)/,
  );
  const rawAddr = addrMatch ? addrMatch[1].trim().replace(/\s+/g, " ") : undefined;

  // Parse postal code + city + (province) from the raw address
  // Pattern: NNNNN - City (Province) or NNNNN City Province
  let postalCode: string | undefined;
  let city: string | undefined;
  let province: string | undefined;

  if (rawAddr) {
    const cpMatch = rawAddr.match(
      /(\d{5})\s*[-–]\s*([^(\n,]{2,60}?)\s*(?:\(([^)]{2,60})\))?\s*(?:,|$|\n)/,
    );
    if (cpMatch) {
      postalCode = cpMatch[1];
      city = cpMatch[2]?.trim();
      province = cpMatch[3]?.trim() ?? city;
    } else {
      // Fallback: just find a 5-digit postal code
      const cpOnly = rawAddr.match(/(\d{5})/);
      if (cpOnly) postalCode = cpOnly[1];
    }
  }

  return {
    id,
    name: rawName,
    address: rawAddr,
    postalCode,
    city,
    province,
    phone,
    fax,
    email,
    qualifications,
  };
}

// ── Main fetch logic ─────────────────────────────────────────────────────────

async function fetchAedafMembers(limit: number): Promise<ScrapedProfessional[]> {
  // Phase 1: collect all detail IDs from listing pages.
  const allIds: string[] = [];
  const seenIds = new Set<string>();

  console.log(`[aedaf] phase 1: collecting member IDs from listing pages`);
  for (let page = 0; page < MAX_LISTING_PAGES; page += 1) {
    const url = `${BASE_URL}${LISTING_PATH}?page=${page}`;
    const response = await politeFetch(url);
    if (!response || !response.body) {
      console.warn(`[aedaf] listing page=${page} fetch failed`);
      break;
    }
    const ids = parseListingIds(response.body);
    if (ids.length === 0) {
      console.log(`[aedaf] listing page=${page} returned 0 IDs — end of list`);
      break;
    }
    let newThisPage = 0;
    for (const id of ids) {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        allIds.push(id);
        newThisPage += 1;
      }
    }
    console.log(
      `[aedaf] listing page=${page}: found ${ids.length} IDs (${newThisPage} new), total=${allIds.length}`,
    );
    if (newThisPage === 0) {
      // All IDs on this page were already seen — pagination wrapped.
      break;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`[aedaf] phase 1 done: ${allIds.length} member IDs`);

  // Phase 2: fetch detail pages.
  const out: ScrapedProfessional[] = [];

  for (let i = 0; i < allIds.length && out.length < limit; i += 1) {
    const id = allIds[i];
    const url = `${BASE_URL}${DETAIL_PATH}${id}`;
    await sleep(REQUEST_DELAY_MS);
    const response = await politeFetch(url);
    if (!response || !response.body) {
      console.warn(`[aedaf] detail/${id} fetch failed`);
      continue;
    }
    const record = parseDetailPage(id, response.body);
    if (!record) continue;

    // Derive city slug: prefer direct city name slug, fall back to province map.
    const citySlug =
      slugifyCity(record.city) ??
      citySlugFromProvince(record.province) ??
      (record.postalCode ? slugifyCity(record.province) : undefined);
    if (!citySlug) {
      console.warn(`[aedaf] detail/${id}: no city slug for "${record.city ?? record.province ?? "?"}"`);
      continue;
    }

    const normalised = normalise({
      source: "aedaf-asesores-fiscales-es",
      country: "ES",
      sourceId: `aedaf:${id}`,
      name: record.name,
      categoryKey: CATEGORY,
      citySlug,
      address: record.address,
      phone: record.phone,
      email: record.email,
      metadata: {
        country: "ES",
        authority: "AEDAF",
        verified_by_authority: true,
        city: record.city,
        province: record.province,
        postal_code: record.postalCode,
        fax: record.fax,
        qualifications: record.qualifications,
      },
    });
    out.push(normalised);

    if (i > 0 && i % 50 === 0) {
      console.log(`[aedaf] phase 2: fetched ${i + 1}/${allIds.length}, accepted=${out.length}`);
    }
  }

  return out;
}

// ── Public exports ───────────────────────────────────────────────────────────

export const aedafAsesoresFiscalesEsEnabled = (): boolean =>
  process.env.PROLIO_RUN_AEDAF_ASESORES_FISCALES === "true";

export const aedafAsesoresFiscalesEsSource: ScraperSource = {
  name: "aedaf-asesores-fiscales-es",
  enabled: aedafAsesoresFiscalesEsEnabled,
  async fetch() {
    return [];
  },
};

export async function runAedafAsesoresFiscalesEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!aedafAsesoresFiscalesEsEnabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  return withScrapeRun("aedaf-asesores-fiscales-es", async () => {
    const limit = parseInt(
      process.env.PROLIO_AEDAF_LIMIT ?? String(DEFAULT_LIMIT),
      10,
    );
    const effectiveLimit =
      Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
    console.log(`[aedaf] starting, limit=${effectiveLimit}`);

    const records = await fetchAedafMembers(effectiveLimit);
    if (records.length === 0) {
      console.warn(`[aedaf] 0 records — check HTML structure or accessibility`);
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    }

    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
    console.log(
      `[aedaf] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
    );
    return {
      rowsFetched: records.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
    };
  }).then((result) => ({
    fetched: result?.rowsFetched ?? 0,
    inserted: 0,
    updated: 0,
    skipped: result?.rowsSkipped ?? 0,
  }));
}
