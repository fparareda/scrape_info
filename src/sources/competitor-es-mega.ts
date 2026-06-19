/**
 * MEGA competitor scraper for three Spanish directories:
 *   - habitissimo.es     (empresas, sitemap-driven)
 *   - cronoshare.com     (p/{slug} profile pages)
 *   - paginasamarillas.es (empresa pages, sitemap-driven)
 *
 * Unlike the per-target sources (google-places, osm, paginas-amarillas
 * legacy search crawler) this one is "category + city first": we hit
 * a handful of known listing URLs per site for the top-5 cities across
 * the 4 blue-collar categories (electricidad, fontaneria, mecanica,
 * carpinteria) and follow outbound profile links.
 *
 * Politeness:
 *   - Per-host serial queue + 250ms throttle.
 *   - Bot UA first, Chrome UA fallback on 403.
 *   - robots.txt parsed once per host.
 *   - 8s timeout, 1500 page budget.
 *
 * Runs ONLY when PROLIO_RUN_COMPETITOR_ES_MEGA=true. Does not
 * participate in the per-target fan-out; call runCompetitorEsMega()
 * from the orchestrator when enabled.
 */

import type { CategoryKey } from "../prolio-types.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import type { ScrapedProfessional } from "../types.js";
import { normalise } from "../normalise.js";
import { SPANISH_CITIES } from "../cities.js";
import { getSink } from "../sink.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type CompetitorSource = "habitissimo" | "cronoshare" | "paginasamarillas";

interface ParsedProfile {
  source: CompetitorSource;
  /** Stable slug from URL. */
  sourceId: string;
  name: string;
  categoryKey: CategoryKey;
  citySlug: string;
  phone?: string;
  website?: string;
  address?: string;
  rating?: number;
  reviewCount?: number;
  email?: string;
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const TOP_CITIES: Array<{ slug: string; name: string }> = [
  { slug: "madrid", name: "madrid" },
  { slug: "barcelona", name: "barcelona" },
  { slug: "valencia", name: "valencia" },
  { slug: "zaragoza", name: "zaragoza" },
  { slug: "sevilla", name: "sevilla" },
];

const CATEGORIES: CategoryKey[] = [
  "electricidad",
  "fontaneria",
  "mecanica",
  "carpinteria",
];

const HABITISSIMO_CATEGORY_SLUG: Record<CategoryKey, string | undefined> = {
  electricidad: "electricistas",
  fontaneria: "fontaneros",
  mecanica: "mecanicos",
  carpinteria: "carpinteros",
  fiscal: undefined,
  extranjeria: undefined,
  psicologia: undefined,
  medicina: undefined,
  itv: undefined,
  dentista: undefined,
  fisioterapia: undefined,
  veterinario: undefined,
  notario: undefined,
  arquitecto: undefined,
  cerrajero: "cerrajeros",
  hvac: "aire-acondicionado",
  ingenieria: undefined,
  enfermeria: undefined,
  farmacia: undefined,
  abogado: undefined,
  empresa: undefined,
};

const CRONOSHARE_CATEGORY_SLUG: Record<CategoryKey, string | undefined> = {
  electricidad: "electricistas",
  fontaneria: "fontaneros",
  mecanica: "mecanicos",
  carpinteria: "carpinteros",
  fiscal: undefined,
  extranjeria: undefined,
  psicologia: undefined,
  medicina: undefined,
  itv: undefined,
  dentista: undefined,
  fisioterapia: undefined,
  veterinario: undefined,
  notario: undefined,
  arquitecto: undefined,
  cerrajero: "cerrajeros",
  hvac: "aire-acondicionado",
  ingenieria: undefined,
  enfermeria: undefined,
  farmacia: undefined,
  abogado: undefined,
  empresa: undefined,
};

const PAGINAS_CATEGORY_SLUG: Record<CategoryKey, string | undefined> = {
  electricidad: "electricistas",
  fontaneria: "fontaneros",
  mecanica: "talleres-de-automoviles",
  carpinteria: "carpinteros",
  fiscal: undefined,
  extranjeria: undefined,
  psicologia: undefined,
  medicina: undefined,
  itv: undefined,
  dentista: undefined,
  fisioterapia: undefined,
  veterinario: undefined,
  notario: undefined,
  arquitecto: undefined,
  cerrajero: "cerrajeros",
  hvac: "aire-acondicionado",
  ingenieria: undefined,
  enfermeria: undefined,
  farmacia: undefined,
  abogado: undefined,
  empresa: undefined,
};

const DEFAULT_LIMIT = 1500;
const TIMEOUT_MS = 8_000;
const THROTTLE_MS = 250;

const UA_BOT =
  "Prolio-Bot/1.0 (+https://prolio-web.vercel.app; contact: ferranp.work@gmail.com)";
const UA_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// -----------------------------------------------------------------------------
// City + category mapping
// -----------------------------------------------------------------------------

/** Normalised (accents stripped, lowercased) city name → canonical slug. */
const CITY_NAME_TO_SLUG = (() => {
  const m = new Map<string, string>();
  for (const c of SPANISH_CITIES) {
    m.set(normaliseCityKey(c.name), c.slug);
    m.set(c.slug, c.slug);
  }
  return m;
})();

function normaliseCityKey(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function resolveCitySlug(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const key = normaliseCityKey(raw);
  const direct = CITY_NAME_TO_SLUG.get(key);
  if (direct) return direct;
  // Try stripping common prefixes like "l-", "la-", "el-".
  const stripped = key.replace(/^(l-|la-|el-|les-|els-)/, "");
  return CITY_NAME_TO_SLUG.get(stripped);
}

function categoryFromText(text: string): CategoryKey | undefined {
  const t = text.toLowerCase();
  if (/electric/.test(t)) return "electricidad";
  if (/fontaner|plomer/.test(t)) return "fontaneria";
  if (/carpinter/.test(t)) return "carpinteria";
  if (
    /mecanic|taller|automovil|autom[oó]vil|autom[oó]viles|reparacion.*coche/.test(
      t,
    )
  ) {
    return "mecanica";
  }
  if (/instalaciones.electric/.test(t)) return "electricidad";
  return undefined;
}

// -----------------------------------------------------------------------------
// Per-host queue + fetcher
// -----------------------------------------------------------------------------

interface HostState {
  lastFetchAt: number;
  robotsDisallow: string[];
  /** If true, always use the Chrome UA. */
  useChromeUa: boolean;
  queue: Promise<unknown>;
}

const hostStates = new Map<string, HostState>();

function getHostState(host: string): HostState {
  let state = hostStates.get(host);
  if (!state) {
    state = {
      lastFetchAt: 0,
      robotsDisallow: [],
      useChromeUa: false,
      queue: Promise.resolve(),
    };
    hostStates.set(host, state);
  }
  return state;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(
  url: string,
  ua: string,
  accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
): Promise<{ status: number; body: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": ua,
        Accept: accept,
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    const text = res.ok ? await res.text() : null;
    return { status: res.status, body: text };
  } catch (error) {
    const msg = (error as Error).message;
    console.warn(`[competitor-es-mega] fetch error ${url}: ${msg}`);
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serialised per-host fetch. Respects robots Disallow and throttle.
 * Returns the HTML body, or null on any failure / disallow.
 */
async function politeFetch(url: string): Promise<string | null> {
  const parsed = new URL(url);
  const host = parsed.host;
  const state = getHostState(host);

  // Chain onto the host's queue so concurrency per host is 1.
  const run = async (): Promise<string | null> => {
    // Ensure robots loaded.
    if (state.robotsDisallow.length === 0 && !("__robots_done" in state)) {
      await loadRobots(host);
    }
    // Check disallow.
    const pathname = parsed.pathname;
    for (const rule of state.robotsDisallow) {
      if (rule === "/" || pathname.startsWith(rule)) {
        // Disallowed — skip silently.
        return null;
      }
    }
    // Throttle.
    const since = Date.now() - state.lastFetchAt;
    if (since < THROTTLE_MS) {
      await sleep(THROTTLE_MS - since);
    }
    state.lastFetchAt = Date.now();

    const ua = state.useChromeUa ? UA_CHROME : UA_BOT;
    let { status, body } = await fetchWithTimeout(url, ua);
    if (status === 403 && !state.useChromeUa) {
      // Flip to Chrome UA for this host and retry once.
      state.useChromeUa = true;
      state.lastFetchAt = Date.now();
      ({ status, body } = await fetchWithTimeout(url, UA_CHROME));
    }
    if (status >= 400 || !body) return null;
    return body;
  };

  const result = state.queue.then(run, run);
  state.queue = result.catch(() => undefined);
  return result;
}

async function loadRobots(host: string): Promise<void> {
  const state = getHostState(host);
  // Mark as done even on error so we don't re-fetch.
  Object.assign(state, { __robots_done: true });
  const url = `https://${host}/robots.txt`;
  const { body } = await fetchWithTimeout(url, UA_BOT, "text/plain");
  if (!body) return;
  const lines = body.split("\n");
  let inStar = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) {
      inStar = ua[1].trim() === "*";
      continue;
    }
    if (!inStar) continue;
    const dis = line.match(/^disallow:\s*(.+)$/i);
    if (dis) {
      const path = dis[1].trim();
      if (path) state.robotsDisallow.push(path);
    }
  }
}

// -----------------------------------------------------------------------------
// HTML helpers
// -----------------------------------------------------------------------------

function stripTags(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(re: RegExp, input: string): string | undefined {
  const m = input.match(re);
  return m ? m[1] : undefined;
}

function extractPhone(html: string): string | undefined {
  const teleMatch =
    firstMatch(/href=['"]tel:\+?([\d\s\-()]{6,20})['"]/i, html) ??
    firstMatch(/\b((?:\+34\s?)?[6789]\d{2}[\s\-.]?\d{3}[\s\-.]?\d{3})\b/, html);
  if (!teleMatch) return undefined;
  return teleMatch.replace(/[\s\-.()]/g, "");
}

function extractEmail(html: string): string | undefined {
  const mailto = firstMatch(/href=['"]mailto:([^'"?]+)['"]/i, html);
  if (mailto) return mailto.toLowerCase().trim();
  // Plain email regex.
  const plain = firstMatch(
    /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i,
    stripTags(html),
  );
  return plain?.toLowerCase();
}

function extractWebsite(html: string): string | undefined {
  // Look for external links that aren't the current host / social.
  const rx =
    /href=['"](https?:\/\/(?!(?:www\.)?(?:habitissimo|cronoshare|paginasamarillas|facebook|twitter|instagram|linkedin|youtube|google|maps)\.[a-z.]+)[^'"]+)['"]/gi;
  const m = rx.exec(html);
  return m?.[1];
}

function extractRatingAndCount(
  html: string,
): { rating?: number; reviewCount?: number } {
  const rating = firstMatch(
    /"ratingValue"\s*:\s*"?(\d+(?:\.\d+)?)"?/i,
    html,
  );
  const count = firstMatch(/"reviewCount"\s*:\s*"?(\d+)"?/i, html);
  return {
    rating: rating ? Number(rating) : undefined,
    reviewCount: count ? Number(count) : undefined,
  };
}

// -----------------------------------------------------------------------------
// Per-site parsers
// -----------------------------------------------------------------------------

function parseHabitissimo(
  url: string,
  html: string,
  categoryHint: CategoryKey | undefined,
): ParsedProfile | undefined {
  const slug = url.match(/\/empresas\/([^/?#]+)/)?.[1];
  if (!slug) return undefined;
  const title = firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html);
  const name = title ? stripTags(title) : undefined;
  if (!name) return undefined;

  // Habitissimo exposes city in breadcrumbs / address.
  const addr =
    firstMatch(
      /"streetAddress"\s*:\s*"([^"]+)"/i,
      html,
    ) ?? firstMatch(
      /<address[^>]*>([\s\S]*?)<\/address>/i,
      html,
    );
  const cityText =
    firstMatch(/"addressLocality"\s*:\s*"([^"]+)"/i, html) ?? addr ?? "";
  const citySlug = resolveCitySlug(cityText);
  if (!citySlug) return undefined;

  const categoryText =
    firstMatch(/"@type"\s*:\s*"LocalBusiness"[\s\S]*?"name"\s*:\s*"([^"]+)"/i, html) ??
    firstMatch(/<nav[^>]*breadcrumb[^>]*>([\s\S]*?)<\/nav>/i, html) ??
    "";
  const categoryKey =
    categoryFromText(categoryText) ?? categoryHint;
  if (!categoryKey) return undefined;

  const { rating, reviewCount } = extractRatingAndCount(html);

  return {
    source: "habitissimo",
    sourceId: slug,
    name,
    categoryKey,
    citySlug,
    phone: extractPhone(html),
    website: extractWebsite(html),
    address: addr ? stripTags(addr) : undefined,
    rating,
    reviewCount,
    email: extractEmail(html),
  };
}

function parseCronoshare(
  url: string,
  html: string,
  categoryHint: CategoryKey | undefined,
): ParsedProfile | undefined {
  const slug = url.match(/\/p\/([^/?#]+)/)?.[1];
  if (!slug) return undefined;
  const title = firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html);
  const name = title ? stripTags(title) : undefined;
  if (!name) return undefined;

  const cityText =
    firstMatch(/"addressLocality"\s*:\s*"([^"]+)"/i, html) ??
    firstMatch(
      /<[^>]*class="[^"]*\b(?:city|localidad|ubicacion)\b[^"]*"[^>]*>([\s\S]*?)</i,
      html,
    ) ??
    "";
  const citySlug = resolveCitySlug(cityText);
  if (!citySlug) return undefined;

  const specialtyText =
    firstMatch(/<h2[^>]*>([\s\S]*?)<\/h2>/i, html) ?? "";
  const categoryKey =
    categoryFromText(specialtyText) ?? categoryHint;
  if (!categoryKey) return undefined;

  const { rating, reviewCount } = extractRatingAndCount(html);

  return {
    source: "cronoshare",
    sourceId: slug,
    name,
    categoryKey,
    citySlug,
    // Spec says skip phone extraction for cronoshare.
    phone: undefined,
    website: extractWebsite(html),
    rating,
    reviewCount,
  };
}

function parsePaginas(
  url: string,
  html: string,
  categoryHint: CategoryKey | undefined,
): ParsedProfile | undefined {
  const slug = url.match(/\/empresa\/([^/?#]+)/)?.[1];
  if (!slug) return undefined;
  const title = firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html);
  const name = title ? stripTags(title) : undefined;
  if (!name) return undefined;

  const addr =
    firstMatch(/"streetAddress"\s*:\s*"([^"]+)"/i, html) ??
    firstMatch(
      /<span[^>]*class="[^"]*\bdir\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
      html,
    );
  const cityText =
    firstMatch(/"addressLocality"\s*:\s*"([^"]+)"/i, html) ?? addr ?? "";
  const citySlug = resolveCitySlug(cityText);
  if (!citySlug) return undefined;

  const categoryText =
    firstMatch(/"name"\s*:\s*"([^"]+?electr[^"]*)"/i, html) ??
    firstMatch(/<nav[^>]*breadcrumb[^>]*>([\s\S]*?)<\/nav>/i, html) ??
    "";
  const categoryKey =
    categoryFromText(categoryText) ?? categoryHint;
  if (!categoryKey) return undefined;

  return {
    source: "paginasamarillas",
    sourceId: slug,
    name,
    categoryKey,
    citySlug,
    phone: extractPhone(html),
    address: addr ? stripTags(addr) : undefined,
    website: extractWebsite(html),
  };
}

// -----------------------------------------------------------------------------
// Per-site listing URL extractors
// -----------------------------------------------------------------------------

/**
 * Extract profile URLs from a listing page HTML via `href` regex. We
 * de-dupe and return only URLs matching the profile pattern for the site.
 */
function extractHabitissimoProfileUrls(html: string): string[] {
  const urls = new Set<string>();
  const rx = /href=['"](https?:\/\/[^'"]*habitissimo\.es\/empresas\/[^'"?#]+)['"]/gi;
  let m;
  while ((m = rx.exec(html)) !== null) urls.add(m[1]);
  // Also relative.
  const rxRel = /href=['"](\/empresas\/[^'"?#]+)['"]/gi;
  while ((m = rxRel.exec(html)) !== null) {
    urls.add(`https://www.habitissimo.es${m[1]}`);
  }
  return [...urls].filter((u) => !u.endsWith("/empresas/"));
}

function extractCronoshareProfileUrls(html: string): string[] {
  const urls = new Set<string>();
  const rx = /href=['"](https?:\/\/[^'"]*cronoshare\.com\/p\/[^'"?#]+)['"]/gi;
  let m;
  while ((m = rx.exec(html)) !== null) urls.add(m[1]);
  const rxRel = /href=['"](\/p\/[^'"?#]+)['"]/gi;
  while ((m = rxRel.exec(html)) !== null) {
    urls.add(`https://www.cronoshare.com${m[1]}`);
  }
  return [...urls];
}

function extractPaginasProfileUrls(html: string): string[] {
  const urls = new Set<string>();
  const rx = /href=['"](https?:\/\/[^'"]*paginasamarillas\.es\/empresa\/[^'"?#]+\.html)['"]/gi;
  let m;
  while ((m = rx.exec(html)) !== null) urls.add(m[1]);
  const rxRel = /href=['"](\/empresa\/[^'"?#]+\.html)['"]/gi;
  while ((m = rxRel.exec(html)) !== null) {
    urls.add(`https://www.paginasamarillas.es${m[1]}`);
  }
  return [...urls];
}

// -----------------------------------------------------------------------------
// Per-site discovery
// -----------------------------------------------------------------------------

interface DiscoveredProfile {
  url: string;
  source: CompetitorSource;
  /** Pre-resolved from URL structure when possible. */
  categoryHint?: CategoryKey;
}

/**
 * Build a priority-ordered list of listing URLs, for all 3 sites × 4
 * categories × top 5 cities. Within a site, electricidad runs first
 * (highest intent), then fontanería, mecánica, carpintería.
 */
function listingUrls(): Array<{
  url: string;
  source: CompetitorSource;
  categoryHint: CategoryKey;
}> {
  const out: Array<{
    url: string;
    source: CompetitorSource;
    categoryHint: CategoryKey;
  }> = [];
  for (const cat of CATEGORIES) {
    for (const city of TOP_CITIES) {
      const h = HABITISSIMO_CATEGORY_SLUG[cat];
      if (h) {
        out.push({
          url: `https://www.habitissimo.es/${h}/${city.name}`,
          source: "habitissimo",
          categoryHint: cat,
        });
      }
      const cs = CRONOSHARE_CATEGORY_SLUG[cat];
      if (cs) {
        out.push({
          url: `https://www.cronoshare.com/${cs}/${city.name}`,
          source: "cronoshare",
          categoryHint: cat,
        });
      }
      const pa = PAGINAS_CATEGORY_SLUG[cat];
      if (pa) {
        out.push({
          url: `https://www.paginasamarillas.es/servicios/${pa}/${city.name}.html`,
          source: "paginasamarillas",
          categoryHint: cat,
        });
      }
    }
  }
  return out;
}

async function discoverProfilesFromListing(entry: {
  url: string;
  source: CompetitorSource;
  categoryHint: CategoryKey;
}): Promise<DiscoveredProfile[]> {
  const html = await politeFetch(entry.url);
  if (!html) return [];
  let urls: string[] = [];
  if (entry.source === "habitissimo") {
    urls = extractHabitissimoProfileUrls(html);
  } else if (entry.source === "cronoshare") {
    urls = extractCronoshareProfileUrls(html);
  } else {
    urls = extractPaginasProfileUrls(html);
  }
  return urls.map((url) => ({
    url,
    source: entry.source,
    categoryHint: entry.categoryHint,
  }));
}

// -----------------------------------------------------------------------------
// Orchestration
// -----------------------------------------------------------------------------

export interface CompetitorEsMegaResult {
  fetched: number;
  parsed: number;
  inserted: number;
  updated: number;
  skipped: number;
  emails: number;
}

async function upsertEmails(
  client: SupabaseClient,
  emailsByCompetitorKey: Map<string, string>,
): Promise<number> {
  if (emailsByCompetitorKey.size === 0) return 0;
  // Look up professional_id by (source, source_id). Chunk to stay under
  // URL length limits.
  const keys = [...emailsByCompetitorKey.keys()];
  const bySource = new Map<CompetitorSource, string[]>();
  for (const key of keys) {
    const [source, id] = key.split("::") as [CompetitorSource, string];
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source)!.push(id);
  }
  const rows: Array<{
    professional_id: string;
    email: string;
    source: string;
    confidence: number;
    discovered_at_url: string | null;
    verified_at: string;
  }> = [];
  const now = new Date().toISOString();
  for (const [source, ids] of bySource) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const { data, error } = await client
        .from("professionals")
        .select("id, source_id")
        .eq("source", source)
        .in("source_id", chunk);
      if (error || !data) continue;
      for (const row of data) {
        const key = `${source}::${row.source_id}`;
        const email = emailsByCompetitorKey.get(key);
        if (!email) continue;
        rows.push({
          professional_id: row.id as string,
          email,
          source: "manual",
          confidence: 0.8,
          discovered_at_url: null,
          verified_at: now,
        });
      }
    }
  }
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error, data } = await (client.from("professional_emails") as any)
      .upsert(chunk, {
        onConflict: "professional_id,email",
        ignoreDuplicates: false,
      })
      .select("id");
    if (error) {
      console.warn(`[competitor-es-mega] emails upsert: ${error.message}`);
      continue;
    }
    inserted += data?.length ?? 0;
  }
  return inserted;
}

export async function runCompetitorEsMega(): Promise<CompetitorEsMegaResult> {
  const limit = Number(
    process.env.PROLIO_COMPETITOR_ES_MEGA_LIMIT ?? String(DEFAULT_LIMIT),
  );
  console.log(
    `[competitor-es-mega] starting — budget=${limit} pages, ` +
      `categories=${CATEGORIES.join(",")}, cities=${TOP_CITIES.map((c) => c.slug).join(",")}`,
  );

  // Phase 1: discovery. Walk listing pages in priority order.
  const listings = listingUrls();
  const discovered: DiscoveredProfile[] = [];
  const seenUrls = new Set<string>();
  let fetched = 0;
  for (const entry of listings) {
    if (fetched >= limit) break;
    fetched += 1;
    const profiles = await discoverProfilesFromListing(entry);
    for (const p of profiles) {
      if (seenUrls.has(p.url)) continue;
      seenUrls.add(p.url);
      discovered.push(p);
    }
  }
  console.log(
    `[competitor-es-mega] discovered ${discovered.length} profile URLs ` +
      `from ${fetched} listing pages`,
  );

  // Phase 2: fetch + parse profile pages up to budget.
  const records: ScrapedProfessional[] = [];
  const emailsByKey = new Map<string, string>();
  let parsed = 0;
  for (const d of discovered) {
    if (fetched >= limit) break;
    fetched += 1;
    const html = await politeFetch(d.url);
    if (!html) continue;
    let profile: ParsedProfile | undefined;
    if (d.source === "habitissimo") {
      profile = parseHabitissimo(d.url, html, d.categoryHint);
    } else if (d.source === "cronoshare") {
      profile = parseCronoshare(d.url, html, d.categoryHint);
    } else {
      profile = parsePaginas(d.url, html, d.categoryHint);
    }
    if (!profile) continue;
    parsed += 1;
    if (profile.email) {
      emailsByKey.set(
        `${profile.source}::${profile.sourceId}`,
        profile.email,
      );
    }
    records.push(
      normalise({
        source: profile.source,
        country: "ES",
        sourceId: profile.sourceId,
        name: profile.name,
        categoryKey: profile.categoryKey,
        citySlug: profile.citySlug,
        phone: profile.phone,
        website: profile.website,
        address: profile.address,
        rating: profile.rating,
        reviewCount: profile.reviewCount,
        metadata: { competitor_url: d.url },
      }),
    );
  }
  console.log(
    `[competitor-es-mega] parsed ${parsed} profiles, fetched=${fetched}`,
  );

  // Phase 3: upsert into DB.
  const sink = getSink();
  const { inserted, updated, skipped } = await sink.upsert(records);

  // Phase 4: emails → professional_emails.
  let emails = 0;
  if (emailsByKey.size > 0) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && serviceRoleKey) {
      const client = createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      emails = await upsertEmails(client, emailsByKey);
    }
  }

  console.log(
    `[competitor-es-mega] done — fetched=${fetched} parsed=${parsed} ` +
      `inserted=${inserted} updated=${updated} skipped=${skipped} emails=${emails}`,
  );
  return {
    fetched,
    parsed,
    inserted,
    updated,
    skipped,
    emails,
  };
}

export function competitorEsMegaEnabled(): boolean {
  return process.env.PROLIO_RUN_COMPETITOR_ES_MEGA === "true";
}
