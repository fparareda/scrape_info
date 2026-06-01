import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { toTitleCase } from "./_bulk-utils.js";

/**
 * BCNA — BC Notaries Association.
 *
 * Public member directory at
 *   https://www.bcnotaryassociation.ca/find/
 *
 * Pre-flight 2026-06-01 (datacenter IP):
 *   GET https://www.bcnotaryassociation.ca/find/?city=Vancouver
 *     → 200, ~50 KB HTML, 89 notary entries for Vancouver alone.
 *   GET https://www.bcnotaryassociation.ca/find/?city=Surrey
 *     → 200, 54 notaries.
 *   No auth, no Cloudflare, no CAPTCHA. robots.txt not found (no
 *   restrictions). Total: ~458 notaries across 74 BC cities/towns.
 *
 * HTML structure per notary (inside <div class='notaries'>):
 *   <div class='third'>
 *     <h4> FULL NAME </h4>
 *     <p>Firm name (optional)</p>
 *     <p>phone<br>fax<br><a href="website">url</a><br>
 *        <span class="filtered_content">ROT13-obfuscated email</span></p>
 *     <p>Street address<br>City BC<br>PostalCode</p>
 *     <p>Languages: ...</p>
 *   </div>
 *
 * Strategy: iterate over all 74 cities, fetch one page per city, parse
 * <div class='third'> blocks, de-duplicate by canonical name+city key.
 * 1.5 s polite delay between city requests.
 *
 * Email obfuscation: the site uses a trivial ROT13 cipher on mailto hrefs
 * (e.g. "znvy:..." → "mail:..."). We decode and strip; email is not stored
 * in the canonical record.
 *
 * Category: `notario`. Province BC. Authority BCNA.
 * Off by default — `PROLIO_RUN_BCNA_BC_NOTARIES=true` to enable.
 * Cap via `PROLIO_BCNA_BC_NOTARIES_LIMIT` (default 1_000).
 */

const BASE_URL = "https://www.bcnotaryassociation.ca/find/";
const AUTHORITY = "BCNA";
const PROVINCE = "BC";
const CATEGORY: CategoryKey = "notario";
const DEFAULT_LIMIT = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 1_500;
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";

/** All cities listed in the directory's city dropdown (as of 2026-06-01). */
const CITIES: Array<{ label: string; slug: string }> = [
  { label: "100 Mile House", slug: "100-mile-house" },
  { label: "Abbotsford", slug: "abbotsford" },
  { label: "Aldergrove", slug: "aldergrove" },
  { label: "Armstrong", slug: "armstrong" },
  { label: "Bowser", slug: "bowser" },
  { label: "Burnaby", slug: "burnaby" },
  { label: "Campbell River", slug: "campbell-river" },
  { label: "Castlegar", slug: "castlegar" },
  { label: "Chilliwack", slug: "chilliwack" },
  { label: "Coquitlam", slug: "coquitlam" },
  { label: "Courtenay", slug: "courtenay" },
  { label: "Cranbrook", slug: "cranbrook" },
  { label: "Creston", slug: "creston" },
  { label: "Cumberland", slug: "cumberland" },
  { label: "Dawson Creek", slug: "dawson-creek" },
  { label: "Delta", slug: "delta" },
  { label: "Duncan", slug: "duncan" },
  { label: "Fort Nelson", slug: "fort-nelson" },
  { label: "Fort St James", slug: "fort-st-james" },
  { label: "Fort St. John", slug: "fort-st-john" },
  { label: "Garibaldi Highlands", slug: "garibaldi-highlands" },
  { label: "Kamloops", slug: "kamloops" },
  { label: "Kelowna", slug: "kelowna" },
  { label: "Keremeos", slug: "keremeos" },
  { label: "Kitimat", slug: "kitimat" },
  { label: "Ladysmith", slug: "ladysmith" },
  { label: "Lake Country", slug: "lake-country" },
  { label: "Lake Cowichan", slug: "lake-cowichan" },
  { label: "Langford", slug: "langford" },
  { label: "Langley", slug: "langley" },
  { label: "Maple Ridge", slug: "maple-ridge" },
  { label: "Matsqui Village", slug: "matsqui-village" },
  { label: "Merritt", slug: "merritt" },
  { label: "Mission", slug: "mission" },
  { label: "Nanaimo", slug: "nanaimo" },
  { label: "Nelson", slug: "nelson" },
  { label: "New Westminster", slug: "new-westminster" },
  { label: "North Saanich", slug: "north-saanich" },
  { label: "North Vancouver", slug: "north-vancouver" },
  { label: "Parksville", slug: "parksville" },
  { label: "Penticton", slug: "penticton" },
  { label: "Pitt Meadows", slug: "pitt-meadows" },
  { label: "Port Alberni", slug: "port-alberni" },
  { label: "Port Coquitlam", slug: "port-coquitlam" },
  { label: "Port Moody", slug: "port-moody" },
  { label: "Prince George", slug: "prince-george" },
  { label: "Prince Rupert", slug: "prince-rupert" },
  { label: "Quathiaski Cove", slug: "quathiaski-cove" },
  { label: "Quesnel", slug: "quesnel" },
  { label: "Revelstoke", slug: "revelstoke" },
  { label: "Richmond", slug: "richmond" },
  { label: "Salmon Arm", slug: "salmon-arm" },
  { label: "Salt Spring Island", slug: "salt-spring-island" },
  { label: "Sechelt", slug: "sechelt" },
  { label: "Sidney", slug: "sidney" },
  { label: "Smithers", slug: "smithers" },
  { label: "Snug Cove (Bowen Island)", slug: "snug-cove" },
  { label: "Sooke", slug: "sooke" },
  { label: "Squamish", slug: "squamish" },
  { label: "Squirrel Cove", slug: "squirrel-cove" },
  { label: "Summerland", slug: "summerland" },
  { label: "Surrey", slug: "surrey" },
  { label: "Terrace", slug: "terrace" },
  { label: "Tofino", slug: "tofino" },
  { label: "Trail", slug: "trail" },
  { label: "Vancouver", slug: "vancouver" },
  { label: "Vernon", slug: "vernon" },
  { label: "Victoria", slug: "victoria" },
  { label: "West Vancouver", slug: "west-vancouver" },
  { label: "Westbank", slug: "westbank" },
  { label: "White Rock", slug: "white-rock" },
  { label: "Williams Lake", slug: "williams-lake" },
];

export const bcnaBcNotariesSource: ScraperSource = {
  name: "bcna-bc-notaries" as ScrapeSource,
  enabled() {
    return process.env.PROLIO_RUN_BCNA_BC_NOTARIES === "true";
  },
  async fetch() {
    return [];
  },
};

interface BcnaRow {
  name: string;
  firm?: string;
  phone?: string;
  address?: string;
  cityLabel: string;
  citySlug: string;
  languages?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse all notary <div class='third'> blocks from a city page's HTML.
 * Each block has up to 5 <p> children:
 *   0: firm name (optional)
 *   1: phone / fax / website / email
 *   2: address (street + "City BC" + postal)
 *   3: languages (optional)
 */
function parseBlocks(
  html: string,
  cityLabel: string,
  citySlug: string,
): BcnaRow[] {
  const out: BcnaRow[] = [];
  // Each notary block: <div class='third'>…</div>
  const blockRe = /<div\s+class='third'>([\s\S]*?)<\/div>/gi;
  for (const m of html.matchAll(blockRe)) {
    const inner = m[1];

    // Name is in <h4>…</h4>
    const nameMatch = inner.match(/<h4>\s*([^<]+?)\s*<\/h4>/i);
    if (!nameMatch) continue;
    const name = cleanHtml(nameMatch[1]).trim();
    if (!name) continue;

    // Collect all <p> texts
    const pTexts: string[] = [];
    const pRe = /<p>([\s\S]*?)<\/p>/gi;
    for (const pm of inner.matchAll(pRe)) {
      pTexts.push(cleanHtml(pm[1]).trim());
    }

    // Heuristic: detect which <p> is address (contains "BC" and a postal code
    // pattern like V1A 2B3, or just ends with a province abbreviation).
    let firm: string | undefined;
    let phone: string | undefined;
    let address: string | undefined;
    let languages: string | undefined;

    for (const p of pTexts) {
      if (!p) continue;
      if (/languages?:/i.test(p)) {
        languages = p.replace(/^languages?:\s*/i, "").trim();
      } else if (/\bBC\b/.test(p) && /\bV\d[A-Z]\s*\d[A-Z]\d\b/i.test(p)) {
        // Looks like an address with "City BC V1A2B3" pattern
        address = p;
      } else if (/\(\d{3}\)\s*\d{3}[-\s]\d{4}|\d{3}[-\s]\d{3}[-\s]\d{4}/.test(p)) {
        // Contains a phone number
        if (!phone) phone = p.split(/[\s,]/)[0].trim();
      } else if (!firm && !address && !languages) {
        // First non-phone, non-address, non-language <p> is likely the firm name
        firm = p;
      }
    }

    out.push({
      name,
      firm: firm || undefined,
      phone: phone || undefined,
      address: address || undefined,
      cityLabel,
      citySlug,
      languages: languages || undefined,
    });
  }
  return out;
}

async function fetchCityPage(
  cityLabel: string,
): Promise<string | null> {
  const url = `${BASE_URL}?city=${encodeURIComponent(cityLabel)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[bcna-bc-notaries] city="${cityLabel}" HTTP ${res.status}`,
      );
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(
      `[bcna-bc-notaries] city="${cityLabel}" fetch error: ${(e as Error).message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toRecord(row: BcnaRow): ScrapedProfessional | null {
  if (!row.name) return null;
  const displayName = toTitleCase(row.name);
  const sourceId = `bcna:${displayName.toLowerCase().replace(/\s+/g, "-")}:${row.citySlug}`;
  return normalise({
    source: "bcna-bc-notaries" as ScrapeSource,
    country: "CA",
    sourceId,
    name: displayName,
    categoryKey: CATEGORY,
    citySlug: row.citySlug,
    metadata: {
      country: "CA",
      province: PROVINCE,
      authority: AUTHORITY,
      verified_by_authority: true,
      firm: row.firm ?? null,
      phone: row.phone ?? null,
      address: row.address ?? null,
      city_label: row.cityLabel,
      languages: row.languages ?? null,
    },
  });
}

export async function runBcnaBcNotaries(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!bcnaBcNotariesSource.enabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };

  const rawLimit = Number(
    process.env.PROLIO_BCNA_BC_NOTARIES_LIMIT ?? DEFAULT_LIMIT,
  );
  const cap =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const allRows: BcnaRow[] = [];
  const seenKeys = new Set<string>();

  for (const city of CITIES) {
    if (allRows.length >= cap) break;
    const html = await fetchCityPage(city.label);
    if (!html) {
      await delay(PAGE_DELAY_MS);
      continue;
    }
    const rows = parseBlocks(html, city.label, city.slug);
    let added = 0;
    for (const r of rows) {
      const key = `${r.name.toLowerCase()}|${city.slug}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      allRows.push(r);
      added++;
      if (allRows.length >= cap) break;
    }
    console.log(
      `[bcna-bc-notaries] city="${city.label}" rows=${rows.length} new=${added} total=${allRows.length}`,
    );
    await delay(PAGE_DELAY_MS);
  }

  const records: ScrapedProfessional[] = [];
  const seenSourceIds = new Set<string>();
  for (const row of allRows) {
    const rec = toRecord(row);
    if (!rec) continue;
    if (seenSourceIds.has(rec.sourceId)) continue;
    seenSourceIds.add(rec.sourceId);
    records.push(rec);
  }

  if (records.length === 0) {
    console.warn(
      `[bcna-bc-notaries] fetched 0 records — endpoint may be down or HTML structure changed`,
    );
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await getSink().upsert(records);
  console.log(
    `[bcna-bc-notaries] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
