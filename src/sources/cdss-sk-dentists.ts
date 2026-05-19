import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScrapeSource, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase, normaliseNorthAmericanPhone, delay } from "./_bulk-utils.js";

/**
 * CDSS — College of Dental Surgeons of Saskatchewan.
 *
 * Pre-flight 2026-05-19: the public member directory at
 *   https://members.saskdentists.com/dentists-addresses
 * is a Joomla CMS page fully rendered server-side. robots.txt only blocks
 * Joomla system paths (/administrator/, /bin/, /cache/, /tmp/) — the
 * /dentists-addresses path is unrestricted. No login, no Cloudflare, no
 * CAPTCHA. Estimated ~1 000–1 200 registrants.
 *
 * Access pattern:
 *   Alphabetical filter: ?searchby=1&searchterm={A-Z}  → General Practitioners
 *   All specialists:     ?searchby=2                   → all specialties in one page
 *
 * Fields: full name, registration type, street address, city, province,
 * postal code, phone (tel: href). All records are mapped to the seeded
 * Saskatchewan city closest to their declared city. Rows with no recognised
 * city slug are mapped to `saskatoon` (primary SK city seed) and the raw
 * city is stored in metadata for future re-mapping.
 *
 * Category: dentista. Country: CA. Province: SK. Authority: CDSS.
 * Off by default — PROLIO_RUN_CDSS_SK_DENTISTS=true.
 * Cap via PROLIO_CDSS_SK_DENTISTS_LIMIT (default 3 000).
 * Cadence: monthly.
 */

const BASE_URL = "https://members.saskdentists.com";
const LIST_PATH = "/dentists-addresses";
const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DELAY_MS = 2_000;
const DEFAULT_LIMIT = 3_000;
const DEFAULT_CITY = "saskatoon";
const CATEGORY: CategoryKey = "dentista";
const UPSERT_BATCH_SIZE = 500;

// Saskatchewan city slug map — only the seeded cities matter.
const SK_CITY_MAP: Record<string, string> = {
  saskatoon: "saskatoon",
  regina: "regina",
  "prince albert": "prince-albert",
  moose: "moose-jaw",
  "moose jaw": "moose-jaw",
  lloydminster: "lloydminster",
  yorkton: "yorkton",
  swift: "swift-current",
  "swift current": "swift-current",
  "north battleford": "north-battleford",
  estevan: "estevan",
  weyburn: "weyburn",
  warman: "warman",
  martensville: "martensville",
  humboldt: "humboldt",
  melfort: "melfort",
};

function mapSkCity(raw: string | undefined): string {
  if (!raw) return DEFAULT_CITY;
  const key = raw.trim().toLowerCase();
  const exact = SK_CITY_MAP[key];
  if (exact) return exact;
  // Prefix match (e.g. "Moose Jaw, SK" → "moose-jaw").
  for (const [k, v] of Object.entries(SK_CITY_MAP)) {
    if (key.startsWith(k)) return v;
  }
  return DEFAULT_CITY;
}

// Strip HTML tags and decode common entities.
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

interface CdssRow {
  name: string;
  registrationType: string;
  address: string;
  city: string;
  province: string;
  postalCode: string;
  phone?: string;
}

// Joomla CDSS table pattern. Each member row contains 5 cells:
//   Name | Registration Type | Address | City, Prov, Postal | Phone
// Phone may appear as <a href="tel:..."> or plain text.
function parseRows(html: string): CdssRow[] {
  const rows: CdssRow[] = [];
  // Extract all <tr> blocks (skip header rows that lack enough cells).
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trm: RegExpExecArray | null;
  while ((trm = trRe.exec(html)) !== null) {
    const inner = trm[1];
    // Pull all <td> blocks from this row.
    const cells: string[] = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdm: RegExpExecArray | null;
    while ((tdm = tdRe.exec(inner)) !== null) {
      cells.push(stripTags(tdm[1]));
    }
    if (cells.length < 4) continue;

    const [nameRaw, regType = "", addrRaw = "", cityRaw = "", phoneRaw = ""] = cells;
    if (!nameRaw || nameRaw.length < 3) continue;
    // Skip header rows (e.g. "Name", "Dr.", etc.).
    if (/^(name|registrant|type|address|city|phone)$/i.test(nameRaw)) continue;

    // Phone extraction from raw td content (may be tel: href or plain digits).
    const telMatch = trm[1].match(/href="tel:([^"]+)"/i);
    const phone = telMatch ? telMatch[1].trim() : phoneRaw || undefined;

    // Parse city/province/postal from combined cell like "Saskatoon, SK S7H 2L1"
    let city = "";
    let province = "";
    let postalCode = "";
    const cityParts = cityRaw.split(",").map((p) => p.trim());
    if (cityParts.length >= 1) city = cityParts[0];
    if (cityParts.length >= 2) {
      // "SK S7H 2L1" — province is first token, postal is rest.
      const [prov = "", ...rest] = cityParts[1].split(/\s+/);
      province = prov;
      postalCode = rest.join(" ");
    }

    rows.push({
      name: nameRaw,
      registrationType: regType,
      address: addrRaw,
      city,
      province,
      postalCode,
      phone: phone || undefined,
    });
  }
  return rows;
}

async function fetchPage(params: URLSearchParams): Promise<string | null> {
  const url = `${BASE_URL}${LIST_PATH}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-CA,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn(`[cdss-sk-dentists] ${url} HTTP ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (e) {
    clearTimeout(timer);
    console.warn(
      `[cdss-sk-dentists] fetch failed for ${url}: ${(e as Error).message}`,
    );
    return null;
  }
}

export const cdssSkDentistsSource: ScraperSource = {
  name: "cdss-sk-dentists" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_CDSS_SK_DENTISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runCdssSkDentists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!cdssSkDentistsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const limit = (() => {
    const raw = Number(process.env.PROLIO_CDSS_SK_DENTISTS_LIMIT ?? DEFAULT_LIMIT);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
  })();

  const sink = getSink();
  const seen = new Set<string>();
  let batch: ScrapedProfessional[] = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let droppedNoName = 0;

  // Pass 1: General Practitioners — one request per letter A-Z.
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  outer: for (const letter of letters) {
    if (seen.size >= limit) break;
    const params = new URLSearchParams({ searchby: "1", searchterm: letter });
    const html = await fetchPage(params);
    if (!html) continue;
    const rows = parseRows(html);
    console.log(`[cdss-sk-dentists] GP letter=${letter} rows=${rows.length}`);

    for (const row of rows) {
      if (seen.size >= limit) break outer;
      if (!row.name || row.name.length < 3) {
        droppedNoName += 1;
        continue;
      }
      const key = `${row.name}:${row.address}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const citySlug = mapSkCity(row.city);
      const fullAddress = [row.address, row.city, row.province, row.postalCode]
        .filter(Boolean)
        .join(", ");

      batch.push(
        normalise({
          source: "cdss-sk-dentists" as ScrapeSource,
          sourceId: `cdss-sk:${key}`,
          name: toTitleCase(row.name),
          categoryKey: CATEGORY,
          citySlug,
          phone: normaliseNorthAmericanPhone(row.phone),
          address: fullAddress || undefined,
          metadata: {
            country: "CA",
            province: "SK",
            verified_by_authority: true,
            authority: "CDSS",
            registration_type: row.registrationType || undefined,
            raw_city: row.city || undefined,
            postal_code: row.postalCode || undefined,
          },
        }),
      );

      if (batch.length >= UPSERT_BATCH_SIZE) {
        const r = await sink.upsert(batch);
        inserted += r.inserted;
        updated += r.updated;
        skipped += r.skipped;
        batch = [];
      }
    }

    await delay(REQUEST_DELAY_MS);
  }

  // Pass 2: Specialists (all in one request).
  if (seen.size < limit) {
    const params = new URLSearchParams({ searchby: "2" });
    const html = await fetchPage(params);
    if (html) {
      const rows = parseRows(html);
      console.log(`[cdss-sk-dentists] specialists rows=${rows.length}`);
      for (const row of rows) {
        if (seen.size >= limit) break;
        if (!row.name || row.name.length < 3) {
          droppedNoName += 1;
          continue;
        }
        const key = `${row.name}:${row.address}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const citySlug = mapSkCity(row.city);
        const fullAddress = [row.address, row.city, row.province, row.postalCode]
          .filter(Boolean)
          .join(", ");

        batch.push(
          normalise({
            source: "cdss-sk-dentists" as ScrapeSource,
            sourceId: `cdss-sk:${key}`,
            name: toTitleCase(row.name),
            categoryKey: CATEGORY,
            citySlug,
            phone: normaliseNorthAmericanPhone(row.phone),
            address: fullAddress || undefined,
            metadata: {
              country: "CA",
              province: "SK",
              verified_by_authority: true,
              authority: "CDSS",
              registration_type: row.registrationType || undefined,
              raw_city: row.city || undefined,
              postal_code: row.postalCode || undefined,
              is_specialist: true,
            },
          }),
        );

        if (batch.length >= UPSERT_BATCH_SIZE) {
          const r = await sink.upsert(batch);
          inserted += r.inserted;
          updated += r.updated;
          skipped += r.skipped;
          batch = [];
        }
      }
    }
  }

  if (batch.length > 0) {
    const r = await sink.upsert(batch);
    inserted += r.inserted;
    updated += r.updated;
    skipped += r.skipped;
  }

  console.log(
    `[cdss-sk-dentists] done — scraped=${seen.size} inserted=${inserted} ` +
      `updated=${updated} skipped=${skipped} droppedNoName=${droppedNoName}`,
  );
  return { fetched: seen.size, inserted, updated, skipped };
}
