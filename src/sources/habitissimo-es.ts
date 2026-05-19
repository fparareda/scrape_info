import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay } from "./_bulk-utils.js";

/**
 * habitissimo.es — directorio público de empresas de servicios para el hogar.
 *
 *   https://www.habitissimo.es/empresas/{servicio}/{ciudad}[/{page}]
 *
 * robots.txt permite `/empresas/`. Cada lista pública (HTML SSR) muestra
 * ~10 fichas por página con nombre, ubicación, valoración y un enlace al
 * perfil de empresa (cuyo URL canónico tiene la forma
 * `/pro/{slug}` o `/empresa/{slug}`). El header de la página declara el
 * total — p.ej. "Encuentra entre 686 profesionales…" — lo que permite
 * paginar deterministicamente.
 *
 * Estrategia (zero JS, sin Playwright):
 *   1. Para cada combinación (servicio × ciudad), GET la primera página.
 *   2. Parsear el total declarado y las tarjetas de empresa.
 *   3. Iterar páginas hasta llegar al total o al MAX_PAGES_PER_PAIR.
 *   4. dedup por slug de empresa + servicio.
 *
 * Cap suave: PROLIO_HABITISSIMO_ES_LIMIT (default 50.000) para evitar
 * ratoneras en runs largos. Off por defecto:
 * `PROLIO_RUN_HABITISSIMO_ES=true`.
 *
 * Nota: para ScrapedProfessional necesitamos un sourceId estable. Aquí
 * usamos `habitissimo:{servicio}:{empresa-slug}` derivado del href que
 * apunta al perfil canónico. Si la página no expone slug (algunas
 * variantes), generamos un fallback `slugify(nombre)`.
 */

const BASE =
  process.env.PROLIO_HABITISSIMO_ES_BASE || "https://www.habitissimo.es";
const REQUEST_DELAY_MS = 1500;
const PAGE_DELAY_MS = 2500;
const PER_PAGE = 10; // habitissimo SSR shows ~10 cards/page
const MAX_PAGES_PER_PAIR = 50; // 50 × 10 = 500 leads per (servicio, ciudad)
const DEFAULT_LIMIT = 50_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface Service {
  /** Habitissimo URL segment, e.g. "electricistas". */
  slug: string;
  /** Display name (used in metadata only). */
  label: string;
  category: CategoryKey;
}

// Habitissimo expone decenas de categorías; mapeamos solo aquellas que
// caen dentro de las CategoryKey de prolio (sin inventar mappings).
const SERVICES: Service[] = [
  { slug: "electricistas", label: "Electricistas", category: "electricidad" },
  { slug: "fontaneros", label: "Fontaneros", category: "fontaneria" },
  { slug: "aire-acondicionado", label: "Aire acondicionado", category: "hvac" },
  { slug: "calefaccion", label: "Calefacción", category: "hvac" },
  { slug: "carpinteros", label: "Carpinteros", category: "carpinteria" },
  { slug: "cerrajeros", label: "Cerrajeros", category: "cerrajero" },
  { slug: "mecanicos", label: "Mecánicos", category: "mecanica" },
  { slug: "arquitectos", label: "Arquitectos", category: "arquitecto" },
  { slug: "ingenieros", label: "Ingenieros", category: "ingenieria" },
];

// Top 50 ciudades ES (slug = idéntico al seed en src/cities.ts cuando
// existe; cuando no, fallback al slug habitissimo).
const TOP_CITIES: string[] = [
  "madrid", "barcelona", "valencia", "sevilla", "zaragoza",
  "malaga", "murcia", "palma", "las-palmas-de-gran-canaria", "bilbao",
  "alicante", "cordoba", "valladolid", "vigo", "gijon",
  "eixample", "granada", "a-coruna", "vitoria", "elche",
  "oviedo", "santa-cruz-de-tenerife", "badalona", "cartagena", "terrassa",
  "jerez-de-la-frontera", "sabadell", "mostoles", "alcala-de-henares",
  "pamplona", "fuenlabrada", "almeria", "leganes", "san-sebastian",
  "burgos", "santander", "castellon-de-la-plana", "getafe", "albacete",
  "alcorcon", "logrono", "badajoz", "salamanca", "huelva",
  "lleida", "marbella", "tarragona", "leon", "cadiz", "jaen",
];

// Habitissimo's slug for some cities differs from our seeds. When the
// destination URL needs translation, map here. Most cities are 1:1.
const CITY_URL_OVERRIDES: Record<string, string> = {
  "las-palmas-de-gran-canaria": "las-palmas-de-gran-canaria",
  "a-coruna": "a-coruna",
  "santa-cruz-de-tenerife": "santa-cruz-de-tenerife",
  "san-sebastian": "san-sebastian",
};

interface Card {
  name: string;
  slug: string; // habitissimo profile slug
  profileUrl: string;
  rating?: number;
  reviewCount?: number;
  cityLabel?: string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Parser tolerante: busca bloques de tarjeta que contienen un enlace a
 * `/pro/{slug}` o `/empresa/{slug}` y un nombre visible. No intentamos
 * extraer email/teléfono — habitissimo los oculta tras click-to-reveal
 * y necesitan POST de detalle; el email-extractor agent los recoge.
 */
function parseCards(html: string): Card[] {
  const out: Card[] = [];
  // Matches <a href="/pro/algo-123" ...>Nombre Empresa</a>
  const linkRe =
    /<a[^>]+href="(\/(?:pro|empresa)\/([a-z0-9][a-z0-9\-_]*)\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1];
    const slug = match[2];
    const inner = stripTags(match[3]);
    if (!slug || !inner) continue;
    // Filter out obvious chrome links (very short labels, "Ver más", etc.)
    if (inner.length < 3) continue;
    if (/^(ver|más|ver más|presupuesto|llamar|contactar|opiniones?)$/i.test(inner)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      name: inner,
      slug,
      profileUrl: `${BASE}${href}`,
    });
  }
  return out;
}

function parseTotal(html: string): number | undefined {
  // "Encuentra entre 686 profesionales de…"
  const m = html.match(
    /Encuentra\s+entre\s+([\d. ]+)\s+profesionales/i,
  );
  if (!m) return undefined;
  const n = Number(m[1].replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

async function fetchListPage(
  service: Service,
  citySlug: string,
  page: number,
): Promise<{ cards: Card[]; total?: number }> {
  const cityForUrl = CITY_URL_OVERRIDES[citySlug] ?? citySlug;
  const path =
    page <= 1
      ? `/empresas/${service.slug}/${cityForUrl}`
      : `/empresas/${service.slug}/${cityForUrl}/${page}`;
  const url = `${BASE}${path}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9",
    },
    signal: AbortSignal.timeout(45_000),
    redirect: "follow",
  });
  if (response.status === 404) return { cards: [] };
  if (!response.ok) {
    throw new Error(`habitissimo ${service.slug}/${citySlug} p${page} → HTTP ${response.status}`);
  }
  const html = await response.text();
  const cards = parseCards(html);
  const total = parseTotal(html);
  return { cards, total };
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const globalSeen = new Set<string>();
  outer: for (const service of SERVICES) {
    for (const citySlug of TOP_CITIES) {
      if (out.length >= limit) break outer;
      let cardsThisPair = 0;
      let total: number | undefined;
      try {
        for (let page = 1; page <= MAX_PAGES_PER_PAIR; page += 1) {
          if (out.length >= limit) break outer;
          const { cards, total: totalFromPage } = await fetchListPage(
            service,
            citySlug,
            page,
          );
          if (page === 1) total = totalFromPage;
          if (cards.length === 0) break;
          for (const card of cards) {
            const sourceId = `habitissimo:${service.slug}:${card.slug}`;
            if (globalSeen.has(sourceId)) continue;
            globalSeen.add(sourceId);
            out.push(
              normalise({
                source: "habitissimo-es" as ScrapeSource,
                country: "ES",
                sourceId,
                name: card.name,
                categoryKey: service.category,
                citySlug,
                website: card.profileUrl,
                metadata: {
                  country: "ES",
                  source_directory: "habitissimo.es",
                  servicio: service.slug,
                  servicio_label: service.label,
                  empresa_slug: card.slug,
                  profile_url: card.profileUrl,
                  total_in_pair: total,
                },
              }),
            );
            cardsThisPair += 1;
            if (out.length >= limit) break outer;
          }
          if (total !== undefined && page * PER_PAGE >= total) break;
          if (cards.length < PER_PAGE) break;
          await delay(REQUEST_DELAY_MS);
        }
      } catch (error) {
        console.error(
          `[habitissimo-es] ${service.slug}/${citySlug} failed: ${(error as Error).message}`,
        );
      }
      console.log(
        `[habitissimo-es] ${service.slug}/${citySlug} → ${cardsThisPair}${
          total !== undefined ? ` (reported ${total})` : ""
        }`,
      );
      await delay(PAGE_DELAY_MS);
    }
  }
  return out;
}

export const habitissimoEsSource: ScraperSource = {
  name: "habitissimo-es" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_HABITISSIMO_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runHabitissimoEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!habitissimoEsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_HABITISSIMO_ES_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    console.log("[habitissimo-es] no records fetched");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[habitissimo-es] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
