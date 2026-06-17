import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";

/**
 * CODE — Colegio Oficial de Dentistas de Castilla y León.
 *
 * Official registry of dentists in the 9 provinces of Castilla y León:
 * Burgos (09), León (24), Ávila (05), Palencia (34), Salamanca (37),
 * Segovia (40), Soria (42), Valladolid (47), Zamora (49).
 *
 * Listing URL: https://www.colegiodedentistas.com/colegiados?page=N
 * Pages: 0..37 (~20 records/page, ~760 total records)
 *
 * robots.txt: ALLOWED — /colegiados/ is not blocked.
 * No JS required, no CAPTCHA, no login.
 *
 * Two-pass approach:
 *   1. Listing pass: paginate pages 0..37, extract reg number + name + detail URL.
 *   2. Detail pass: fetch each detail page for address + phone + city.
 *
 * Category: dentista, Country: ES.
 *
 * Off by default. Enable with PROLIO_RUN_CODE_CAS_LEON_DENTISTAS=true.
 * Cap via PROLIO_CODE_CAS_LEON_DENTISTAS_LIMIT (default 800).
 */

const BASE_URL = "https://www.colegiodedentistas.com";
const LISTING_URL = `${BASE_URL}/colegiados`;
const MAX_PAGES = 38; // pages 0..37
const REQUEST_DELAY_MS = 300;
const DEFAULT_LIMIT = 800;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

interface ListingEntry {
  regNumber: string;
  name: string;
  detailUrl: string;
}

interface DetailData {
  address?: string;
  phone?: string;
  citySlug: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse listing page HTML to extract registration number, name, and detail URL.
 * Pattern: <h2><a href="/colegiados/{id}-{slug}">Name</a></h2>
 */
function parseListingPage(html: string): ListingEntry[] {
  const entries: ListingEntry[] = [];
  // Match <h2...><a href="/colegiados/...">...</a></h2>
  const linkRe =
    /<h2[^>]*>\s*<a\s+href="(\/colegiados\/([^"]+))"[^>]*>([^<]+)<\/a>\s*<\/h2>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1];
    const pathSegment = match[2]; // e.g. "09000712-alonso-heras-mariano"
    const name = match[3].trim();
    if (!href || !pathSegment || !name) continue;
    // Registration number is the first hyphen-separated segment
    const dashIdx = pathSegment.indexOf("-");
    const regNumber =
      dashIdx > -1 ? pathSegment.slice(0, dashIdx) : pathSegment;
    if (!regNumber) continue;
    entries.push({
      regNumber,
      name,
      detailUrl: `${BASE_URL}${href}`,
    });
  }
  return entries;
}

/**
 * Parse a detail page for address, phone, and city.
 *
 * Drupal field divs:
 *   <div class="field--name-field-clinica-direccion">...</div>
 *   <div class="field--name-field-clinica-telefono">...</div>
 *
 * City is extracted from the address text (typically the last meaningful segment).
 */
function parseDetailPage(html: string): DetailData {
  let address: string | undefined;
  let phone: string | undefined;
  let citySlug = "";

  // Try address field
  const addrMatch = html.match(
    /field--name-field-clinica-direccion[\s\S]*?<div[^>]*class="field__item"[^>]*>([\s\S]*?)<\/div>/i,
  );
  if (addrMatch) {
    // Strip HTML tags and clean up
    const rawAddr = addrMatch[1]
      .replace(/<br\s*\/?>/gi, ", ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (rawAddr) {
      address = rawAddr;
      // Try to extract city: look for patterns like "12345 CityName" or last comma segment
      // Spanish postal codes are 5 digits
      const postalCityMatch = rawAddr.match(/\b(\d{5})\s+([A-ZÀ-Ú][A-Za-zÀ-Ú\s\-]+)/i);
      if (postalCityMatch) {
        const rawCity = postalCityMatch[2].trim();
        citySlug = slugify(rawCity);
      } else {
        // Fallback: use last non-empty segment after comma
        const parts = rawAddr
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (parts.length > 0) {
          // Last segment might be province, second-to-last might be city
          const candidate =
            parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1];
          citySlug = slugify(candidate);
        }
      }
    }
  }

  // Try phone field
  const phoneMatch = html.match(
    /field--name-field-clinica-telefono[\s\S]*?<div[^>]*class="field__item"[^>]*>([\s\S]*?)<\/div>/i,
  );
  if (phoneMatch) {
    const rawPhone = phoneMatch[1].replace(/<[^>]+>/g, "").trim();
    if (rawPhone) phone = rawPhone;
  }

  return { address, phone, citySlug };
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.5",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.warn(`[code-cas-leon-dentistas] HTTP ${response.status} on ${url}`);
      return null;
    }
    return response.text();
  } catch (error) {
    console.warn(
      `[code-cas-leon-dentistas] fetch error on ${url}: ${(error as Error).message}`,
    );
    return null;
  }
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  // Pass 1: collect all listing entries
  const listings: ListingEntry[] = [];
  const seenReg = new Set<string>();

  for (let page = 0; page < MAX_PAGES; page++) {
    if (listings.length >= limit) break;
    const url = `${LISTING_URL}?page=${page}`;
    const html = await fetchPage(url);
    if (!html) {
      console.warn(`[code-cas-leon-dentistas] skipping listing page ${page}`);
      await delay(REQUEST_DELAY_MS);
      continue;
    }

    const entries = parseListingPage(html);
    if (entries.length === 0) {
      console.log(
        `[code-cas-leon-dentistas] listing page ${page}: no entries found, stopping`,
      );
      break;
    }

    for (const entry of entries) {
      if (listings.length >= limit) break;
      if (seenReg.has(entry.regNumber)) continue;
      seenReg.add(entry.regNumber);
      listings.push(entry);
    }

    console.log(
      `[code-cas-leon-dentistas] listing page ${page}: ${entries.length} entries (total=${listings.length})`,
    );
    await delay(REQUEST_DELAY_MS);
  }

  console.log(
    `[code-cas-leon-dentistas] listing pass done: ${listings.length} records`,
  );

  // Pass 2: fetch detail pages for address + phone + city
  const out: ScrapedProfessional[] = [];

  for (const entry of listings) {
    const detail: DetailData = { citySlug: "" };
    const html = await fetchPage(entry.detailUrl);
    if (html) {
      const parsed = parseDetailPage(html);
      detail.address = parsed.address;
      detail.phone = parsed.phone;
      detail.citySlug = parsed.citySlug;
    }

    out.push(
      normalise({
        source: "code-cas-leon-dentistas" as ScrapeSource,
        country: "ES",
        sourceId: `code-cas-leon-dentistas:${entry.regNumber}`,
        name: entry.name,
        categoryKey: "dentista",
        citySlug: detail.citySlug,
        phone: detail.phone,
        address: detail.address,
        licenseNumber: entry.regNumber,
        website: entry.detailUrl,
        metadata: {
          country: "ES",
          authority: "CODE Castilla y León",
          verified_by_authority: true,
          region: "Castilla y León",
          numero_colegiado: entry.regNumber,
          detail_url: entry.detailUrl,
        },
      }),
    );

    await delay(REQUEST_DELAY_MS);
  }

  console.log(
    `[code-cas-leon-dentistas] detail pass done: ${out.length} records`,
  );
  return out;
}

export const codeCasLeonDentistasSource: ScraperSource = {
  name: "code-cas-leon-dentistas" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CODE_CAS_LEON_DENTISTAS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCodeCasLeonDentistas(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!codeCasLeonDentistasSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_CODE_CAS_LEON_DENTISTAS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    console.log("[code-cas-leon-dentistas] no records fetched");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[code-cas-leon-dentistas] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
