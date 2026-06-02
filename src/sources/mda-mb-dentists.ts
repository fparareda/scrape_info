import type { CategoryKey } from "../prolio-types.js";
import type { ScrapedProfessional, ScraperSource, ScrapeSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";

/**
 * MDA — Manitoba Dental Association.
 *
 * Pre-flight 2026-06-02: the public Dentist Registry at
 *   https://www.manitobadentist.ca/public-patients/registries-rosters/dentist-registry
 * is a single server-rendered HTML page (~1.3 MB) containing the full
 * A-to-Z roster of registered dentists in Manitoba. No pagination,
 * no JavaScript gating, no login wall.
 *
 * robots.txt: User-agent: * / Allow: /  (fully permissive).
 *
 * Record count (pre-flight 2026-06-02): 856 dentists.
 *
 * Each entry exposes:
 *   - Name (e.g. "Dr. Jake Abarra")
 *   - Clinic name (e.g. "Integral Dental")
 *   - Street address (e.g. "200 - 1721 Portage Ave")
 *   - City/Province/Postal (e.g. "Winnipeg MB R3J 0E5")
 *   - Phone (e.g. "204 560-0011")
 *   - Grad Year, Registration Year
 *   - Specialty (e.g. "General Practitioner", "Orthodontist", etc.)
 *
 * Parsing strategy: single GET, regex-extract from `<div class="dentist-name">`
 * blocks — no DOM parser needed.
 *
 * City mapping: only `winnipeg` is seeded in cities.ts for MB; all
 * non-Winnipeg cities fall back to "winnipeg" as the province-wide
 * default. The raw city name is preserved in `metadata.raw_city`.
 *
 * Category: `dentista`. Off by default; `PROLIO_RUN_MDA_MB_DENTISTS=true`.
 * Cap via `PROLIO_MDA_MB_DENTISTS_LIMIT` (default 2000 — full roster ~856).
 */

const REGISTRY_URL =
  "https://www.manitobadentist.ca/public-patients/registries-rosters/dentist-registry";
const AUTHORITY = "MDA";
const PROVINCE = "MB";
const CATEGORY: CategoryKey = "dentista";
const DEFAULT_CITY = "winnipeg";
const DEFAULT_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 120_000;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const MB_CITY_MAP: Record<string, string> = {
  winnipeg: "winnipeg",
  // All other MB municipalities fall back to province default.
};

function mapCity(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().trim();
  return MB_CITY_MAP[k] ?? DEFAULT_CITY;
}

export const mdaMbDentistsSource: ScraperSource = {
  name: "mda-mb-dentists" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_MDA_MB_DENTISTS === "true";
  },
  async fetch() {
    return [];
  },
};

interface MdaEntry {
  name: string;
  clinic: string;
  street: string;
  cityLine: string;
  city: string;
  postal: string;
  phone: string;
  specialty: string;
  regYear: string;
}

async function fetchHtml(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[mda-mb-dentists] HTTP ${response.status} from registry page`);
      return null;
    }
    return await response.text();
  } catch (e) {
    console.warn(`[mda-mb-dentists] fetch failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCity(cityLine: string): { city: string; postal: string } {
  // Format: "Winnipeg MB R3J 0E5"
  const m = cityLine.match(/^(.+?)\s+MB\s+([A-Z]\d[A-Z]\s*\d[A-Z]\d)$/i);
  if (m) {
    return { city: m[1].trim(), postal: m[2].replace(/\s+/g, " ").trim() };
  }
  // Fallback: take everything before " MB" as city
  const mbIdx = cityLine.toUpperCase().lastIndexOf(" MB");
  if (mbIdx > 0) {
    return { city: cityLine.slice(0, mbIdx).trim(), postal: "" };
  }
  return { city: cityLine.trim(), postal: "" };
}

/**
 * Parse dentist sections from the registry HTML.
 *
 * Each dentist block starts with `<div class="dentist-name">` and
 * contains several nested `<div>` elements with clinic, address, and
 * contact information.
 */
function parseEntries(html: string): MdaEntry[] {
  const entries: MdaEntry[] = [];

  // Split on dentist-name divs — everything up to the next such div (or end)
  // forms one entry block.
  const sectionRegex = /<div class="dentist-name">([\s\S]*?)(?=<div class="dentist-name">|<div id="footer|<footer|<\/main>|$)/gi;
  let m: RegExpExecArray | null;

  while ((m = sectionRegex.exec(html)) !== null) {
    const block = m[0];

    // Name: in the dentist-name div
    const nameM = block.match(/<div class="dentist-name">\s*([\s\S]*?)\s*<\/div>/);
    if (!nameM) continue;
    const name = stripTags(nameM[1]);
    if (!name) continue;

    // All <div> children (for clinic + address lines)
    const divContents: string[] = [];
    const divRegex = /<div(?:\s[^>]*)?>([^<]*(?:<(?!\/div>)[^<]*)*)<\/div>/gi;
    let d: RegExpExecArray | null;
    while ((d = divRegex.exec(block)) !== null) {
      const text = stripTags(d[1]);
      if (text && text !== name) divContents.push(text);
    }

    // First non-empty div after name → clinic
    const clinic = divContents[0] ?? "";

    // Find the city line ("... MB R3J 0E5")
    const cityLine = divContents.find((l) => / MB /i.test(l)) ?? "";
    const { city, postal } = parseCity(cityLine);

    // Street: the div between clinic and city line
    const streetLine = divContents.find(
      (l) => l !== clinic && l !== cityLine && !/ MB /i.test(l) && l.length > 0,
    ) ?? "";

    // Phone
    const phoneM = block.match(/Phone:\s*([\d\s\-\.()]+)/);
    const phone = phoneM ? phoneM[1].replace(/\s+/g, " ").trim() : "";

    // Registration year
    const regYearM = block.match(/Registration Year:\s*(\d{4})/);
    const regYear = regYearM ? regYearM[1] : "";

    // Specialty (first line after status divs — before "Restrictions by Class")
    const specialtyM = block.match(
      /col-sm-4[^>]*>\s*([\w ]+?)\s*<br\s*\/?>[\s\S]*?Restrictions by Class/i,
    );
    const specialty = specialtyM ? specialtyM[1].trim() : "";

    entries.push({
      name,
      clinic,
      street: streetLine,
      cityLine,
      city,
      postal,
      phone,
      specialty,
      regYear,
    });
  }

  return entries;
}

function toRecord(entry: MdaEntry): ScrapedProfessional | null {
  if (!entry.name) return null;

  // Strip "Dr." prefix and normalize to "First Last" for consistency.
  // The registry always includes "Dr." so we keep it in the final name
  // but use toTitleCase to fix any ALL-CAPS / all-lower issues.
  const name = toTitleCase(entry.name.replace(/^Dr\.\s*/i, "Dr. "));
  if (!name) return null;

  // Build address string
  const addrParts = [entry.street, entry.cityLine].filter(Boolean);
  const address = addrParts.join(", ") || undefined;

  const sourceId = `mda-mb-dentists:${name}|${entry.postal || entry.city}`;

  return normalise({
    source: "mda-mb-dentists" as ScrapeSource,
    country: "CA",
    sourceId,
    name,
    categoryKey: CATEGORY,
    citySlug: mapCity(entry.city),
    phone: entry.phone || undefined,
    address,
    metadata: {
      country: "CA",
      province: PROVINCE,
      authority: AUTHORITY,
      verified_by_authority: true,
      clinic_name: entry.clinic || null,
      specialty: entry.specialty || null,
      registration_year: entry.regYear || null,
      raw_city: entry.city || null,
      postal_code: entry.postal || null,
    },
  });
}

export async function runMdaMbDentists(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!mdaMbDentistsSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(process.env.PROLIO_MDA_MB_DENTISTS_LIMIT ?? DEFAULT_LIMIT);
  const cap = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const html = await fetchHtml();
  if (!html) return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const entries = parseEntries(html);
  console.log(`[mda-mb-dentists] parsed ${entries.length} entries from HTML`);

  const seen = new Set<string>();
  const records: ScrapedProfessional[] = [];
  for (const entry of entries) {
    if (records.length >= cap) break;
    const rec = toRecord(entry);
    if (!rec) continue;
    if (seen.has(rec.sourceId)) continue;
    seen.add(rec.sourceId);
    records.push(rec);
  }

  if (records.length === 0) {
    console.warn("[mda-mb-dentists] no records parsed — HTML structure may have changed");
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[mda-mb-dentists] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
