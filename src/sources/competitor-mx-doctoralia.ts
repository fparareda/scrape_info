import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getSink } from "../sink.js";
import { getCities } from "../cities.js";
import {
  DOCTORALIA_CATEGORIES,
  splitCards,
  parseCard,
} from "./competitor-es-doctoralia.js";

/**
 * Doctoralia MX — Mexican variant of the ES scraper. Reuses the
 * parsing helpers (`splitCards`, `parseCard`, category map) from
 * `competitor-es-doctoralia.ts` because Doctoralia ships the same
 * card markup and specialty slugs across all DocPlanner-operated
 * regions. The only differences are:
 *
 *   1. Domain: `www.doctoralia.com.mx` (vs `.es`).
 *   2. Locale header: `es-MX` (vs `es-ES`).
 *   3. Cities seed: `getCities({ country: "MX" })` — top 30 metros
 *      from migration 0070.
 *   4. metadata.country: "MX" so downstream queries can split the
 *      provenance.
 *
 * Off by default. `PROLIO_RUN_DOCTORALIA_MX=true` enables.
 * Cap with `PROLIO_DOCTORALIA_MX_LIMIT` (default 5000 — Doctoralia
 * indexes ~80k pros in MX, so a weekly 5k run climbs to full
 * coverage in ~16 weeks).
 *
 * Same polite stance as ES: 1 req/sec, identified UA, fallback to
 * Chrome UA on 403/503, abort the whole run if rate-limited.
 */

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_DELAY_MS = 1_000;
const DEFAULT_LIMIT = 5_000;

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
          "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[doctoralia-mx] blocked polite UA (${response.status}); retrying with Chrome UA`,
          );
          continue;
        }
        return { status: response.status, body: "" };
      }
      if (!response.ok) return { status: response.status, body: "" };
      return { status: response.status, body: await response.text() };
    } catch (error) {
      clearTimeout(timer);
      console.warn(
        `[doctoralia-mx] network error on ${url}: ${(error as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const competitorDoctoraliaMxSource: ScraperSource = {
  name: "doctoralia-mx",
  enabled() {
    return process.env.PROLIO_RUN_DOCTORALIA_MX === "true";
  },
  async fetch() {
    return [];
  },
};

export interface DoctoraliaMxRunSummary {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export async function runCompetitorDoctoraliaMx(): Promise<DoctoraliaMxRunSummary | null> {
  if (!competitorDoctoraliaMxSource.enabled()) return null;

  const limitRaw = Number(
    process.env.PROLIO_DOCTORALIA_MX_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;

  const cities = await getCities({ country: "MX" });
  if (cities.length === 0) {
    console.warn(`[doctoralia-mx] no MX cities seeded — skipping`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const validCitySlugs = new Set(cities.map((c) => c.slug));

  const sink = getSink();
  const all: ScrapedProfessional[] = [];
  let pageCount = 0;

  outer: for (const city of cities) {
    for (const cat of DOCTORALIA_CATEGORIES) {
      const urlCitySlug = slugify(city.name);
      if (!urlCitySlug) continue;
      const url = `https://www.doctoralia.com.mx/${cat.slug}/${urlCitySlug}`;

      const response = await politeFetch(url);
      pageCount += 1;
      if (!response) continue;
      if (response.status === 403 || response.status === 503) {
        console.warn(
          `[doctoralia-mx] got ${response.status}; aborting run to respect rate limits`,
        );
        break outer;
      }
      if (!response.body) continue;

      const cards = splitCards(response.body);
      const seen = new Set<string>();
      let kept = 0;
      let droppedNoCity = 0;

      for (const card of cards) {
        const parsed = parseCard(card);
        if (!parsed) continue;
        if (seen.has(parsed.sourceId)) continue;
        seen.add(parsed.sourceId);

        const cardLocalitySlug = parsed.city ? slugify(parsed.city) : undefined;
        const mappedCity =
          cardLocalitySlug && validCitySlugs.has(cardLocalitySlug)
            ? cardLocalitySlug
            : city.slug;
        if (!validCitySlugs.has(mappedCity)) {
          droppedNoCity += 1;
          continue;
        }

        all.push(
          normalise({
            source: "doctoralia-mx",
            sourceId: `doctoralia-mx:${parsed.sourceId.replace(/^doctoralia:/, "")}`,
            name: parsed.name,
            categoryKey: cat.category,
            citySlug: mappedCity,
            address: parsed.address,
            rating: parsed.rating,
            reviewCount: parsed.reviewCount,
            photoUrl: parsed.photoUrl,
            metadata: {
              country: "MX",
              doctoralia_url: parsed.doctoraliaUrl,
              doctoralia_specialty: parsed.specialty ?? cat.specialty,
              doctoralia_category_slug: cat.slug,
            },
          }),
        );
        kept += 1;
      }
      console.log(
        `[doctoralia-mx] ${cat.slug}/${urlCitySlug}: cards=${cards.length} kept=${kept} droppedNoCity=${droppedNoCity}`,
      );

      if (all.length >= limit) {
        console.log(`[doctoralia-mx] reached cap ${limit}, stopping`);
        break outer;
      }
      await delay(REQUEST_DELAY_MS);
    }
  }

  const capped = all.slice(0, limit);
  if (capped.length === 0) {
    console.log(`[doctoralia-mx] done — pages=${pageCount} records=0`);
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const { inserted, updated, skipped } = await sink.upsert(capped);
  console.log(
    `[doctoralia-mx] done — pages=${pageCount} records=${capped.length} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: capped.length, inserted, updated, skipped };
}
