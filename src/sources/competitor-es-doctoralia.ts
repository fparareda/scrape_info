import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";

/**
 * Doctoralia ES — Spanish healthcare professional directory scraper.
 *
 * Pre-flight (2026-04-24):
 *
 *   robots.txt (https://www.doctoralia.es/robots.txt) — REACHABLE.
 *     User-agent:* Disallow blocks /buscar?, /ajax/, /api/,
 *     /registro-*, /anade-opinion/*, /edit-opinion/, /marketing/,
 *     /enlace, /clinicas/enlace and *?white_label. The category-by-city
 *     paths we use (/dentista/<city>, /psicologo/<city>,
 *     /fisioterapeuta/<city>, /medico-de-familia/<city>,
 *     /medico-general/<city>) are explicitly NOT blocked — the
 *     User-agent:* Allow:/ at the top of robots.txt covers them.
 *
 *   GET probe with Chrome UA:
 *     /dentista/barcelona       → 200, ~775 KB, 31 pros, 89 pages
 *     /psicologo/madrid         → 200
 *     /fisioterapeuta/madrid    → 200
 *     /medico-de-familia/madrid → 200
 *     /medicos/madrid           → 404 (no generic "medicos" parent;
 *                                  Doctoralia indexes by specialty only)
 *
 *   Cloudflare interstitial NOT observed. JSON-LD on listing pages
 *   carries only BreadcrumbList + Organization — NOT a list of pros.
 *   The pro data lives in Microdata + data-* attributes on each
 *   `data-test-id="result-item"` card:
 *     itemtype="http://schema.org/Physician"
 *     data-doctor-name="Dr. ..."
 *     data-doctor-url="https://www.doctoralia.es/<slug>/<spec>/<city>"
 *     data-result-id="<numeric>"
 *     data-eec-stars-rating="<0-5>"
 *     data-eec-opinions-count="<n>"
 *     data-eec-specialization-name="<Dentista|...>"
 *     data-eec-address-cities="<City>"
 *     itemprop="streetAddress" content="..."
 *     itemprop="addressLocality" content="..."
 *     <img itemprop="image" src="...">
 *   Phone + website live on the per-pro profile page only — fetching
 *   them would 31× the request budget per page, so v1 leaves
 *   `phone`/`website` null on the row. Future enhancement: enrich
 *   top-rated rows individually (separate scraper).
 *
 * Strategy:
 *   - For each (category, city) where the city has a Doctoralia URL,
 *     fetch /<spec-slug>/<city-slug> and extract every result card.
 *   - Cap at PROLIO_DOCTORALIA_LIMIT rows total per run (default 1000).
 *   - One page deep per (category, city) pair — pagination would
 *     multiply the load 89× on dense cities and we already get 31
 *     prime-ranked pros per page. Pagination can land in a follow-up
 *     once we see real yield.
 *   - Iterate (category × city), break once we hit cap.
 *
 * Off by default. Enabled via PROLIO_RUN_DOCTORALIA=true.
 * Workflow: .github/workflows/scrape-doctoralia.yml (weekly Sun 12:00 UTC).
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 1_000;
// 1 req/sec per spec — be deliberately gentle since Doctoralia is the
// only major source we have for ES healthcare pros.
const REQUEST_DELAY_MS = 1_000;

// --- Category mapping --------------------------------------------------

/**
 * Doctoralia specialty slug → Prolio CategoryKey. Doctoralia indexes by
 * specialty (no generic "médico" parent), so for the `medicina` category
 * we sweep both `medico-de-familia` (GP) and `medico-general` (general
 * practice). Both URLs return 200 and ~31 pros per page.
 *
 * Specialties without a Prolio `category_key` are dropped (currently
 * only `nutricionista`). `dentista` + `fisioterapia` were added to the
 * taxonomy in 2026-04 (migration 0058) — both wired below.
 */
interface DoctoraliaCategory {
  /** Doctoralia URL slug, used as `/<slug>/<city>`. */
  slug: string;
  /** Prolio category key for the produced rows. */
  category: CategoryKey;
  /** Human label for `metadata.doctoralia_specialty`. */
  specialty: string;
}

const DOCTORALIA_CATEGORIES: DoctoraliaCategory[] = [
  {
    slug: "medico-de-familia",
    category: "medicina",
    specialty: "Médico de familia",
  },
  {
    slug: "medico-general",
    category: "medicina",
    specialty: "Médico general",
  },
  { slug: "psicologo", category: "psicologia", specialty: "Psicólogo" },
  { slug: "dentista", category: "dentista", specialty: "Dentista" },
  {
    slug: "fisioterapeuta",
    category: "fisioterapia",
    specialty: "Fisioterapeuta",
  },
];

// --- HTTP helpers ------------------------------------------------------

async function politeFetch(
  url: string,
): Promise<{ status: number; body: string } | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[doctoralia] blocked polite UA (${response.status}); retrying with Chrome UA`,
          );
          continue;
        }
        return { status: response.status, body: "" };
      }
      if (!response.ok) return { status: response.status, body: "" };
      const body = await response.text();
      return { status: response.status, body };
    } catch (error) {
      clearTimeout(timer);
      console.warn(
        `[doctoralia] network error on ${url}: ${(error as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

// --- Parsing -----------------------------------------------------------

interface ParsedCard {
  sourceId: string;
  name: string;
  doctoraliaUrl: string;
  specialty?: string;
  city?: string;
  address?: string;
  rating?: number;
  reviewCount?: number;
  photoUrl?: string;
}

/**
 * Slice the listing HTML into per-card chunks. Each card opens with
 *   data-test-id="result-item"
 * and ends right before the next card (or before the closing `</li>`
 * pair). We intentionally use a forgiving regex over a DOM parser to
 * keep the source dependency-free.
 *
 * Doctoralia also renders "facility" cards (clinics) interleaved with
 * doctor cards. Those carry `data-ga4-entity-type="clinic"`; we filter
 * them out by requiring `data-doctor-name=` (only set on doctor cards).
 */
function splitCards(html: string): string[] {
  const cards: string[] = [];
  const open = /data-test-id="result-item"/g;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) positions.push(m.index);
  for (let i = 0; i < positions.length; i += 1) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : html.length;
    cards.push(html.slice(start, end));
  }
  return cards;
}

function attr(card: string, name: string): string | undefined {
  const re = new RegExp(`${name}=["']([^"']*)["']`);
  const m = card.match(re);
  return m ? m[1] : undefined;
}

function itempropContent(card: string, prop: string): string | undefined {
  // Match: itemprop="streetAddress" data-...="..." content="VAL"
  // Order of attributes varies — tolerate up to ~200 chars between
  // itemprop and content on the same tag.
  const re = new RegExp(
    `itemprop=["']${prop}["'][^>]{0,200}?content=["']([^"']*)["']`,
  );
  const m = card.match(re);
  return m ? m[1] : undefined;
}

function itempropImage(card: string): string | undefined {
  // <img itemprop="image" alt="..." src="//pixel-..."/>
  const re =
    /<img\b[^>]*?itemprop=["']image["'][^>]*?src=["']([^"']+)["']|<img\b[^>]*?src=["']([^"']+)["'][^>]*?itemprop=["']image["']/;
  const m = card.match(re);
  if (!m) return undefined;
  const url = m[1] ?? m[2];
  if (!url) return undefined;
  // Doctoralia ships protocol-relative URLs; canonicalise.
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}

function toNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Strip the "Dr.", "Dra.", "Sr.", "Sra." honorifics Doctoralia prepends
 * to most names. We keep the underlying name only — slugs/headers look
 * cleaner without them and our other sources (Google Places, OSM)
 * rarely include the title.
 */
function stripHonorific(name: string): string {
  return name.replace(/^(?:Dr|Dra|Sr|Sra|Lic)\.?\s+/i, "").trim();
}

function parseCard(card: string): ParsedCard | null {
  // Reject facility/clinic cards.
  const entityType = attr(card, "data-ga4-entity-type");
  if (entityType && entityType !== "doctor") return null;

  const rawName = attr(card, "data-doctor-name");
  if (!rawName) return null;
  const url = attr(card, "data-doctor-url");
  const resultId = attr(card, "data-result-id");
  if (!url || !resultId) return null;

  const name = stripHonorific(rawName);
  if (!name) return null;

  return {
    sourceId: `doctoralia:${resultId}`,
    name,
    doctoraliaUrl: url,
    specialty: attr(card, "data-eec-specialization-name"),
    city: attr(card, "data-eec-address-cities"),
    address: itempropContent(card, "streetAddress"),
    rating: toNumber(attr(card, "data-eec-stars-rating")),
    reviewCount: toNumber(attr(card, "data-eec-opinions-count")),
    photoUrl: itempropImage(card),
  };
}

// --- Per-page fetch + parse --------------------------------------------

async function fetchCategoryCityPage(
  doctoraliaSlug: string,
  citySlug: string,
  citySpanishName: string,
  categoryKey: CategoryKey,
  specialtyLabel: string,
  validCitySlugs: Set<string>,
): Promise<{ records: ScrapedProfessional[]; status: number }> {
  // Doctoralia uses kebab-no-accent (same rule as our slugify): "san
  // sebastián" → "san-sebastian", "a coruña" → "a-coruna". Build the
  // path slug from the canonical city name (rather than our `slug`)
  // because some of our DB slugs carry country-disambiguation suffixes
  // (e.g. "hamilton-ca", "london-ca", "columbus-oh") that wouldn't
  // exist on Doctoralia for ES anyway.
  const urlCitySlug = slugify(citySpanishName);
  if (!urlCitySlug) return { records: [], status: 0 };
  const url = `https://www.doctoralia.es/${doctoraliaSlug}/${urlCitySlug}`;

  const response = await politeFetch(url);
  if (!response) return { records: [], status: 0 };
  if (!response.body) return { records: [], status: response.status };

  const cards = splitCards(response.body);
  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoCity = 0;
  let droppedFacility = 0;
  let droppedNoData = 0;

  for (const card of cards) {
    const parsed = parseCard(card);
    if (!parsed) {
      // Distinguish facility vs malformed for log clarity.
      const et = attr(card, "data-ga4-entity-type");
      if (et && et !== "doctor") droppedFacility += 1;
      else droppedNoData += 1;
      continue;
    }
    if (seen.has(parsed.sourceId)) continue;
    seen.add(parsed.sourceId);

    // Map the card's reported locality to a Prolio city_slug. Doctoralia
    // reports city names like "Barcelona", "Madrid"; slugify ours and
    // compare against the seeded set. Fallback to the URL's city slug
    // (we already know that's valid because we filtered to known cities
    // upstream).
    const cardLocalitySlug = parsed.city ? slugify(parsed.city) : undefined;
    const mappedCity =
      cardLocalitySlug && validCitySlugs.has(cardLocalitySlug)
        ? cardLocalitySlug
        : citySlug;
    if (!validCitySlugs.has(mappedCity)) {
      droppedNoCity += 1;
      continue;
    }

    out.push(
      normalise({
        source: "doctoralia",
        sourceId: parsed.sourceId,
        name: parsed.name,
        categoryKey,
        citySlug: mappedCity,
        address: parsed.address,
        rating: parsed.rating,
        reviewCount: parsed.reviewCount,
        photoUrl: parsed.photoUrl,
        metadata: {
          country: "ES",
          doctoralia_url: parsed.doctoraliaUrl,
          doctoralia_specialty: parsed.specialty ?? specialtyLabel,
          doctoralia_category_slug: doctoraliaSlug,
        },
      }),
    );
  }

  console.log(
    `[doctoralia] ${doctoraliaSlug}/${urlCitySlug}: ` +
      `cards=${cards.length} kept=${out.length} ` +
      `droppedFacility=${droppedFacility} droppedNoCity=${droppedNoCity} ` +
      `droppedNoData=${droppedNoData}`,
  );
  return { records: out, status: response.status };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Public entrypoint -------------------------------------------------

export const competitorDoctoraliaSource: ScraperSource = {
  name: "doctoralia",
  enabled() {
    return process.env.PROLIO_RUN_DOCTORALIA === "true";
  },
  // One-shot bulk runner; per-target fetch is a no-op.
  async fetch() {
    return [];
  },
};

export interface DoctoraliaRunSummary {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export async function runCompetitorDoctoralia(): Promise<DoctoraliaRunSummary | null> {
  if (!competitorDoctoraliaSource.enabled()) return null;

  const limitRaw = Number(process.env.PROLIO_DOCTORALIA_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;

  const cities = await getCities({ country: "ES" });
  if (cities.length === 0) {
    console.warn(`[doctoralia] no ES cities seeded — skipping`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const validCitySlugs = new Set(cities.map((c) => c.slug));

  const sink = getSink();
  const all: ScrapedProfessional[] = [];
  let pageCount = 0;

  outer: for (const city of cities) {
    for (const cat of DOCTORALIA_CATEGORIES) {
      const { records, status } = await fetchCategoryCityPage(
        cat.slug,
        city.slug,
        city.name,
        cat.category,
        cat.specialty,
        validCitySlugs,
      );
      pageCount += 1;
      if (status === 403 || status === 503) {
        console.warn(
          `[doctoralia] got ${status}; aborting run to respect rate limits`,
        );
        break outer;
      }
      all.push(...records);
      if (all.length >= limit) {
        console.log(`[doctoralia] reached cap ${limit}, stopping`);
        break outer;
      }
      await delay(REQUEST_DELAY_MS);
    }
  }

  const capped = all.slice(0, limit);
  if (capped.length === 0) {
    console.log(`[doctoralia] done — pages=${pageCount} records=0`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await sink.upsert(capped);
  console.log(
    `[doctoralia] done — pages=${pageCount} records=${capped.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: capped.length, inserted, updated, skipped };
}
