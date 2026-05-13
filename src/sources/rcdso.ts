import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * RCDSO — Royal College of Dental Surgeons of Ontario.
 *
 * Pre-flight (2026-05-13):
 *   robots.txt — User-agent: * with Allow: /. Only /scripts and /styles
 *     are Disallow'd (static assets). Specific AI-bot agents (ClaudeBot,
 *     GPTBot, Google-Extended, etc.) are individually Disallow'd but our
 *     polite crawler UA is NOT in that exclusion list and is therefore
 *     permitted. Verified 2026-05-13.
 *
 *   Directory — https://www.rcdso.org/find-a-dentist
 *     The search form posts via HTTP GET to /find-a-dentist/search-results
 *     with params: Alpha (last-name prefix), City, MbrSpecialty, etc.
 *     Searching with an empty Alpha and a specific City returns ALL
 *     registered dentists in that city in a single server-rendered HTML
 *     response (no pagination, no captcha, no JS required). Example:
 *       /find-a-dentist/search-results?Alpha=&City=Toronto
 *     The response includes: registrant name, registration number,
 *     status (Member / Suspended / etc), practice name, street address,
 *     phone (when listed), and a Google Maps link containing the full
 *     address including city and postal code.
 *
 *   Record count — Toronto alone returns ~2,474 active Members.
 *     Coverage is Ontario-wide (all ON cities in our city index).
 *
 *   Auth / WAF — Only RCDSO_Language=en-ca cookie (language preference)
 *     is needed. No session token, no CSRF token. Verified from a
 *     non-browser HTTP client 2026-05-13.
 *
 *   Rate-limit — No explicit crawl-delay in robots.txt.
 *     We apply a 1,500 ms delay between city requests to be polite.
 *
 * Category: dentista.
 * Province: ON (Ontario).
 * Off by default; set PROLIO_RUN_RCDSO=true to enable.
 */

const BASE =
  process.env.PROLIO_RCDSO_BASE || "https://www.rcdso.org";
const SEARCH_PATH = "/find-a-dentist/search-results";

const POLITE_UA =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

const REQUEST_DELAY_MS = 1_500;
const REQUEST_TIMEOUT_MS = 90_000; // city queries return 2–10 MB HTML
const DEFAULT_LIMIT = 10_000;

/**
 * Ontario cities covered by the RCDSO registry. The city name must
 * exactly match one of the values returned by the /Predictive/Cities
 * endpoint. The slug must match a seeded city slug in our DB.
 */
const ON_CITIES: Array<{ slug: string; query: string }> = [
  { slug: "toronto", query: "Toronto" },
  { slug: "ottawa", query: "Ottawa" },
  { slug: "mississauga", query: "Mississauga" },
  { slug: "brampton", query: "Brampton" },
  { slug: "hamilton", query: "Hamilton" },
  { slug: "london", query: "London" },
  { slug: "markham", query: "Markham" },
  { slug: "vaughan", query: "Vaughan" },
  { slug: "kitchener", query: "Kitchener" },
  { slug: "windsor", query: "Windsor" },
  { slug: "richmond-hill", query: "Richmond Hill" },
  { slug: "oakville", query: "Oakville" },
  { slug: "burlington", query: "Burlington" },
  { slug: "greater-sudbury", query: "Sudbury" },
  { slug: "oshawa", query: "Oshawa" },
  { slug: "barrie", query: "Barrie" },
  { slug: "st-catharines", query: "St. Catharines" },
  { slug: "cambridge", query: "Cambridge" },
  { slug: "kingston", query: "Kingston" },
  { slug: "ajax", query: "Ajax" },
  { slug: "whitby", query: "Whitby" },
  { slug: "thunder-bay", query: "Thunder Bay" },
  { slug: "waterloo", query: "Waterloo" },
  { slug: "guelph", query: "Guelph" },
  { slug: "pickering", query: "Pickering" },
  { slug: "niagara-falls", query: "Niagara Falls" },
  { slug: "peterborough", query: "Peterborough" },
  { slug: "newmarket", query: "Newmarket" },
  { slug: "stratford", query: "Stratford" },
  { slug: "brantford", query: "Brantford" },
];

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

interface DentistRecord {
  id: string;
  name: string;
  regNumber: string;
  status: string;
  practiceName: string;
  streetAddress: string;
  phone: string;
  /** Full address string as extracted from the Google Maps deep-link. */
  mapsAddress: string;
}

/**
 * Extract the full address (including city + postal code) from the
 * "View on Map" Google Maps link embedded in each result section.
 *   https://www.google.com/maps/search/?api=1&query=1303%20Richmond%20Rd%2C%20Ottawa%2C%20K2B%207Y4
 * → "1303 Richmond Rd, Ottawa, K2B 7Y4"
 */
function extractMapsAddress(section: string): string {
  const m = section.match(/maps\/search\/\?api=1&amp;query=([^"]+)"/);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1].replace(/&amp;/g, "&"));
  } catch {
    return m[1];
  }
}

/**
 * Extract the phone number from a tel: href.
 * Returns empty string if not found.
 */
function extractPhone(section: string): string {
  const m = section.match(/href="tel:(\d+)"/);
  return m ? m[1] : "";
}

/**
 * Format a raw 10-digit CA phone string as "+1XXXXXXXXXX".
 */
function normPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits || "";
}

/** Strip HTML tags from a string and collapse whitespace. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse all dentist records from the search-results HTML for one city.
 *
 * Each record occupies a `<section class="row hide">…</section>` block.
 * Fields extracted:
 *   - dentist id (from the /find-a-dentist/search-results/dentist?id= link)
 *   - name (from the <h2><a> text)
 *   - registration number (dt "Registration Number:" → dd text)
 *   - status (dt "Status:" → dd text)
 *   - practice name (first <span> inside <address>)
 *   - street address (second <span> inside <address>)
 *   - phone (tel: href)
 *   - maps address (Google Maps search link)
 */
function parseResults(html: string): DentistRecord[] {
  const out: DentistRecord[] = [];
  const seen = new Set<string>();

  // Each dentist sits in <section class="row hide">…</section>
  const sectionRe = /<section class="row hide">([\s\S]*?)<\/section>/g;
  for (const sectionMatch of html.matchAll(sectionRe)) {
    const sec = sectionMatch[1];

    // Dentist id + name from the <h2><a href="/…/dentist?id=NNN"> Name </a></h2>
    const idMatch = sec.match(
      /href="\/find-a-dentist\/search-results\/dentist\?id=(\d+)"[^>]*>\s*([^<]+?)\s*<\/a>/,
    );
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const rawName = idMatch[2].trim();

    // Registration Number
    const regMatch = sec.match(
      /Registration Number:[\s\S]{0,200}?<dd>\s*([\d]+)\s*<\/dd>/,
    );
    const regNumber = regMatch ? regMatch[1].trim() : "";

    // Status
    const statusMatch = sec.match(
      /Status:[\s\S]{0,200}?<dd>\s*([^<]+?)\s*<\/dd>/,
    );
    const status = statusMatch ? statusMatch[1].trim() : "";

    // Practice name + street from <address> spans
    // The first duplicate-free <address> block in the section holds the data.
    // Structure: <span>PRACTICE NAME</span><span>STREET</span>
    const addrMatch = sec.match(/<address[^>]*>[\s\S]*?<\/address>/);
    let practiceName = "";
    let streetAddress = "";
    if (addrMatch) {
      const spans = [...addrMatch[0].matchAll(/<span>([^<]{2,})<\/span>/g)];
      if (spans[0]) practiceName = stripHtml(spans[0][1]);
      if (spans[1]) streetAddress = stripHtml(spans[1][1]);
    }

    // Phone
    const rawPhone = extractPhone(sec);
    const phone = normPhone(rawPhone);

    // Maps address (includes city + postal code)
    const mapsAddress = extractMapsAddress(sec);

    out.push({
      id,
      name: rawName,
      regNumber,
      status,
      practiceName,
      streetAddress,
      phone,
      mapsAddress,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchCity(cityQuery: string): Promise<string | null> {
  const url = new URL(`${BASE}${SEARCH_PATH}`);
  url.searchParams.set("Alpha", "");
  url.searchParams.set("City", cityQuery);

  for (const ua of [POLITE_UA]) {
    try {
      const res = await fetch(url.toString(), {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-CA,en;q=0.9",
          // Language cookie required by the server
          Cookie: "RCDSO_Language=en-ca",
          Referer: `${BASE}/find-a-dentist`,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        return res.text();
      }
      if (res.status === 403 || res.status === 503) {
        console.warn(`[rcdso] city "${cityQuery}" → ${res.status} (UA: ${ua.slice(0, 20)})`);
        continue;
      }
      console.error(`[rcdso] city "${cityQuery}" → HTTP ${res.status}`);
      return null;
    } catch (err) {
      console.error(`[rcdso] city "${cityQuery}" fetch error: ${(err as Error).message}`);
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main bulk fetch
// ---------------------------------------------------------------------------

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const globalSeen = new Set<string>();

  for (const city of ON_CITIES) {
    if (out.length >= limit) break;

    let html: string | null;
    try {
      html = await fetchCity(city.query);
    } catch (err) {
      console.error(
        `[rcdso] ${city.slug} unexpected error: ${(err as Error).message}`,
      );
      html = null;
    }

    if (!html) {
      console.warn(`[rcdso] ${city.slug} — skipped (no HTML)`);
      continue;
    }

    const records = parseResults(html);
    let added = 0;

    for (const r of records) {
      if (out.length >= limit) break;
      if (globalSeen.has(r.id)) continue;
      globalSeen.add(r.id);

      // Skip non-active members (Suspended, Revoked, etc.)
      if (r.status && !r.status.toLowerCase().includes("member")) continue;

      // Build address: prefer maps address (contains city + postal code),
      // fall back to street + practice name.
      const address = r.mapsAddress
        ? r.mapsAddress
        : [r.practiceName, r.streetAddress].filter(Boolean).join(", ");

      out.push(
        normalise({
          source: "rcdso",
          sourceId: `rcdso:${r.id}`,
          name: toTitleCase(r.name.replace(/^-\s*/, "").trim()),
          categoryKey: "dentista",
          citySlug: city.slug,
          phone: r.phone || undefined,
          address: address || undefined,
          licenseNumber: r.regNumber || undefined,
          metadata: {
            country: "CA",
            province: "ON",
            authority: "RCDSO",
            verified_by_authority: true,
            status: r.status,
            practice_name: r.practiceName || undefined,
            profile_url: `${BASE}/find-a-dentist/search-results/dentist?id=${r.id}`,
          },
        }),
      );
      added += 1;
    }

    console.log(
      `[rcdso] ${city.slug} → ${records.length} parsed, ${added} added (total ${out.length})`,
    );

    if (out.length < limit && ON_CITIES.indexOf(city) < ON_CITIES.length - 1) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const rcdsoSource: ScraperSource = {
  name: "rcdso",
  enabled() {
    return process.env.PROLIO_RUN_RCDSO === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runRcdso(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!rcdsoSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_RCDSO_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[rcdso] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
