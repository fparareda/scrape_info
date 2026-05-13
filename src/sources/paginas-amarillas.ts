import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScraperSource,
  ScrapeTarget,
} from "../types.js";
import { normalise } from "../normalise.js";

/**
 * Páginas Amarillas scraper.
 *
 * Covers Spanish long-tail businesses that don't live on Google Places
 * (older/rural/no-web). PA sits behind Cloudflare WAF and blocks IPs
 * from datacenter ranges, so this is designed to run **only locally**
 * (MacBook via launchd) — same pattern as COPC.
 *
 * Two implementations are possible:
 *
 *   1. Plain fetch + HTML regex. Fast to set up but breaks whenever PA
 *      changes markup. Used below as v1.
 *   2. Playwright with browser context. Robust to markup changes, deals
 *      with JS rendering and challenge pages. Heavier install (~500MB).
 *
 * If v1 starts returning empty results after a PA redesign, swap the
 * `fetchSearchPage` body for a Playwright call — the rest of this file
 * (URL builder, HTML parser, category mapping) stays the same.
 *
 * TOS note: Páginas Amarillas' legal notice forbids "extracción sistemática
 * o reutilización de contenidos". Prolio stores contact metadata (name,
 * address, phone) which is public directory information rather than
 * editorial content. Rate limit aggressively, identify politely in
 * User-Agent, and pause if the site returns 429/503.
 */

// Path segment PA uses for each category. Verified by browsing the site.
// When PA changes URL structure these are the only strings to tweak.
const PA_CATEGORY_SLUG: Record<CategoryKey, string> = {
  fiscal: "asesorias-fiscales",
  extranjeria: "abogados-especializados-en-extranjeria",
  psicologia: "psicologos",
  medicina: "medicos",
  dentista: "dentistas",
  fisioterapia: "fisioterapeutas",
  veterinario: "veterinarios",
  notario: "notarios",
  arquitecto: "arquitectos",
  cerrajero: "cerrajeros",
  hvac: "aire-acondicionado",
  carpinteria: "carpinteros",
  fontaneria: "fontaneros",
  electricidad: "electricistas",
  mecanica: "talleres-de-automoviles",
  itv: "itv",
  ingenieria: "ingenieros",
};

const ENDPOINT = "https://www.paginasamarillas.es";
const REQUEST_DELAY_MS = 2500;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function searchUrl(
  category: CategoryKey,
  cityName: string,
  page: number,
): string {
  // PA uses path: /search/<category-slug>/all-ma/<province>/<city>/<page>
  // We don't know province per city in the scraper, but PA accepts the
  // bare city segment too (redirects to province). Normalise the city
  // name: lowercase, no accents, dashes for spaces.
  const slugCity = cityName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-");
  return `${ENDPOINT}/search/${PA_CATEGORY_SLUG[category]}/all-ma/${slugCity}/${slugCity}/${page}`;
}

interface Listing {
  sourceId: string;
  name: string;
  phone?: string;
  website?: string;
  address?: string;
}

/**
 * Best-effort HTML parser. PA renders listings inside `.f-listado .listado`
 * items with name in an `<h2>`, address in `.dir` and phone in `.tlf`.
 * When PA changes classnames this returns [] — the source then logs and
 * moves on, nothing else breaks.
 */
function parseListings(html: string): Listing[] {
  const out: Listing[] = [];
  // Split by the listing container; regex is fragile but avoids a
  // cheerio dep. Keep the extraction narrow.
  const blocks = html.split(/<div[^>]+class="[^"]*\bListado\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const idMatch = block.match(/data-id=['"](\d+)['"]/i);
    const nameMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (!nameMatch) continue;
    const name = stripTags(nameMatch[1]).trim();
    if (!name) continue;

    const phoneMatch = block.match(
      /<span[^>]*class="[^"]*\btlf\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    );
    const addrMatch = block.match(
      /<span[^>]*class="[^"]*\bdir\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    );
    const webMatch = block.match(
      /href="(https?:\/\/[^"']+)"[^>]*class="[^"]*\bweb\b[^"]*"/i,
    );

    out.push({
      sourceId:
        idMatch?.[1] ?? `name:${name.toLowerCase().replace(/\s+/g, "-")}`,
      name,
      phone: phoneMatch ? stripTags(phoneMatch[1]).trim() : undefined,
      address: addrMatch ? stripTags(addrMatch[1]).trim() : undefined,
      website: webMatch?.[1],
    });
  }
  return out;
}

function stripTags(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ");
}

async function fetchSearchPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      },
    });
    if (response.status === 403 || response.status === 503) {
      console.warn(
        `[paginas_amarillas] WAF blocked (${response.status}) on ${url} — Cloudflare challenge; needs Playwright`,
      );
      return null;
    }
    if (!response.ok) {
      console.warn(`[paginas_amarillas] ${response.status} on ${url}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    console.error(
      `[paginas_amarillas] network error on ${url}:`,
      (error as Error).message,
    );
    return null;
  }
}

export const paginasAmarillasSource: ScraperSource = {
  name: "paginas_amarillas",

  enabled() {
    // Off by default. Enable only in local launchd runs:
    //   export PROLIO_SCRAPE_PA=true
    //
    // 2026-05-06 update: even from a residential IP, plain fetch hits
    // an Imperva/Incapsula JS challenge (cookie names visid_incap_*
    // and incap_ses_*). Curl with `-c -b` cookie jar gets back ~881
    // bytes of <script> challenge stub instead of HTML. To make this
    // work we'd need either:
    //   (a) Playwright with stealth fingerprint to execute the JS and
    //       earn the post-challenge cookie. Adds ~300MB browser dep.
    //   (b) curl-cffi/undici with custom JA3 — Python-only realistically.
    // Until one of those lands, this source returns 0 rows everywhere.
    // Cobertura solapada con BORME + Doctoralia + Google Places + colegios.
    return process.env.PROLIO_SCRAPE_PA === "true";
  },

  async fetch(target: ScrapeTarget): Promise<ScrapedProfessional[]> {
    if (target.country !== "ES") return [];
    const byId = new Map<string, ScrapedProfessional>();
    // Paginate up to 5 pages per target. PA shows ~20 listings per page,
    // so this caps at ~100 per (category, city) which is plenty for
    // most Spanish municipios.
    for (let page = 0; page < 5; page += 1) {
      const url = searchUrl(target.categoryKey, target.cityName, page);
      const html = await fetchSearchPage(url);
      if (!html) break;
      const listings = parseListings(html);
      if (listings.length === 0) break;
      for (const listing of listings) {
        const record: ScrapedProfessional = normalise({
          source: "paginas_amarillas",
          sourceId: listing.sourceId,
          name: listing.name,
          categoryKey: target.categoryKey,
          citySlug: target.citySlug,
          phone: listing.phone,
          address: listing.address,
          website: listing.website,
        });
        byId.set(record.sourceId, record);
      }
      await delay(REQUEST_DELAY_MS);
    }
    return Array.from(byId.values());
  },
};
