import type { ScrapedProfessional, ScraperSource } from "../types.js";
import { normalise } from "../normalise.js";
import { getSink } from "../sink.js";
import { delay, toTitleCase } from "./_bulk-utils.js";

/**
 * OAA — Ontario Association of Architects.
 *
 * Pre-flight (2026-05-07):
 *   • Origin sits behind Sucuri WAF (`Sucuri/Cloudproxy`). Initial
 *     request returns HTTP 307 with a JS challenge — the body contains
 *     a base64-encoded snippet that decodes to:
 *       `<varname> = "<hex32>"; document.cookie = '<name>=' + <varname>;`
 *     Re-issuing the request with that cookie satisfies Sucuri (Sucuri
 *     does not gate on User-Agent or anti-bot fingerprinting beyond
 *     cookie presence). One cookie per origin/path is enough; we re-solve
 *     if a 307 ever resurfaces mid-run.
 *   • The architects directory at `/oaa-directory/search-architects`
 *     paginates via `?page=N` (10 results / page, 878 pages total ≈ 8.7k
 *     architects). Listing cards expose name + Type + Status only — no
 *     city, email, phone, firm. Detail pages add nothing useful (Name,
 *     Type, Status, Discipline History). We therefore ingest as a
 *     province-wide license-registry signal anchored on `toronto` (OAA
 *     HQ city, used as the representative seed slug — backfill via Google
 *     Places later).
 *   • The practices directory exposes addresses, but its pagination is
 *     ASP.NET WebForms __doPostBack with ViewState; out of scope for a
 *     plain-fetch scraper. Sibling PR can add a Telerik-aware adapter.
 *
 * Off by default; `PROLIO_RUN_OAA=true` to enable.
 */

const BASE = process.env.PROLIO_OAA_BASE || "https://oaa.on.ca";
const PATH =
  process.env.PROLIO_OAA_PATH || "/oaa-directory/search-architects";
const USER_AGENT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const REQUEST_DELAY_MS = 1500;
const DEFAULT_LIMIT = 1500;
const MAX_PAGES = 1000;
// Architects page count seen 2026-05-07 was 878. We cap at 1000 so a
// modest growth doesn't truncate us; the per-run row LIMIT is the real
// guard.

interface SucuriCookie {
  name: string;
  value: string;
}

/**
 * Solve the Sucuri JS challenge embedded in a 307 redirect body. The
 * challenge is stable: a base64 string in `var ... S='...'` that
 * evaluates to JS of the form
 *   `<lhs>="<hex>";document.cookie='<name>=' + <lhs> + ';path=/...';`
 * We run that snippet in a Function sandbox capturing
 * `document.cookie`, then split into name/value.
 *
 * Returns null if the page is not a Sucuri challenge (i.e. real HTML
 * already flowed through). Throws if the snippet is malformed in an
 * unexpected way — which would indicate Sucuri changed their format
 * and the scraper needs an update.
 */
function solveSucuriChallenge(html: string): SucuriCookie | null {
  if (!html.includes("sucuri_cloudproxy")) return null;
  const m = html.match(/S='([A-Za-z0-9+/=]+)'/);
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  if (!decoded.includes("document.cookie")) return null;
  const cookieJar: { cookie: string } = { cookie: "" };
  const fakeLocation = { reload: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("document", "location", decoded);
  fn(cookieJar, fakeLocation);
  const first = cookieJar.cookie.split(";")[0]?.trim();
  if (!first) throw new Error("Sucuri challenge produced no cookie");
  const eq = first.indexOf("=");
  if (eq <= 0) throw new Error(`Sucuri cookie malformed: ${first}`);
  return { name: first.slice(0, eq), value: first.slice(eq + 1) };
}

let cachedCookie: SucuriCookie | null = null;

async function fetchHtml(url: string, retried = false): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "en-CA,en;q=0.9",
  };
  if (cachedCookie) {
    headers.Cookie = `${cachedCookie.name}=${cachedCookie.value}`;
  }
  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    throw new Error(`OAA ${url} → ${response.status}`);
  }
  const body = await response.text();
  // Sucuri returns 200 with the JS challenge after the redirect chain
  // when no cookie is present — detect by content, not status.
  const challenge = solveSucuriChallenge(body);
  if (challenge) {
    if (retried) {
      throw new Error("OAA still serving Sucuri challenge after retry");
    }
    cachedCookie = challenge;
    console.log(
      `[oaa] solved Sucuri challenge → cookie ${challenge.name} cached`,
    );
    return fetchHtml(url, true);
  }
  return body;
}

interface ArchitectRow {
  slug: string;
  /** "Last, First Middle" as shown on the listing card. */
  rawName: string;
  type: string;
  status: string;
}

/**
 * Parse the architects listing page. Each card matches:
 *   <h4><a href="/oaa-directory/search-architects/search-architects-detail/<slug>">
 *     <Last>, <First …></a></h4>
 *   <a href='…?Type=<type>'>TYPE LABEL</a> | <a href='…?Status=<…>'>STATUS LABEL</a>
 *
 * The Type / Status labels are uppercase plain text inside an anchor;
 * we capture them positionally relative to each card's anchor.
 */
const CARD_RE =
  /<a href="\/oaa-directory\/search-architects\/search-architects-detail\/([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]{0,800}?Type=[^>]+>([^<]+)<\/a>[\s\S]{0,400}?Status=[^>]+>([^<]+)<\/a>/g;

function parseListing(html: string): ArchitectRow[] {
  const rows: ArchitectRow[] = [];
  const seen = new Set<string>();
  CARD_RE.lastIndex = 0;
  for (const m of html.matchAll(CARD_RE)) {
    const [, slug, rawName, type, status] = m;
    if (!slug || !rawName) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    rows.push({
      slug,
      rawName: rawName.replace(/\s+/g, " ").trim(),
      type: type.trim(),
      status: status.trim(),
    });
  }
  return rows;
}

/** "Aaron Jayakar, Charles Lyonel Jayesh" → "Charles Lyonel Jayesh Aaron Jayakar" */
function flipLastFirst(raw: string): string {
  const idx = raw.indexOf(",");
  if (idx < 0) return raw;
  const last = raw.slice(0, idx).trim();
  const first = raw.slice(idx + 1).trim();
  if (!first) return last;
  return `${first} ${last}`;
}

async function fetchAll(limit: number): Promise<ScrapedProfessional[]> {
  const out: ScrapedProfessional[] = [];
  const seenSlugs = new Set<string>();
  let collected = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (collected >= limit) break;
    const url = `${BASE}${PATH}?page=${page}`;
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (error) {
      console.error(
        `[oaa] page ${page} fetch failed: ${(error as Error).message}`,
      );
      break;
    }
    const rows = parseListing(html);
    if (rows.length === 0) {
      console.log(`[oaa] page ${page} empty — stopping`);
      break;
    }
    let added = 0;
    for (const r of rows) {
      if (collected >= limit) break;
      if (seenSlugs.has(r.slug)) continue;
      seenSlugs.add(r.slug);
      const flipped = flipLastFirst(r.rawName);
      out.push(
        normalise({
          source: "oaa",
          sourceId: `oaa:${r.slug}`,
          name: toTitleCase(flipped),
          categoryKey: "arquitecto",
          // No per-architect city is exposed in the registry; OAA HQ
          // sits in Toronto and the vast majority of Ontario architects
          // work there or in the GTA. Backfill via Google Places later.
          citySlug: "toronto",
          metadata: {
            country: "CA",
            province: "ON",
            authority: "OAA",
            verified_by_authority: true,
            member_type: r.type,
            status: r.status,
            profile_url: `${BASE}/oaa-directory/search-architects/search-architects-detail/${r.slug}`,
          },
        }),
      );
      collected += 1;
      added += 1;
    }
    console.log(`[oaa] page ${page} → +${added} (total ${collected})`);
    if (collected >= limit) break;
    await delay(REQUEST_DELAY_MS);
  }
  return out;
}

export const oaaSource: ScraperSource = {
  name: "oaa",
  enabled() {
    return process.env.PROLIO_RUN_OAA === "true";
  },
  async fetch() {
    return [];
  },
};

export async function runOaa(): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}> {
  if (!oaaSource.enabled()) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const rawLimit = Number(process.env.PROLIO_OAA_LIMIT ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  const records = await fetchAll(limit);
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);
  console.log(
    `[oaa] done — fetched=${records.length} inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
  return { fetched: records.length, inserted, updated, skipped };
}
