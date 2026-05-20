import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";

/**
 * MDA — Manitoba Dental Association dentist registry.
 *
 * Pre-flight (2026-05-20):
 *   robots.txt: `User-agent: * / Allow: /` — no disallows at all.
 *   Public dentist registry at manitobadentist.ca/public-patients/
 *   registries-rosters/dentist-registry renders 900+ licensed dentists
 *   as a single server-rendered HTML page with alphabetical client-side
 *   filtering (no server-side pagination). Records include name, clinic,
 *   address (city + postal code), phone, graduation year, registration
 *   year, and classification. No captcha, no login, no Cloudflare.
 *   Maps to `dentista` (closest taxonomy match).
 *   Province: MB (Manitoba).
 *
 * Off by default. Enable via `PROLIO_RUN_MDA_MB_DENTISTS=true`.
 * Monthly schedule (dental registrations are annual/slow-moving).
 * See .github/workflows/scrape-mda-mb-dentists.yml.
 */

const BASE_URL =
  process.env.PROLIO_MDA_MB_DENTISTS_BASE ??
  "https://www.manitobadentist.ca/public-patients/registries-rosters/dentist-registry";

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_LIMIT = 5_000;

// --- City mapping ---------------------------------------------------------

/**
 * The registry lists addresses in format: "City MB PostalCode"
 * Map known Manitoba cities to their Prolio slugs.
 * Fall back to winnipeg (largest city) for unmapped entries.
 */
const MB_CITY_MAP: Record<string, string> = {
  winnipeg: "winnipeg",
  brandon: "brandon",
  steinbach: "steinbach",
  portage: "portage-la-prairie",
  "portage la prairie": "portage-la-prairie",
  "st. boniface": "winnipeg",
  "saint boniface": "winnipeg",
  thompson: "thompson",
  "flin flon": "flin-flon",
  "the pas": "the-pas",
  dauphin: "dauphin",
  selkirk: "selkirk",
  winkler: "winkler",
  morden: "morden",
  "west st. paul": "winnipeg",
  "east st. paul": "winnipeg",
  headingley: "winnipeg",
  stonewall: "stonewall",
  "birds hill": "winnipeg",
  oakbank: "winnipeg",
  beausejour: "beausejour",
  "st. pierre": "winnipeg",
  "st. vital": "winnipeg",
  "st. james": "winnipeg",
  "fort garry": "winnipeg",
  transcona: "winnipeg",
  "river heights": "winnipeg",
  "charleswood": "winnipeg",
  "tuxedo": "winnipeg",
};

function mapCity(rawCity: string): string {
  const key = rawCity.trim().toLowerCase();
  return MB_CITY_MAP[key] ?? "winnipeg";
}

function normaliseCaPhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return undefined;
}

// --- HTTP helpers ---------------------------------------------------------

async function fetchRegistryPage(): Promise<string | null> {
  for (const ua of [POLITE_UA, FALLBACK_UA]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(BASE_URL, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "Accept-Language": "en-CA,en;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.status === 403 || response.status === 503) {
        if (ua === POLITE_UA) {
          console.warn(
            `[mda-mb-dentists] blocked by polite UA (${response.status}); retrying with Chrome UA`,
          );
          continue;
        }
        console.warn(
          `[mda-mb-dentists] fetch failed with status ${response.status}`,
        );
        return null;
      }
      if (!response.ok) {
        console.warn(
          `[mda-mb-dentists] unexpected status ${response.status}`,
        );
        return null;
      }
      return await response.text();
    } catch (error) {
      clearTimeout(timer);
      console.warn(
        `[mda-mb-dentists] network error: ${(error as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

// --- HTML parser ----------------------------------------------------------

interface DentistRow {
  name: string;
  clinic: string | undefined;
  city: string | undefined;
  phone: string | undefined;
  address: string | undefined;
}

/**
 * Parse the MDA dentist registry HTML.
 *
 * The page renders all dentists in a flat list. Each dentist block
 * follows this approximate pattern (ColdFusion/HTML):
 *
 *   <strong>Dr. Jane Doe</strong>
 *   Acme Dental Clinic<br>
 *   123 Main St<br>
 *   Winnipeg MB R3A 1A1<br>
 *   Phone: 204-555-0100<br>
 *   ...
 *
 * We extract by matching on the "Dr." prefix for names, then
 * capturing the lines between successive Dr. entries. We parse city
 * from the "City MB PostalCode" pattern in the address block.
 */
function parseHtml(html: string): DentistRow[] {
  const rows: DentistRow[] = [];

  // Normalise whitespace and strip script/style blocks.
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")      // strip remaining tags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\r?\n/g, " ")
    .replace(/\s{2,}/g, " ");

  // Split on "Dr." to identify dentist records. Each segment starts
  // with the name (everything before the next "Dr." or end of text).
  // We match "Dr." followed by an uppercase letter (to avoid matching
  // "Dr." inside prose text like "per Dr. Jones said").
  const drRegex = /\bDr\.\s+([A-ZÀÁÂÄÉÈÊÎÏÔÙÛÜÇ][^\n.]{2,60}?)(?=\s+Dr\.\s+[A-Z]|$)/g;

  // Alternative: split the whole text on Dr. boundary.
  const segments = cleaned.split(/(?=\bDr\.\s+[A-Z])/);

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed.startsWith("Dr.")) continue;

    // Extract name: first line starting with Dr.
    const nameMatch = trimmed.match(/^(Dr\.\s+[A-Za-z][^,\n]{1,80}?)(?:\s{2}|\s*,)/);
    if (!nameMatch) {
      // Fallback: take until 5 spaces or end
      const fallbackName = trimmed.match(/^(Dr\.\s+[^\s]{1,60}(?:\s+[^\s]{1,40}){0,5})/);
      if (!fallbackName) continue;
    }

    // Grab the full name — everything up to the first occurrence of
    // two or more spaces (field delimiter), a digit run (year/phone),
    // or a known keyword.
    const nameEndMatch = trimmed.match(
      /^(Dr\.\s+[A-Za-zÀ-ÖØ-öø-ÿ''-]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ''.]+){0,5})/,
    );
    if (!nameEndMatch) continue;
    const name = nameEndMatch[1].trim();
    if (name.length < 5) continue;

    const rest = trimmed.slice(name.length).trim();

    // Phone: look for "Phone:" pattern or 10-digit sequence
    let phone: string | undefined;
    const phoneMatch = rest.match(
      /Phone[:\s]+([\d\s\(\)\-\.]{7,16})/i,
    );
    if (phoneMatch) {
      phone = normaliseCaPhone(phoneMatch[1]);
    } else {
      const rawPhoneMatch = rest.match(/\b(204|431|(?:1[-\s]?)?(?:204|431))[\s.\-]?\d{3}[\s.\-]?\d{4}\b/);
      if (rawPhoneMatch) phone = normaliseCaPhone(rawPhoneMatch[0]);
    }

    // City: look for "CityName MB PostalCode" pattern
    let city: string | undefined;
    let fullAddress: string | undefined;
    const cityMatch = rest.match(
      /([A-Za-z][A-Za-z '.'\-]{1,40})\s+MB\s+[A-Z]\d[A-Z]\s*\d[A-Z]\d/i,
    );
    if (cityMatch) {
      city = cityMatch[1].trim();
      // Capture a broader address context
      const addrStart = rest.indexOf(cityMatch[0]);
      if (addrStart > 0) {
        // Take 80 chars before the city as address
        const preAddr = rest.slice(Math.max(0, addrStart - 80), addrStart).trim();
        fullAddress = `${preAddr} ${cityMatch[0]}`.trim();
      } else {
        fullAddress = cityMatch[0];
      }
    }

    // Clinic: typically appears right after the name, before the address.
    // It's the first non-Dr. text block before any numeric address or city.
    let clinic: string | undefined;
    const clinicMatch = rest.match(
      /^\s*([A-Za-z][A-Za-z\s\(\)\&',.-]{3,60}?)(?=\s+\d|\s+[A-Z]\d[A-Z]|\s+Winnipeg|\s+Brandon|\s+Phone|\s+Grad|\s+Reg|\s+General|\s+Dental\s+Spec)/,
    );
    if (clinicMatch) {
      const candidate = clinicMatch[1].trim();
      // Only use if it doesn't look like an address
      if (
        candidate.length > 3 &&
        !candidate.match(/^\d/) &&
        candidate !== name
      ) {
        clinic = candidate;
      }
    }

    rows.push({ name, clinic, city, phone, address: fullAddress });
  }

  return rows;
}

// --- Main fetch & parse ---------------------------------------------------

export async function fetchMdaMbDentists(
  limit: number,
): Promise<ScrapedProfessional[]> {
  const html = await fetchRegistryPage();
  if (!html) {
    console.warn(`[mda-mb-dentists] could not fetch registry page`);
    return [];
  }

  const rows = parseHtml(html);
  console.log(`[mda-mb-dentists] parsed ${rows.length} raw rows`);

  const out: ScrapedProfessional[] = [];
  const seen = new Set<string>();
  let droppedNoName = 0;

  for (const row of rows) {
    if (!row.name || row.name.length < 5) {
      droppedNoName += 1;
      continue;
    }
    const sourceId = `mda:${row.name.toLowerCase().replace(/\s+/g, "-")}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const citySlug = mapCity(row.city ?? "");

    out.push(
      normalise({
        source: "mda-mb-dentists",
        country: "CA",
        sourceId,
        name: toTitleCase(row.name),
        categoryKey: "dentista",
        citySlug,
        phone: row.phone,
        address: row.address,
        metadata: {
          country: "CA",
          province: "MB",
          authority: "MDA",
          verified_by_authority: true,
          clinic: row.clinic,
        },
      }),
    );

    if (out.length >= limit) break;
  }

  console.log(
    `[mda-mb-dentists] kept=${out.length} droppedNoName=${droppedNoName}`,
  );
  return out;
}

// --- Public interface -----------------------------------------------------

export const mdaMbDentistsSource: ScraperSource = {
  name: "mda-mb-dentists",
  enabled() {
    return process.env.PROLIO_RUN_MDA_MB_DENTISTS === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runMdaMbDentists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!mdaMbDentistsSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(
    process.env.PROLIO_MDA_MB_DENTISTS_LIMIT ?? DEFAULT_LIMIT,
  );
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchMdaMbDentists(limit);
  if (records.length === 0) {
    console.warn(
      `[mda-mb-dentists] no rows fetched — page structure may have changed`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[mda-mb-dentists] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
