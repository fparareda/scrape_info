import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay } from "./_bulk-utils.js";

/**
 * instaladoresoficiales.com — Certified electrical installers (ES).
 *
 * Spanish directory of FENIE-affiliated certified electrical installation
 * companies, aggregated from provincial colegios. All listings are
 * officially certified ("electricistas certificados"). Spain-wide coverage
 * via geographic hierarchy: /instaladores-electricos/{ccaa}/{province}/{city}/
 *
 * Pre-flight (2026-06-05):
 *   URL: https://instaladoresoficiales.com/instaladores-electricos/
 *   robots.txt: User-agent: * → only /buscar/ disallowed.
 *     /instaladores-electricos/ is explicitly allowed (Allow: /).
 *   No Cloudflare, no CAPTCHA, no login wall. WordPress static HTML.
 *   Madrid 1,588 entries (province total); Barcelona 1,192; Alicante 703;
 *   Spain-wide estimated 10,000–15,000 companies.
 *
 * Crawl strategy:
 *   1. Fetch /instaladores-electricos/ → extract CCAA (community) links.
 *   2. For each CCAA page → extract province links.
 *   3. For each province page → extract city links.
 *   4. For each city page → extract company cards.
 *   City granularity → real citySlug (from URL segment).
 *   2-second inter-request polite delay.
 *
 * Company card fields available in listing page:
 *   - Company name (h2/h3 heading in card)
 *   - Registration ID (e.g. "Nº Registro: 2396")
 *   - Address, city, province (shown in card footer)
 *   - Phone
 *   - Specialties (Baja Tensión, Alta Tensión, Telecomunicaciones, RR.EE.)
 *   - NIF/CIF on detail page (not fetched — listing data sufficient for upsert)
 *
 * Maps to `electricidad` — first Spain-wide certified electrician directory.
 * Different source from the open RII División B PR (#120), which covers
 * Ministry-registered gas installers, not FENIE-certified electricians.
 * Off by default; enable via PROLIO_RUN_INSTALADORESOFICIALES_ES=true.
 */

const BASE_URL = "https://instaladoresoficiales.com";
const ROOT_URL = `${BASE_URL}/instaladores-electricos/`;
const CRAWL_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 20_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[instaladoresoficiales-es] HTTP ${response.status} on ${url}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    console.warn(
      `[instaladoresoficiales-es] fetch error (${url}): ${(error as Error).message}`,
    );
    return null;
  }
}

function extractLinks(html: string, basePrefix: string): string[] {
  const links: string[] = [];
  const regex = /href="(https?:\/\/instaladoresoficiales\.com\/instaladores-electricos\/[^"]+?)"/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const href = m[1];
    if (href.startsWith(basePrefix) && href !== basePrefix) {
      // Only direct children (one level deeper)
      const rest = href.slice(basePrefix.length).replace(/\/$/, "");
      if (!rest.includes("/")) {
        links.push(href.endsWith("/") ? href : href + "/");
      }
    }
  }
  return [...new Set(links)];
}

function slugFromUrl(url: string): string {
  const trimmed = url.endsWith("/") ? url.slice(0, -1) : url;
  const parts = trimmed.split("/");
  return parts[parts.length - 1] ?? "";
}

interface CompanyCard {
  name: string;
  registroId: string;
  address: string;
  cityName: string;
  provinceName: string;
  phone: string;
  specialties: string[];
  detailUrl: string;
}

function parseCompanyCards(html: string, cityPageUrl: string): CompanyCard[] {
  const cards: CompanyCard[] = [];

  // Article cards on city listing pages follow a recurring pattern.
  // Each has a heading with the company name and a body with meta fields.
  const cardRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let cardMatch: RegExpExecArray | null;

  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const block = cardMatch[1];

    // Company name from <h2> or <h3>
    const nameMatch = block.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
    const name = nameMatch
      ? nameMatch[1].replace(/<[^>]+>/g, "").trim()
      : "";
    if (!name) continue;

    // Detail page URL
    const linkMatch = block.match(/href="(https?:\/\/instaladoresoficiales\.com\/[^"]+?)"/i);
    const detailUrl = linkMatch ? linkMatch[1] : cityPageUrl;

    // Registration number: "Nº Registro: 2396" or "Registro Nº: 2396"
    const registroMatch = block.match(/[Nn]º\s*[Rr]egistro[:\s]+(\d+)/i)
      ?? block.match(/[Rr]egistro\s*[Nn]º[:\s]+(\d+)/i)
      ?? block.match(/[Rr]egistro[:\s]+([A-Z0-9/-]+)/i);
    const registroId = registroMatch ? registroMatch[1].trim() : "";

    // Phone
    const phoneMatch = block.match(/(?:Teléfono|Tel\.?)[:\s]*([\d\s\-+]+)/i)
      ?? block.match(/(\+34\s?\d[\d\s]{8,}|\d{3}[\s-]?\d{3}[\s-]?\d{3})/);
    const phone = phoneMatch ? phoneMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    // Address — look for dirección or street patterns
    const addressMatch = block.match(/(?:Dirección|Calle|Av\.|Plaza|C\/)[:\s]*([\s\S]*?)(?:<|Teléfono|$)/i);
    const address = addressMatch
      ? addressMatch[1].replace(/<[^>]+>/g, "").trim().replace(/\s+/g, " ")
      : "";

    // City and province are usually in the URL or in the card footer text
    const provinceMatch = block.match(/(?:Provincia|Province)[:\s]*([^<\n]+)/i);
    const provinceName = provinceMatch
      ? provinceMatch[1].replace(/<[^>]+>/g, "").trim()
      : "";

    // Specialties: look for keyword badges
    const specialties: string[] = [];
    if (/baja\s*tensi[oó]n/i.test(block)) specialties.push("Baja Tensión");
    if (/alta\s*tensi[oó]n/i.test(block)) specialties.push("Alta Tensión");
    if (/telecomunicac/i.test(block)) specialties.push("Telecomunicaciones");
    if (/energ[ií]a[s]?\s*renovable/i.test(block)) specialties.push("Energías Renovables");

    cards.push({ name, registroId, address, cityName: "", provinceName, phone, specialties, detailUrl });
  }

  return cards;
}

function toProvinceSlug(provinceName: string): string {
  const map: Record<string, string> = {
    "madrid": "MD",
    "barcelona": "B",
    "valencia": "V",
    "sevilla": "SE",
    "zaragoza": "Z",
    "málaga": "MA",
    "malaga": "MA",
    "murcia": "MU",
    "palma": "PM",
    "las palmas": "GC",
    "bilbao": "BI",
    "alicante": "A",
    "córdoba": "CO",
    "cordoba": "CO",
    "valladolid": "VA",
    "vigo": "PO",
    "gijón": "O",
    "gijon": "O",
    "granada": "GR",
    "cádiz": "CA",
    "cadiz": "CA",
  };
  const lower = provinceName.toLowerCase().trim();
  return map[lower] ?? provinceName.toUpperCase().slice(0, 2);
}

export const instaladoresoficialesEsSource: ScraperSource = {
  name: "instaladoresoficiales-es" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_INSTALADORESOFICIALES_ES === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runInstaladoresoficialesEs(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!instaladoresoficialesEsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_INSTALADORESOFICIALES_ES_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  // Step 1: fetch root page → CCAA (community) links
  const rootHtml = await fetchHtml(ROOT_URL);
  if (!rootHtml) {
    console.warn("[instaladoresoficiales-es] could not fetch root listing — aborting");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const ccaaLinks = extractLinks(rootHtml, ROOT_URL);
  console.log(`[instaladoresoficiales-es] found ${ccaaLinks.length} CCAA links`);

  const records: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoName = 0;

  for (const ccaaUrl of ccaaLinks) {
    if (records.length >= cap) break;
    await delay(CRAWL_DELAY_MS);

    const ccaaHtml = await fetchHtml(ccaaUrl);
    if (!ccaaHtml) continue;

    const provinceLinks = extractLinks(ccaaHtml, ccaaUrl);

    for (const provinceUrl of provinceLinks) {
      if (records.length >= cap) break;
      await delay(CRAWL_DELAY_MS);

      const provinceHtml = await fetchHtml(provinceUrl);
      if (!provinceHtml) continue;

      const provinceSlug = slugFromUrl(provinceUrl);
      const cityLinks = extractLinks(provinceHtml, provinceUrl);

      for (const cityUrl of cityLinks) {
        if (records.length >= cap) break;
        await delay(CRAWL_DELAY_MS);

        const cityHtml = await fetchHtml(cityUrl);
        if (!cityHtml) continue;

        const citySlug = slugFromUrl(cityUrl);
        const cards = parseCompanyCards(cityHtml, cityUrl);

        for (const card of cards) {
          if (records.length >= cap) break;
          if (!card.name) {
            droppedNoName += 1;
            continue;
          }

          // sourceId: registration number if available, otherwise name slug
          const idPart = card.registroId
            ? card.registroId
            : card.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          const sourceId = `instaladoresoficiales-es:${provinceSlug}:${idPart}`;

          if (seen.has(sourceId)) continue;
          seen.add(sourceId);

          records.push(
            normalise({
              source: "instaladoresoficiales-es" as ScrapeSource,
              country: "ES",
              sourceId,
              name: card.name,
              categoryKey: "electricidad",
              citySlug,
              phone: card.phone || undefined,
              address: card.address || undefined,
              licenseNumber: card.registroId || undefined,
              metadata: {
                country: "ES",
                province_slug: provinceSlug,
                province: card.provinceName || provinceSlug,
                authority: "instaladoresoficiales.com / FENIE",
                verified_by_authority: true,
                specialties: card.specialties.length > 0 ? card.specialties : undefined,
                registro_id: card.registroId || undefined,
              },
            }),
          );
        }

        if (records.length % 500 === 0 && records.length > 0) {
          console.log(
            `[instaladoresoficiales-es] progress: city=${citySlug} accumulated=${records.length}`,
          );
        }
      }
    }
  }

  console.log(
    `[instaladoresoficiales-es] parsed=${records.length} droppedNoName=${droppedNoName}`,
  );

  if (records.length === 0) {
    console.log("[instaladoresoficiales-es] no records — HTML structure may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[instaladoresoficiales-es] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
