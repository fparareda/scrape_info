import type { CategoryKey } from "../prolio-types.js";
import type {
  ScrapedProfessional,
  ScrapeSource,
  ScraperSource,
} from "../types.js";
import { normalise, slugify } from "../normalise.js";
import { getCities } from "../cities.js";
import { getSink } from "../sink.js";
import { withScrapeRun } from "../telemetry.js";
import { mxStateToCity } from "./_mx-states.js";

/**
 * RE Franchises MX — unified scraper for the major real-estate
 * brokerages operating in Mexico:
 *
 *   1. EasyBroker / Pincali (~12.8k brokers, primary feed — paginated
 *      HTML at https://pincali.com/inmobiliarios?page=N). Pincali is
 *      EasyBroker's public marketplace and covers all four target
 *      franchises (Century 21, RE/MAX, Coldwell Banker, plus thousands
 *      of independents). The franchise is encoded in the agency name
 *      visible on each row; we detect it via regex and stamp it into
 *      `metadata.franchise`.
 *   2. Century 21 MX — `https://www.century21mexico.com/v/offices` is
 *      client-rendered (cookie-walled SPA-ish behaviour) and serves
 *      empty HTML to our UA. Reserved for a future Playwright adapter;
 *      today this sub-fetcher is a stub that returns [].
 *   3. RE/MAX MX — `https://www.remax.com.mx` only ships a dropdown of
 *      states feeding a form POST. No flat directory exposed. Stub.
 *   4. Coldwell Banker MX — `https://www.coldwellbanker.com.mx` blocks
 *      our UA with 403 (likely Cloudflare). Stub.
 *
 * Net coverage on first run: ~10-12k MX real-estate professionals via
 * Pincali alone, plus franchise tagging for the subset that publishes
 * on Pincali. The three franchise direct stubs are wired so a future
 * pass can drop them in without touching this file's public shape.
 *
 * Category mapping: Prolio's taxonomy doesn't yet have a real-estate
 * category, so all rows are filed under `arquitecto` as a proxy (per
 * task brief). The franchise + agency live in metadata for downstream
 * re-categorisation when the schema grows.
 *
 * Off by default. `PROLIO_RUN_RE_FRANCHISES_MX=true` enables.
 * Cap with `PROLIO_RE_FRANCHISES_MX_LIMIT` (default 12000).
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const DEFAULT_LIMIT = 12_000;
const PINCALI_BASE = "https://www.pincali.com/inmobiliarios";
const POLITE_DELAY_MS = 600;
const CATEGORY: CategoryKey = "arquitecto";
const SOURCE_NAME = "re-franchises-mx" as ScrapeSource;

type FranchiseKey =
  | "century21"
  | "remax"
  | "coldwell-banker"
  | "keller-williams"
  | "independent";

interface PincaliRow {
  name: string;
  slug: string;
  agency?: string;
  locationRaw?: string; // "Mérida, Yucatán"
}

// ---------- Helpers ----------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Detect franchise membership from an agency name. */
function detectFranchise(agency: string | undefined): FranchiseKey {
  if (!agency) return "independent";
  const lc = agency.toLowerCase();
  if (/\bre\s*\/?\s*max\b|\bremax\b/.test(lc)) return "remax";
  if (/century\s*21|c21\b/.test(lc)) return "century21";
  if (/coldwell\s*banker|coldwellb/.test(lc)) return "coldwell-banker";
  if (/keller\s*williams|\bkw\b/.test(lc)) return "keller-williams";
  return "independent";
}

const FRANCHISE_AUTHORITY: Record<FranchiseKey, string> = {
  century21: "Century 21 Mexico",
  remax: "RE/MAX Mexico",
  "coldwell-banker": "Coldwell Banker Mexico",
  "keller-williams": "Keller Williams Mexico",
  independent: "EasyBroker / Pincali",
};

/** Map a Pincali "City, State" string to a seeded MX city slug. */
function pincaliLocationToCitySlug(
  locationRaw: string | undefined,
  validSlugs: Set<string>,
): string | null {
  if (!locationRaw) return null;
  const parts = locationRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  // Try city first (left part).
  const city = parts[0];
  const citySlug = slugify(city);
  if (citySlug) {
    if (validSlugs.has(citySlug)) return citySlug;
    // Try common MX suffix collisions
    const withMx = `${citySlug}-mx`;
    if (validSlugs.has(withMx)) return withMx;
  }
  // Fall back to state mapping (right part).
  const state = parts[parts.length - 1];
  const viaState = mxStateToCity(state);
  if (viaState && validSlugs.has(viaState)) return viaState;
  return null;
}

// ---------- Pincali sub-fetcher ---------------------------------------

/**
 * Pincali's list page renders each broker as a `<div class="agent-profile">`
 * card. The relevant inner shape is:
 *
 *   <div class="agent-profile">
 *     <a class="eb-avatar --xl" href="/inmobiliarios/{slug}">
 *       <img alt="{NAME}">
 *     </a>
 *     <div class="agent-profile__info">
 *       <div class="name"><a href="/inmobiliarios/{slug}">{NAME}</a></div>
 *       <div class="organization">{AGENCY}</div>
 *     </div>
 *     <div class="agent-profile__bio">
 *       <i class="fal fa-location-dot"></i>{City, State}
 *       <i class="fal fa-calendar"></i>Miembro desde {YEAR}
 *     </div>
 *   </div>
 *
 * We split the HTML on the card boundary and pull each field from its
 * stable selector. Anchors and the `<img alt>` give us name + slug.
 */
async function fetchPincaliPage(page: number): Promise<PincaliRow[]> {
  const url = `${PINCALI_BASE}?page=${page}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.7",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Upgrade-Insecure-Requests": "1",
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(
      `[re-franchises-mx] pincali page=${page} network: ${(error as Error).message}`,
    );
    return [];
  }
  if (!response.ok) {
    console.error(`[re-franchises-mx] pincali page=${page} status=${response.status}`);
    return [];
  }
  const html = await response.text();

  const rows: PincaliRow[] = [];
  const seenSlug = new Set<string>();

  // Split on card boundary. First chunk is the page chrome before the
  // first card — discard it. Remaining chunks each start at the
  // contents of an `<div class="agent-profile">` element.
  const chunks = html.split(/<div\s+class="agent-profile"[^>]*>/i);
  for (let i = 1; i < chunks.length; i++) {
    const card = chunks[i];

    // Slug: first /inmobiliarios/{slug} href in this card.
    const slugMatch = card.match(/\/inmobiliarios\/([a-z0-9_\-]+)/i);
    if (!slugMatch) continue;
    const slug = slugMatch[1].trim();
    if (!slug || slug === "page" || seenSlug.has(slug)) continue;

    // Name: prefer `<div class="name"><a>NAME</a></div>`, fallback to
    // the avatar `<img alt="NAME">`.
    let name = "";
    const nameDiv = card.match(
      /<div\s+class="name"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (nameDiv) name = stripTags(nameDiv[1]);
    if (!name) {
      const altMatch = card.match(/<img[^>]+alt="([^"]+)"/i);
      if (altMatch) name = decodeEntities(altMatch[1]).trim();
    }
    if (!name || name.length < 2) continue;

    // Agency: <div class="organization">AGENCY</div>
    let agency: string | undefined;
    const orgMatch = card.match(
      /<div\s+class="organization"[^>]*>([\s\S]*?)<\/div>/i,
    );
    if (orgMatch) {
      const orgText = stripTags(orgMatch[1]);
      if (orgText) agency = orgText;
    }

    // Location: text immediately after `<i class="...fa-location-dot..."></i>`
    // up to the next `<i ` tag or closing `</div>`.
    let locationRaw: string | undefined;
    const locMatch = card.match(
      /<i[^>]*fa-location-dot[^>]*><\/i>([\s\S]*?)(?:<i\s|<\/div>)/i,
    );
    if (locMatch) {
      const loc = stripTags(locMatch[1]);
      if (loc) locationRaw = loc;
    }

    seenSlug.add(slug);
    rows.push({ name, slug, agency, locationRaw });
  }
  return rows;
}

async function fetchPincaliAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const cities = await getCities({ country: "MX" });
  const validSlugs = new Set(cities.map((c) => c.slug));
  let page = 1;
  let consecutiveEmpty = 0;
  // Pincali claims 535 pages × ~24 rows ≈ 12.8k. Hard ceiling at 600.
  const maxPages = 600;
  while (out.length < limit && page <= maxPages && consecutiveEmpty < 3) {
    const rows = await fetchPincaliPage(page);
    if (rows.length === 0) {
      consecutiveEmpty += 1;
      page += 1;
      await sleep(POLITE_DELAY_MS);
      continue;
    }
    consecutiveEmpty = 0;
    for (const row of rows) {
      if (out.length >= limit) break;
      const citySlug = pincaliLocationToCitySlug(row.locationRaw, validSlugs);
      if (!citySlug) continue;
      const franchise = detectFranchise(row.agency);
      out.push(
        normalise({
          source: SOURCE_NAME,
          sourceId: `pincali:${row.slug}`,
          name: row.name,
          categoryKey: CATEGORY,
          citySlug,
          website: `https://www.pincali.com/inmobiliarios/${row.slug}`,
          metadata: {
            country: "MX",
            franchise,
            authority: FRANCHISE_AUTHORITY[franchise],
            agency_name: row.agency,
            location_raw: row.locationRaw,
            platform: "pincali",
          },
        }),
      );
    }
    if (page % 25 === 0) {
      console.log(
        `[re-franchises-mx] pincali progress page=${page} kept=${out.length}`,
      );
    }
    page += 1;
    await sleep(POLITE_DELAY_MS);
  }
  console.log(`[re-franchises-mx] pincali done pages=${page - 1} kept=${out.length}`);
  return out;
}

// ---------- Stubs for direct franchise sites --------------------------
// All three return [] today; documented above. They keep the public
// fan-out shape so a future Playwright pass slots in without changing
// the orchestration.

async function fetchCentury21(): Promise<ScrapedProfessional[]> {
  console.log("[re-franchises-mx] century21 sub-fetcher is a stub (SPA, needs Playwright)");
  return [];
}

async function fetchRemaxMx(): Promise<ScrapedProfessional[]> {
  console.log("[re-franchises-mx] remax sub-fetcher is a stub (no flat directory)");
  return [];
}

async function fetchColdwellBankerMx(): Promise<ScrapedProfessional[]> {
  console.log("[re-franchises-mx] coldwell-banker sub-fetcher is a stub (403 on bot UA)");
  return [];
}

// ---------- Public API -------------------------------------------------

export const reFranchisesMxEnabled = (): boolean =>
  process.env.PROLIO_RUN_RE_FRANCHISES_MX === "true";

export const reFranchisesMxSource: ScraperSource = {
  name: SOURCE_NAME,
  enabled: reFranchisesMxEnabled,
  async fetch() {
    return [];
  },
};

export async function runReFranchisesMx(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!reFranchisesMxEnabled())
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  return withScrapeRun("re-franchises-mx", async () => {
    const rawLimit = Number(
      process.env.PROLIO_RE_FRANCHISES_MX_LIMIT ?? DEFAULT_LIMIT,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

    // Fan out — Pincali is the only live fetcher today; the others are
    // stubs returning []. Running in parallel keeps the slot open for a
    // future Playwright pass without restructuring.
    const [pincali, c21, remax, coldwell] = await Promise.all([
      fetchPincaliAll(limit),
      fetchCentury21(),
      fetchRemaxMx(),
      fetchColdwellBankerMx(),
    ]);
    const all: ScrapedProfessional[] = [
      ...pincali,
      ...c21,
      ...remax,
      ...coldwell,
    ].slice(0, limit);

    // Dedup by sourceId in case Pincali repeats a slug across pages.
    const byId = new Map<string, ScrapedProfessional>();
    for (const r of all) byId.set(r.sourceId, r);
    const records = [...byId.values()];

    // Per-franchise tally for the manifest in logs.
    const tally: Record<FranchiseKey, number> = {
      century21: 0,
      remax: 0,
      "coldwell-banker": 0,
      "keller-williams": 0,
      independent: 0,
    };
    for (const r of records) {
      const f = (r.metadata?.franchise as FranchiseKey) ?? "independent";
      tally[f] = (tally[f] ?? 0) + 1;
    }
    console.log(
      `[re-franchises-mx] manifest: ${JSON.stringify(tally)} total=${records.length}`,
    );

    if (records.length === 0)
      return { rowsFetched: 0, rowsUpserted: 0, rowsSkipped: 0 };
    const sink = getSink();
    const { inserted, updated, skipped } = await sink.upsert(records);
    return {
      rowsFetched: records.length,
      rowsUpserted: inserted + updated,
      rowsSkipped: skipped,
      metadata: { franchise_tally: tally },
    };
  }).then((r) => ({
    fetched: r?.rowsFetched ?? 0,
    inserted: 0,
    updated: 0,
    skipped: r?.rowsSkipped ?? 0,
  }));
}
